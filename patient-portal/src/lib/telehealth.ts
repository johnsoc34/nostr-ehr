/**
 * src/lib/telehealth.ts
 *
 * Telehealth signaling (Nostr) + WebRTC connection manager
 * for Immutable Health Pediatrics video visits.
 *
 * Works with both EHR (page.tsx) and Patient Portal (portal page.tsx).
 * Uses existing nostr.ts (buildAndSignEvent, getSharedSecret, toHex)
 * and nip44.ts (nip44Encrypt, nip44Decrypt) exports.
 *
 * Architecture:
 *   Signaling: NIP-44 encrypted Nostr events on private relay (kinds 4050-4055)
 *   Media:     WebRTC with DTLS-SRTP (P2P or via coturn TURN relay)
 *   State:     DataChannel for low-latency mute/video sync, Nostr as fallback
 *
 * Notes:
 *   - Kinds 4050-4055 are regular (non-replaceable, non-ephemeral) Nostr events.
 *     Kinds 10000-19999 are replaceable (relay keeps only latest per kind+author).
 *     Kinds 20000-29999 are ephemeral (not stored, not reliably forwarded).
 *     Regular kinds ensure every signaling event is stored and delivered.
 *   - Subscription uses kinds-only filter (no #p/#appt) because nostr-rs-relay 0.9.0
 *     does not index custom tags for filtering.
 *   - Both sides subscribe to all 6 kinds; role-based filtering happens in handlers.
 *   - SDP offers are ~22KB after encryption; relay max_event_bytes must be >= 65536.
 *   - SDP offer is retried at 2s and 5s for reliability.
 *   - Patient waits up to 10s for getUserMedia before processing SDP offer,
 *     ensuring local tracks are added to the peer connection.
 */

import type { NostrEvent } from "./nostr";
import { buildAndSignEvent, getSharedSecret, toHex } from "./nostr";
import { nip44Encrypt, nip44Decrypt } from "./nip44";

// ─── Event Kinds (regular, non-replaceable: 0-9999) ─────────────────────────
export const TELEHEALTH_KINDS = {
  Lobby:        4050,  // join/leave lobby
  SDPOffer:     4051,  // WebRTC SDP offer (provider → patient)
  SDPAnswer:    4052,  // WebRTC SDP answer (patient → provider)
  ICECandidate: 4053,  // ICE candidates (bidirectional)
  CallState:    4054,  // mute/video toggle sync
  CallEnd:      4055,  // call ended (persistent for audit)
} as const;

// ─── ICE Server Config ───────────────────────────────────────────────────────
const TURN_HOST = process.env.NEXT_PUBLIC_TURN_HOST || "turn.immutablehealthpediatrics.com";
const TURN_USER = process.env.NEXT_PUBLIC_TURN_USER || "ihp-telehealth";
const TURN_CRED = process.env.NEXT_PUBLIC_TURN_CRED || "";

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  ...(TURN_CRED ? [
    { urls: `turn:${TURN_HOST}:3478`, username: TURN_USER, credential: TURN_CRED },
    { urls: `turns:${TURN_HOST}:5349`, username: TURN_USER, credential: TURN_CRED },
    { urls: `turn:${TURN_HOST}:3478?transport=tcp`, username: TURN_USER, credential: TURN_CRED },
  ] : []),
];

// ─── Types ───────────────────────────────────────────────────────────────────

export type Role = "provider" | "patient";

export interface CallState {
  audioEnabled: boolean;
  videoEnabled: boolean;
}

export interface LobbyState {
  localJoined:  boolean;
  remoteJoined: boolean;
}

export type ConnectionStatus =
  | "lobby"         // waiting in lobby
  | "signaling"     // exchanging SDP/ICE
  | "connecting"    // ICE connecting
  | "connected"     // media flowing
  | "reconnecting"  // ICE restart in progress
  | "disconnected"  // call ended or failed
  | "failed";       // unrecoverable

export interface TelehealthCallbacks {
  onRemoteStream:       (stream: MediaStream) => void;
  onConnectionStatus:   (status: ConnectionStatus) => void;
  onRemoteCallState:    (state: CallState) => void;
  onLobbyState:         (state: LobbyState) => void;
  onError:              (error: string) => void;
  onCallDuration?:      (seconds: number) => void;
}

/** Minimal relay interface matching both EHR and Portal useRelay hooks */
export interface RelayHandle {
  status:      string;
  publish:     (event: NostrEvent) => Promise<boolean>;
  subscribe:   (filters: object, onEvent: (ev: NostrEvent) => void, onEose?: () => void) => string;
  unsubscribe: (subId: string) => void;
}

// ─── Telehealth Session ──────────────────────────────────────────────────────

export class TelehealthSession {
  private pc:            RTCPeerConnection | null = null;
  private dataChannel:   RTCDataChannel | null = null;
  private localStream:   MediaStream | null = null;
  private subIds:        string[] = [];
  private callStartTime: number | null = null;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private lobbyState: LobbyState = { localJoined: false, remoteJoined: false };
  private lobbyHeartbeat: ReturnType<typeof setInterval> | null = null;
  private sessionStart = Math.floor(Date.now() / 1000);

  // NIP-44 shared secret (computed once)
  private sharedX: Uint8Array;

  constructor(
    private appointmentId: number | string,
    private role:          Role,
    private sk:            Uint8Array,
    private localPkHex:    string,
    private remotePkHex:   string,
    private relay:         RelayHandle,
    private callbacks:     TelehealthCallbacks,
  ) {
    this.sharedX = getSharedSecret(sk, remotePkHex);
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Get local camera+mic stream and join the lobby */
  async joinLobby(videoEnabled = true, audioEnabled = true): Promise<MediaStream | null> {
    if (this.destroyed) throw new Error("Session destroyed");

    // Warn if relay isn't connected — events won't publish
    if (this.relay.status !== "connected") {
      console.warn(`[Telehealth] joinLobby called but relay status is "${this.relay.status}" — signaling will fail`);
    }

    // Subscribe to signaling FIRST — even if media fails, we need to hear the other party
    this.subscribeToSignaling();

    // Publish lobby join BEFORE getUserMedia — so the other party knows we're here
    const published = await this.publishSignaling(TELEHEALTH_KINDS.Lobby, {
      action: "join",
      role: this.role,
      appointmentId: this.appointmentId,
      timestamp: Date.now(),
    });

    if (!published) {
      console.warn("[Telehealth] Initial lobby publish failed — relay may not be accepting events from this pubkey");
    }

    this.lobbyState.localJoined = true;
    this.callbacks.onLobbyState({ ...this.lobbyState });
    this.callbacks.onConnectionStatus("lobby");

    // Re-publish lobby join every 3s until remote party joins.
    // Regular events are stored, but the heartbeat ensures the other party
    // sees a recent lobby event even if they subscribe after our initial publish.
    this.lobbyHeartbeat = setInterval(() => {
      if (this.destroyed || this.lobbyState.remoteJoined) {
        if (this.lobbyHeartbeat) { clearInterval(this.lobbyHeartbeat); this.lobbyHeartbeat = null; }
        return;
      }
      this.publishSignaling(TELEHEALTH_KINDS.Lobby, {
        action: "join",
        role: this.role,
        appointmentId: this.appointmentId,
        timestamp: Date.now(),
      });
    }, 3000);

    // Now try to get local media (may fail if no camera/mic)
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: videoEnabled ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
        audio: audioEnabled ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
      });
      await this.maybeInitiateWebRTC();
      return this.localStream;
    } catch (e) {
      await this.maybeInitiateWebRTC();
      this.callbacks.onError("Camera/microphone access denied. Please allow access and try again.");
      return null;
    }
  }

  /** Toggle local audio */
  setAudioEnabled(enabled: boolean) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
    this.broadcastCallState();
  }

  /** Toggle local video */
  setVideoEnabled(enabled: boolean) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => { t.enabled = enabled; });
    this.broadcastCallState();
  }

  /** Get current local state */
  getLocalCallState(): CallState {
    return {
      audioEnabled: this.localStream?.getAudioTracks().some(t => t.enabled) ?? false,
      videoEnabled: this.localStream?.getVideoTracks().some(t => t.enabled) ?? false,
    };
  }

  /** End the call and clean up */
  async endCall(reason: "normal" | "timeout" | "error" = "normal") {
    if (this.destroyed) return;

    const duration = this.callStartTime ? Math.floor((Date.now() - this.callStartTime) / 1000) : 0;

    // Publish call end event (persistent, for audit)
    try {
      await this.publishSignaling(TELEHEALTH_KINDS.CallEnd, {
        appointmentId: this.appointmentId,
        duration,
        endedBy: this.role,
        endReason: reason,
      });
    } catch (e) {
      // Best effort — don't block cleanup
    }

    this.destroy();
    this.callbacks.onConnectionStatus("disconnected");
  }

  /** Full cleanup — call this on unmount */
  destroy() {
    this.destroyed = true;

    if (this.lobbyHeartbeat) {
      clearInterval(this.lobbyHeartbeat);
      this.lobbyHeartbeat = null;
    }

    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // Unsubscribe from relay to stop receiving events on dead sessions
    for (const subId of this.subIds) {
      try { this.relay.unsubscribe(subId); } catch {}
    }
    this.subIds = [];
  }

  // ─── Signaling (Nostr) ──────────────────────────────────────────────

  // Reverse lookup for logging
  private static KIND_NAMES: Record<number, string> = Object.fromEntries(
    Object.entries(TELEHEALTH_KINDS).map(([name, kind]) => [kind, name])
  );

  private publishFailCount = 0;

  private async publishSignaling(kind: number, payload: object): Promise<boolean> {
    const plaintext = JSON.stringify(payload);
    const encrypted = await nip44Encrypt(plaintext, this.sharedX);

    const tags: string[][] = [
      ["p", this.remotePkHex],
      ["appt", String(this.appointmentId)],
    ];

    if (kind !== TELEHEALTH_KINDS.CallEnd) {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      tags.push(["expiration", String(expiry)]);
    }

    const event = await buildAndSignEvent(kind, encrypted, tags, this.sk);
    const ok = await this.relay.publish(event);

    if (!ok) {
      const kindName = TelehealthSession.KIND_NAMES[kind] || String(kind);
      console.warn(`[Telehealth] Publish FAILED: kind=${kindName} (${kind}), relay.status=${this.relay.status}, pubkey=${this.localPkHex.slice(0, 8)}...`);
      this.publishFailCount++;
      // Surface error to user after 3 consecutive failures (not just transient blips)
      if (this.publishFailCount >= 3 && kind === TELEHEALTH_KINDS.Lobby) {
        this.callbacks.onError("Unable to connect to relay. Your account may not be authorized — contact your practice.");
      }
    } else {
      this.publishFailCount = 0;
    }

    return ok;
  }

  private subscribeToSignaling() {
    const subId = this.relay.subscribe(
      {
        kinds: [4050, 4051, 4052, 4053, 4054, 4055],
        since: Math.floor(Date.now() / 1000) - 30,
      },
      (ev: NostrEvent) => this.handleSignalingEvent(ev),
    );
    this.subIds.push(subId);
  }

  private async handleSignalingEvent(ev: NostrEvent) {
    if (this.destroyed) return;
    if (ev.pubkey === this.localPkHex) return;
    if (ev.created_at < this.sessionStart - 5) return;

    try {
      const plaintext = await nip44Decrypt(ev.content, this.sharedX);
      const payload = JSON.parse(plaintext);

      // Ignore events for other appointments
      if (payload.appointmentId && String(payload.appointmentId) !== String(this.appointmentId)) return;

      switch (ev.kind) {
        case TELEHEALTH_KINDS.Lobby:
          await this.handleLobbyEvent(payload);
          break;
        case TELEHEALTH_KINDS.SDPOffer:
          await this.handleSDPOffer(payload);
          break;
        case TELEHEALTH_KINDS.SDPAnswer:
          await this.handleSDPAnswer(payload);
          break;
        case TELEHEALTH_KINDS.ICECandidate:
          await this.handleICECandidate(payload);
          break;
        case TELEHEALTH_KINDS.CallState:
          this.handleRemoteCallState(payload);
          break;
        case TELEHEALTH_KINDS.CallEnd:
          this.handleRemoteCallEnd(payload);
          break;
      }
    } catch (e) {
      // Silently ignore events we can't decrypt (e.g. from other appointments)
    }
  }

  // ─── Lobby ──────────────────────────────────────────────────────────

  private async handleLobbyEvent(payload: { action: string; role: string }) {
    if (payload.action === "join") {
      this.lobbyState.remoteJoined = true;
      this.callbacks.onLobbyState({ ...this.lobbyState });
      await this.maybeInitiateWebRTC();
    }
  }

  private async maybeInitiateWebRTC() {
    if (this.lobbyState.localJoined && this.lobbyState.remoteJoined && this.role === "provider") {
      await this.initiateWebRTC();
    }
  }

  // ─── WebRTC Setup ───────────────────────────────────────────────────

  private createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Remote tracks
    pc.ontrack = (ev) => {
      if (ev.streams[0]) {
        this.callbacks.onRemoteStream(ev.streams[0]);
      }
    };

    // ICE candidates → publish via Nostr
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.publishSignaling(TELEHEALTH_KINDS.ICECandidate, {
          candidate:     ev.candidate.candidate,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          sdpMid:        ev.candidate.sdpMid,
        });
      }
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
      if (this.destroyed) return;
      switch (pc.connectionState) {
        case "connecting":
          this.callbacks.onConnectionStatus("connecting");
          break;
        case "connected":
          this.callbacks.onConnectionStatus("connected");
          this.startDurationTimer();
          break;
        case "disconnected":
          this.callbacks.onConnectionStatus("reconnecting");
          setTimeout(() => {
            if (!this.destroyed && pc.connectionState === "disconnected") {
              this.attemptICERestart();
            }
          }, 3000);
          break;
        case "failed":
          this.callbacks.onConnectionStatus("failed");
          this.callbacks.onError("Connection failed. Please try rejoining.");
          break;
        case "closed":
          this.callbacks.onConnectionStatus("disconnected");
          break;
      }
    };

    // ICE connection state (more granular)
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        this.attemptICERestart();
      }
    };

    // Data channel for low-latency state sync
    if (this.role === "provider") {
      const dc = pc.createDataChannel("callState", { ordered: true });
      this.setupDataChannel(dc);
    } else {
      pc.ondatachannel = (ev) => {
        this.setupDataChannel(ev.channel);
      };
    }

    this.pc = pc;
    return pc;
  }

  private setupDataChannel(dc: RTCDataChannel) {
    dc.onopen = () => {
      this.dataChannel = dc;
      this.broadcastCallState();
    };
    dc.onmessage = (ev) => {
      try {
        const state = JSON.parse(ev.data) as CallState;
        this.callbacks.onRemoteCallState(state);
      } catch {}
    };
    dc.onclose = () => {
      this.dataChannel = null;
    };
  }

  private async initiateWebRTC() {
    if (this.destroyed || this.pc) return;
    this.callbacks.onConnectionStatus("signaling");

    const pc = this.createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait briefly for TURN candidates to be included in the offer SDP
    await new Promise(r => setTimeout(r, 500));

    if (this.destroyed) return;

    const offerPayload = {
      type: "offer",
      sdp:  pc.localDescription?.sdp || offer.sdp,
      appointmentId: this.appointmentId,
    };

    // Publish offer, then retry at 2s and 5s in case patient missed it
    await this.publishSignaling(TELEHEALTH_KINDS.SDPOffer, offerPayload);
    setTimeout(() => {
      if (!this.destroyed && !this.remoteDescriptionSet) {
        this.publishSignaling(TELEHEALTH_KINDS.SDPOffer, offerPayload);
      }
    }, 2000);
    setTimeout(() => {
      if (!this.destroyed && !this.remoteDescriptionSet) {
        this.publishSignaling(TELEHEALTH_KINDS.SDPOffer, offerPayload);
      }
    }, 5000);
  }

  private async handleSDPOffer(payload: { sdp: string }) {
    if (this.destroyed) return;
    if (this.role !== "patient") return;
    if (this.remoteDescriptionSet) return;  // Already processing an offer
    this.callbacks.onConnectionStatus("signaling");

    // Wait for getUserMedia to complete before creating PC with tracks
    if (!this.localStream) {
      let waited = 0;
      while (!this.localStream && waited < 10000 && !this.destroyed) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
      }
    }

    if (this.destroyed) return;

    if (!this.pc) this.createPeerConnection();
    const pc = this.pc!;

    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    this.remoteDescriptionSet = true;
    await this.flushICEQueue();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await this.publishSignaling(TELEHEALTH_KINDS.SDPAnswer, {
      type: "answer",
      sdp:  answer.sdp,
      appointmentId: this.appointmentId,
    });
  }

  private async handleSDPAnswer(payload: { sdp: string }) {
    if (this.destroyed || !this.pc) return;
    if (this.role !== "provider") return;
    if (this.remoteDescriptionSet) return;  // Ignore duplicate answers from offer retries

    await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    this.remoteDescriptionSet = true;
    await this.flushICEQueue();
  }

  private async handleICECandidate(payload: { candidate: string; sdpMLineIndex: number | null; sdpMid: string | null }) {
    if (this.destroyed) return;

    const candidate: RTCIceCandidateInit = {
      candidate:     payload.candidate,
      sdpMLineIndex: payload.sdpMLineIndex,
      sdpMid:        payload.sdpMid,
    };

    if (!this.pc || !this.remoteDescriptionSet) {
      this.iceCandidateQueue.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      // Non-fatal — some candidates may be redundant
    }
  }

  private async flushICEQueue() {
    if (!this.pc) return;
    for (const candidate of this.iceCandidateQueue) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (e) {
        // Non-fatal
      }
    }
    this.iceCandidateQueue = [];
  }

  private async attemptICERestart() {
    if (this.destroyed || !this.pc || this.role !== "provider") return;
    this.callbacks.onConnectionStatus("reconnecting");

    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.remoteDescriptionSet = false;

      await this.publishSignaling(TELEHEALTH_KINDS.SDPOffer, {
        type: "offer",
        sdp:  offer.sdp,
        appointmentId: this.appointmentId,
      });
    } catch (e) {
      this.callbacks.onError("Reconnection failed.");
    }
  }

  // ─── Call State Sync ────────────────────────────────────────────────

  private broadcastCallState() {
    const state = this.getLocalCallState();

    if (this.dataChannel?.readyState === "open") {
      this.dataChannel.send(JSON.stringify(state));
    }

    this.publishSignaling(TELEHEALTH_KINDS.CallState, {
      ...state,
      appointmentId: this.appointmentId,
    });
  }

  private handleRemoteCallState(payload: CallState) {
    this.callbacks.onRemoteCallState({
      audioEnabled: payload.audioEnabled,
      videoEnabled: payload.videoEnabled,
    });
  }

  private handleRemoteCallEnd(_payload: { endedBy: string; endReason: string }) {
    // Ignore if we haven't connected yet — likely a stale event from a previous session
    if (!this.pc || this.pc.connectionState !== "connected") return;
    this.destroy();
    this.callbacks.onConnectionStatus("disconnected");
  }

  // ─── Duration Timer ─────────────────────────────────────────────────

  private startDurationTimer() {
    if (this.callStartTime || !this.callbacks.onCallDuration) return;
    this.callStartTime = Date.now();

    this.durationTimer = setInterval(() => {
      if (this.callStartTime && this.callbacks.onCallDuration) {
        const seconds = Math.floor((Date.now() - this.callStartTime) / 1000);
        this.callbacks.onCallDuration(seconds);
      }
    }, 1000);
  }
}

// ─── Utility: format duration ────────────────────────────────────────────────
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
