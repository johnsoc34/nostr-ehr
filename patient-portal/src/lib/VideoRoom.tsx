/**
 * VideoRoom component for Immutable Health Telehealth
 * 
 * Usage in EHR (page.tsx):
 *   <VideoRoom
 *     appointmentId={123}
 *     role="provider"
 *     sk={practiceKeys.sk}
 *     localPkHex={practiceKeys.pkHex}
 *     remotePkHex={patient.pkHex}
 *     relay={relay}
 *     remoteName="John Smith"
 *     onClose={() => setVideoOpen(false)}
 *     theme="dark"
 *   />
 *
 * Usage in Portal (portal-page.tsx):
 *   <VideoRoom
 *     appointmentId={appt.id}
 *     role="patient"
 *     sk={keys.sk}
 *     localPkHex={keys.pkHex}
 *     remotePkHex={practicePk}
 *     relay={relay}
 *     remoteName={practiceName}
 *     onClose={() => setVideoOpen(false)}
 *     T={T}
 *   />
 *
 * IMPORTANT: Define this component at module level, NOT inside another component's render.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  TelehealthSession,
  formatDuration,
  type Role,
  type CallState,
  type ConnectionStatus,
  type LobbyState,
  type RelayHandle,
} from "./telehealth";

// ─── Props ───────────────────────────────────────────────────────────────────

interface VideoRoomProps {
  appointmentId: number | string;
  role:          Role;
  sk:            Uint8Array;
  localPkHex:    string;
  remotePkHex:   string;
  relay:         RelayHandle;
  remoteName:    string;
  onClose:       () => void;
  calendarApi?:  string;
  turnApiKey?:   string;
  // Portal passes T (theme object), EHR uses dark theme by default
  T?: { bg: string; surface: string; surfaceHi: string; border: string; text: string; textMuted: string; accent: string; green: string; red: string; blue: string; amber: string; };
  theme?: "dark" | "light"; // EHR fallback
}

// ─── Default Themes (matches EHR CS + Portal DARK/LIGHT) ─────────────────────

const THEME_DARK = {
  bg: "#0a0d12", surface: "#111620", surfaceHi: "#1a2233", border: "#1e2d44",
  text: "#e8edf5", textMuted: "#6b7fa3", accent: "#f7931a",
  green: "#22c55e", red: "#ef4444", blue: "#3b82f6", amber: "#f59e0b",
};

const THEME_LIGHT = {
  bg: "#f4f6fb", surface: "#ffffff", surfaceHi: "#eef2fa", border: "#d4dae8",
  text: "#0f172a", textMuted: "#64748b", accent: "#f7931a",
  green: "#16a34a", red: "#dc2626", blue: "#2563eb", amber: "#d97706",
};

// ─── SVG Icons (inline, no external deps needed — but Lucide works too) ──────

function MicIcon({ size = 22, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function MicOffIcon({ size = 22, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 0" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function VideoIcon({ size = 22, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  );
}

function VideoOffIcon({ size = 22, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196" />
      <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

function PhoneOffIcon({ size = 22, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="22" y1="2" x2="2" y2="22" />
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function VideoRoom({
  appointmentId, role, sk, localPkHex, remotePkHex,
  relay, remoteName, onClose, calendarApi, turnApiKey,
  T: themeProp, theme = "dark",
}: VideoRoomProps) {
  const C = themeProp || (theme === "light" ? THEME_LIGHT : THEME_DARK);

  // State
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("lobby");
  const [lobbyState, setLobbyState] = useState<LobbyState>({ localJoined: false, remoteJoined: false });
  const [localCallState, setLocalCallState] = useState<CallState>({ audioEnabled: true, videoEnabled: true });
  const [remoteCallState, setRemoteCallState] = useState<CallState>({ audioEnabled: true, videoEnabled: true });
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState(false);
  const [pipCorner, setPipCorner] = useState<"br" | "bl" | "tr" | "tl">("br");
  const [pipDragging, setPipDragging] = useState(false);
  const [pipOffset, setPipOffset] = useState<{ x: number; y: number } | null>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; origX: number; origY: number } | null>(null);

  // Refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<TelehealthSession | null>(null);

  // ─── Initialize session ──────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const session = new TelehealthSession(
      appointmentId, role, sk, localPkHex, remotePkHex, relay,
      {
        onRemoteStream: (stream) => {
          if (cancelled) return;
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = stream;
          }
        },
        onConnectionStatus: (status) => {
          if (cancelled) return;
          setConnectionStatus(status);
          if (status === "disconnected" && sessionRef.current) {
            // Remote ended — auto-close after a beat
            setTimeout(() => { if (!cancelled) onClose(); }, 2000);
          }
        },
        onRemoteCallState: (state) => {
          if (cancelled) return;
          setRemoteCallState(state);
        },
        onLobbyState: (state) => {
          if (cancelled) return;
          setLobbyState(state);
        },
        onError: (err) => {
          if (cancelled) return;
          setError(err);
        },
        onCallDuration: (s) => {
          if (cancelled) return;
          setDuration(s);
        },
      },
      calendarApi || "",
      turnApiKey || "",
    );

    sessionRef.current = session;

    // Join lobby
    session.joinLobby(true, true).then((localStream) => {
      if (cancelled) return;
      if (localStream && localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }
      if (!localStream) {
        setPermissionError(true);
      }
    }).catch((err) => {
      if (cancelled) return;
      console.error("[VideoRoom] Failed to join lobby:", err);
    });

    return () => {
      cancelled = true;
      const thisSession = session;
      setTimeout(() => { thisSession.destroy(); }, 500);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  // ─── Controls ─────────────────────────────────────────────────────────

  const toggleAudio = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const next = !localCallState.audioEnabled;
    s.setAudioEnabled(next);
    setLocalCallState((prev: CallState) => ({ ...prev, audioEnabled: next }));
  }, [localCallState.audioEnabled]);

  const toggleVideo = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const next = !localCallState.videoEnabled;
    s.setVideoEnabled(next);
    setLocalCallState((prev: CallState) => ({ ...prev, videoEnabled: next }));
  }, [localCallState.videoEnabled]);

  const handleEndCall = useCallback(async () => {
    if (sessionRef.current) {
      await sessionRef.current.endCall("normal");
    }
    onClose();
  }, [onClose]);

  // ─── PiP Drag ───────────────────────────────────────────────────────
  const handlePipDragStart = useCallback((clientX: number, clientY: number) => {
    const el = pipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragStartRef.current = { x: clientX, y: clientY, origX: rect.left, origY: rect.top };
    setPipDragging(true);
    setPipOffset({ x: rect.left, y: rect.top });
  }, []);

  const handlePipDragMove = useCallback((clientX: number, clientY: number) => {
    const start = dragStartRef.current;
    if (!start || !pipDragging) return;
    setPipOffset({
      x: start.origX + (clientX - start.x),
      y: start.origY + (clientY - start.y),
    });
  }, [pipDragging]);

  const handlePipDragEnd = useCallback(() => {
    if (!pipDragging || !pipRef.current) {
      setPipDragging(false);
      setPipOffset(null);
      dragStartRef.current = null;
      return;
    }
    const el = pipRef.current;
    const parent = el.parentElement;
    if (!parent) { setPipDragging(false); setPipOffset(null); return; }
    const pr = parent.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const centerX = er.left + er.width / 2;
    const centerY = er.top + er.height / 2;
    const midX = pr.left + pr.width / 2;
    const midY = pr.top + pr.height / 2;
    const isRight = centerX > midX;
    const isBottom = centerY > midY;
    setPipCorner(isBottom ? (isRight ? "br" : "bl") : (isRight ? "tr" : "tl"));
    setPipDragging(false);
    setPipOffset(null);
    dragStartRef.current = null;
  }, [pipDragging]);

  // ─── PiP drag listeners (global to catch moves outside the element) ──
  useEffect(() => {
    if (!pipDragging) return;
    const onMouseMove = (e: MouseEvent) => handlePipDragMove(e.clientX, e.clientY);
    const onMouseUp = () => handlePipDragEnd();
    const onTouchMove = (e: TouchEvent) => { e.preventDefault(); handlePipDragMove(e.touches[0].clientX, e.touches[0].clientY); };
    const onTouchEnd = () => handlePipDragEnd();
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [pipDragging, handlePipDragMove, handlePipDragEnd]);

  // ─── Status helpers ───────────────────────────────────────────────────

  const statusLabel: Record<ConnectionStatus, string> = {
    lobby: lobbyState.remoteJoined ? "Connecting..." : `Waiting for ${remoteName}...`,
    signaling: "Connecting...",
    connecting: "Connecting...",
    connected: formatDuration(duration),
    reconnecting: "Reconnecting...",
    disconnected: "Call Ended",
    failed: "Connection Failed",
  };

  const statusColor: Record<ConnectionStatus, string> = {
    lobby: C.amber,
    signaling: C.amber,
    connecting: C.amber,
    connected: C.green,
    reconnecting: C.amber,
    disconnected: C.textMuted,
    failed: C.red,
  };

  const isConnected = connectionStatus === "connected";
  const isLobby = connectionStatus === "lobby";
  const isEnded = connectionStatus === "disconnected" || connectionStatus === "failed";

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#000",
      display: "flex", flexDirection: "column",
      fontFamily: "'DM Sans', 'IBM Plex Sans', system-ui, sans-serif",
    }}>

      {/* ── Top Bar ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px",
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(8px)",
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
      }}>
        {/* Left: connection info */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: statusColor[connectionStatus],
            boxShadow: `0 0 8px ${statusColor[connectionStatus]}80`,
          }} />
          <span style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>
            {statusLabel[connectionStatus]}
          </span>
        </div>

        {/* Right: remote party state indicators */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Remote mic indicator */}
          {isConnected && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }} title={remoteCallState.audioEnabled ? `${remoteName}'s mic is on` : `${remoteName}'s mic is muted`}>
              <span style={{ fontSize: 10, color: remoteCallState.audioEnabled ? "#9ca3af" : C.red }}>
                {remoteName.split(" ")[0]}
              </span>
              {remoteCallState.audioEnabled
                ? <MicIcon size={14} color="#9ca3af" />
                : <MicOffIcon size={14} color={C.red} />
              }
            </div>
          )}
          {/* Remote camera indicator */}
          {isConnected && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }} title={remoteCallState.videoEnabled ? `${remoteName}'s camera is on` : `${remoteName}'s camera is off`}>
              {remoteCallState.videoEnabled
                ? <VideoIcon size={14} color="#9ca3af" />
                : <VideoOffIcon size={14} color={C.red} />
              }
            </div>
          )}
        </div>
      </div>

      {/* ── Main Video Area ── */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

        {/* Remote video (full screen) */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          style={{
            width: "100%", height: "100%",
            objectFit: "cover",
            display: (isConnected && remoteCallState.videoEnabled) ? "block" : "none",
          }}
        />

        {/* Remote camera off / lobby placeholder */}
        {(!isConnected || !remoteCallState.videoEnabled) && (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            background: C.surface,
          }}>
            {/* Avatar circle */}
            <div style={{
              width: 96, height: 96, borderRadius: "50%",
              background: `${C.accent}20`, border: `2px solid ${C.accent}40`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 36, fontWeight: 800, color: C.accent,
              marginBottom: 16,
            }}>
              {remoteName[0]?.toUpperCase() || "?"}
            </div>

            <div style={{ color: C.text, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
              {remoteName}
            </div>

            {isLobby && !lobbyState.remoteJoined && (
              <div style={{ color: C.textMuted, fontSize: 13 }}>
                {role === "provider" ? "Patient hasn't joined yet..." : "Doctor hasn't joined yet..."}
              </div>
            )}
            {isLobby && lobbyState.remoteJoined && (
              <div style={{ color: C.green, fontSize: 13, fontWeight: 600 }}>
                ● Joined — connecting...
              </div>
            )}
            {isConnected && !remoteCallState.videoEnabled && (
              <div style={{ color: C.textMuted, fontSize: 13 }}>
                Camera is off
              </div>
            )}
            {connectionStatus === "reconnecting" && (
              <div style={{ color: C.amber, fontSize: 13, fontWeight: 600 }}>
                Reconnecting...
              </div>
            )}
            {isEnded && (
              <div style={{ color: C.textMuted, fontSize: 14, marginTop: 8 }}>
                {connectionStatus === "failed" ? "Connection failed" : "Call ended"}
                {duration > 0 && ` · ${formatDuration(duration)}`}
              </div>
            )}
          </div>
        )}

        {/* Local video (PiP, draggable) */}
        <div
          ref={pipRef}
          onMouseDown={(e) => { e.preventDefault(); handlePipDragStart(e.clientX, e.clientY); }}
          onTouchStart={(e) => { const t = e.touches[0]; handlePipDragStart(t.clientX, t.clientY); }}
          style={{
            position: pipDragging && pipOffset ? "fixed" : "absolute",
            ...(pipDragging && pipOffset
              ? { left: pipOffset.x, top: pipOffset.y }
              : pipCorner === "br" ? { bottom: 90, right: 16 }
              : pipCorner === "bl" ? { bottom: 90, left: 16 }
              : pipCorner === "tl" ? { top: 56, left: 16 }
              :                      { top: 56, right: 16 }),
            width: 160, height: 120,
            borderRadius: 12,
            overflow: "hidden",
            border: pipDragging ? `2px solid ${C.accent}` : "2px solid rgba(255,255,255,0.2)",
            boxShadow: pipDragging ? `0 8px 32px rgba(0,0,0,0.7)` : "0 4px 20px rgba(0,0,0,0.5)",
            background: C.surfaceHi,
            cursor: pipDragging ? "grabbing" : "grab",
            transition: pipDragging ? "none" : "top 0.3s ease, bottom 0.3s ease, left 0.3s ease, right 0.3s ease",
            zIndex: pipDragging ? 100 : 5,
            touchAction: "none",
            userSelect: "none",
          }}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: "100%", height: "100%",
              objectFit: "cover",
              display: localCallState.videoEnabled ? "block" : "none",
              transform: "scaleX(-1)",
              pointerEvents: "none",
            }}
          />
          {!localCallState.videoEnabled && (
            <div style={{
              width: "100%", height: "100%",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: C.surfaceHi,
            }}>
              <VideoOffIcon size={28} color={C.textMuted} />
            </div>
          )}
          {!localCallState.audioEnabled && (
            <div style={{
              position: "absolute", top: 6, left: 6,
              background: "rgba(239,68,68,0.85)",
              borderRadius: 6, padding: "2px 5px",
              display: "flex", alignItems: "center",
              pointerEvents: "none",
            }}>
              <MicOffIcon size={12} color="#fff" />
            </div>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div style={{
            position: "absolute", top: 52, left: 16, right: 16,
            background: `${C.red}20`, border: `1px solid ${C.red}60`,
            borderRadius: 10, padding: "10px 16px",
            color: C.red, fontSize: 13, fontWeight: 600,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 16, padding: "0 4px" }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* ── Bottom Control Bar ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 16,
        padding: "16px 20px",
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(8px)",
        position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10,
      }}>
        {/* Mic toggle */}
        <button
          onClick={toggleAudio}
          disabled={permissionError}
          style={{
            width: 52, height: 52,
            borderRadius: "50%",
            border: "none",
            background: localCallState.audioEnabled ? "rgba(255,255,255,0.15)" : C.red,
            cursor: permissionError ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.2s",
            opacity: permissionError ? 0.4 : 1,
          }}
          title={localCallState.audioEnabled ? "Mute microphone" : "Unmute microphone"}
        >
          {localCallState.audioEnabled
            ? <MicIcon size={22} color="#fff" />
            : <MicOffIcon size={22} color="#fff" />
          }
        </button>

        {/* Video toggle */}
        <button
          onClick={toggleVideo}
          disabled={permissionError}
          style={{
            width: 52, height: 52,
            borderRadius: "50%",
            border: "none",
            background: localCallState.videoEnabled ? "rgba(255,255,255,0.15)" : C.red,
            cursor: permissionError ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.2s",
            opacity: permissionError ? 0.4 : 1,
          }}
          title={localCallState.videoEnabled ? "Turn off camera" : "Turn on camera"}
        >
          {localCallState.videoEnabled
            ? <VideoIcon size={22} color="#fff" />
            : <VideoOffIcon size={22} color="#fff" />
          }
        </button>

        {/* End call */}
        <button
          onClick={handleEndCall}
          style={{
            width: 60, height: 52,
            borderRadius: 26,
            border: "none",
            background: C.red,
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.2s",
            boxShadow: `0 2px 12px ${C.red}40`,
          }}
          title="End call"
        >
          <PhoneOffIcon size={22} color="#fff" />
        </button>
      </div>
    </div>
  );
}
