/**
 * server.js
 * NostrEHR — Read-only FHIR R4 API
 *
 * Reads encrypted clinical events from the practice Nostr relay,
 * decrypts with ECDH-granted shared secrets, and returns standard FHIR R4 responses.
 *
 * Security: Uses a dedicated FHIR reader keypair with ECDH grants (kinds 2101/2100)
 * from the practice key. The practice nsec never touches this server.
 * Falls back to PRACTICE_SK_HEX for migration (deprecated).
 *
 * Auth: API key in Authorization header (Bearer ihp_...)
 * Admin: Basic auth for key management endpoints
 */

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { getSharedSecret, nip44Decrypt, getPublicKey, fromHex, toHex } = require("./lib/crypto");
const { queryPatientEvents, queryPatientResourceType, queryRelay, FHIR_KINDS, KIND_TO_FHIR } = require("./lib/relay");
const { normalizeFhirResource, buildBundle, operationOutcome } = require("./lib/fhir-normalize");
const keys = require("./lib/keys");

// ─── Minimal bech32 nsec decoder (no external dependency) ───────────────────
function decodeNsec(nsec) {
  if (!nsec.startsWith("nsec1")) throw new Error("Not an nsec");
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = [];
  for (let i = 5; i < nsec.length; i++) {
    const v = CHARSET.indexOf(nsec[i]);
    if (v === -1) throw new Error("Invalid bech32 character");
    data.push(v);
  }
  // Remove 6-byte checksum
  const values = data.slice(0, -6);
  // Convert from 5-bit to 8-bit
  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of values) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

const PORT = parseInt(process.env.PORT || "3005");
const FHIR_AGENT_NSEC = process.env.FHIR_AGENT_NSEC;
const PRACTICE_SK_HEX = process.env.PRACTICE_SK_HEX; // deprecated fallback
const PRACTICE_PK_HEX = process.env.PRACTICE_PK_HEX;
const RELAY_URL = process.env.RELAY_URL || "wss://relay.example.com";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const KEYS_DB_PATH = process.env.KEYS_DB_PATH;

// ─── Validation ─────────────────────────────────────────────────────────────
if (!FHIR_AGENT_NSEC && !PRACTICE_SK_HEX) {
  console.error("FATAL: Either FHIR_AGENT_NSEC or PRACTICE_SK_HEX is required");
  process.exit(1);
}
if (!PRACTICE_PK_HEX) {
  console.error("FATAL: PRACTICE_PK_HEX is required (practice public key hex)");
  process.exit(1);
}
if (!ADMIN_PASSWORD_HASH) {
  console.error("FATAL: ADMIN_PASSWORD_HASH environment variable is required");
  process.exit(1);
}

const practicePkHex = PRACTICE_PK_HEX;

// ─── Key setup: agent mode vs legacy mode ───────────────────────────────────
let agentMode = false;
let agentSkBytes = null;
let agentPkHex = null;
let practiceSharedX = null; // X₁ — will be set during bootstrap or from legacy key

if (FHIR_AGENT_NSEC) {
  // Agent mode: dedicated keypair, gets X₁ from relay grant
  agentMode = true;
  agentSkBytes = decodeNsec(FHIR_AGENT_NSEC);
  agentPkHex = getPublicKey(agentSkBytes);
  console.log(`[FHIR API] Agent mode: ${agentPkHex.slice(0, 16)}...`);
  console.log(`[FHIR API] Will bootstrap X₁ from practice key grant on relay`);
} else {
  // Legacy mode: direct practice key (deprecated)
  console.warn("[FHIR API] WARNING: Using PRACTICE_SK_HEX directly (deprecated)");
  console.warn("[FHIR API] Migrate to FHIR_AGENT_NSEC for better security isolation");
  const practiceSk = fromHex(PRACTICE_SK_HEX);
  const derivedPk = getPublicKey(practiceSk);
  if (derivedPk !== practicePkHex) {
    console.error("FATAL: PRACTICE_SK_HEX does not match PRACTICE_PK_HEX");
    process.exit(1);
  }
  practiceSharedX = getSharedSecret(practiceSk, practicePkHex);
}

// ─── Bootstrap: fetch X₁ from practice key grant (agent mode) ───────────────
async function bootstrapFromGrants() {
  if (!agentMode) return true; // legacy mode, already set

  console.log(`[FHIR API] Bootstrapping: fetching practice key grant from ${RELAY_URL}...`);

  try {
    // Fetch kind 1013 PracticeKeyGrant events authored by practice, tagged to us
    const grantEvents = await queryRelay(RELAY_URL, {
      kinds: [2101], // PracticeKeyGrant
      authors: [practicePkHex],
      limit: 50,
    }, 10000);

    // Find the latest grant for our agent pubkey
    let latestGrant = null;
    for (const ev of grantEvents) {
      if (ev.pubkey !== practicePkHex) continue;
      const pTag = ev.tags.find(t => t[0] === "p" && t[1] === agentPkHex);
      if (!pTag) continue;
      if (!latestGrant || ev.created_at > latestGrant.created_at) {
        latestGrant = ev;
      }
    }

    if (!latestGrant) {
      console.error("[FHIR API] No practice key grant found for this agent.");
      console.error(`[FHIR API] Agent pubkey: ${agentPkHex}`);
      console.error("[FHIR API] Publish a PracticeKeyGrant (kind 2101) from the EHR Settings → Service Agents.");
      return false;
    }

    // Decrypt the grant using ECDH(agentSk, practicePk) — same shared secret
    const grantSharedX = getSharedSecret(agentSkBytes, practicePkHex);
    const plaintext = await nip44Decrypt(latestGrant.content, grantSharedX);
    const payload = JSON.parse(plaintext);

    if (!payload.practiceSharedSecret) {
      console.error("[FHIR API] Grant decrypted but missing practiceSharedSecret");
      return false;
    }

    // Set X₁ — this is the same shared secret practice owners compute as
    // getSharedSecret(practiceSk, practicePkHex)
    practiceSharedX = fromHex(payload.practiceSharedSecret);

    console.log(`[FHIR API] Bootstrap complete — X₁ loaded from grant (${latestGrant.created_at})`);
    console.log(`[FHIR API] Practice nsec is NOT on this server.`);
    return true;
  } catch (err) {
    console.error(`[FHIR API] Bootstrap failed: ${err.message}`);
    return false;
  }
}

// Initialize API key database
keys.init(KEYS_DB_PATH);

const app = express();
app.use(express.json());

// ─── CORS ───────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGINS || "*";
  res.header("Access-Control-Allow-Origin", allowed);
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── FHIR Content-Type ──────────────────────────────────────────────────────
app.use("/fhir", (req, res, next) => {
  res.type("application/fhir+json");
  next();
});

// ─── Readiness check (blocks requests until bootstrap complete) ─────────────
app.use("/fhir", (req, res, next) => {
  if (!practiceSharedX) {
    return res.status(503).json(operationOutcome("error", "exception",
      "FHIR API is starting up — waiting for grant bootstrap from relay"));
  }
  next();
});

// ─── API Key Auth Middleware ────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    keys.logAccess(0, req.path, null, null, 401);
    return res.status(401).json(operationOutcome("error", "login", "Missing Authorization header. Use: Bearer ihp_..."));
  }

  const token = auth.slice(7);
  const scope = keys.validateKey(token);
  if (!scope) {
    keys.logAccess(0, req.path, null, null, 403);
    return res.status(403).json(operationOutcome("error", "forbidden", "Invalid or expired API key"));
  }

  req.apiKeyScope = scope;
  next();
}

// ─── Admin Auth Middleware ──────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="FHIR API Admin"');
    return res.status(401).json({ error: "Admin authentication required" });
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const [user, pass] = decoded.split(":");
  try {
    const match = await bcrypt.compare(pass, ADMIN_PASSWORD_HASH);
    if (user !== "admin" || !match) {
      return res.status(403).json({ error: "Invalid admin credentials" });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Auth error" });
  }
}

// ─── Helper: Decrypt events and normalize to FHIR ──────────────────────────
async function decryptAndNormalize(events, patientPkHex) {
  const patientRef = { reference: `Patient/${patientPkHex.slice(0, 16)}` };
  const resources = [];

  for (const ev of events) {
    try {
      // Decrypt practice-side content (ev.content, encrypted with X₁)
      // X₁ = getSharedSecret(practiceSk, practicePkHex) — loaded from grant or computed directly
      const plain = await nip44Decrypt(ev.content, practiceSharedX);
      const fhir = JSON.parse(plain);
      if (!fhir.resourceType) continue;

      const resource = normalizeFhirResource(fhir, patientRef, ev);
      if (resource) resources.push(resource);
    } catch {
      // Skip events that fail to decrypt (e.g. different encryption scheme)
    }
  }

  return resources;
}

// ─── FHIR Capability Statement (metadata) ───────────────────────────────────
app.get("/fhir/metadata", (req, res) => {
  res.json({
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    software: {
      name: "NostrEHR FHIR API",
      version: "1.1.0",
    },
    implementation: {
      description: "Read-only FHIR R4 API backed by Nostr relay with NIP-44 encryption",
    },
    fhirVersion: "4.0.1",
    format: ["json"],
    rest: [{
      mode: "server",
      security: {
        service: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/restful-security-service", code: "Bearer" }] }],
        description: "API key authentication via Bearer token",
      },
      resource: [
        "Patient", "Encounter", "Observation", "MedicationRequest",
        "Condition", "AllergyIntolerance", "Immunization",
        "ServiceRequest", "DiagnosticReport", "DocumentReference",
      ].map(type => ({
        type,
        interaction: [{ code: "read" }, { code: "search-type" }],
        searchParam: [{ name: "patient", type: "reference" }],
      })),
    }],
  });
});

// ─── Patient $everything ────────────────────────────────────────────────────
app.get("/fhir/Patient/:patientPk/\\$everything", requireApiKey, async (req, res) => {
  const { patientPk } = req.params;

  if (!keys.canAccessPatient(req.apiKeyScope, patientPk)) {
    keys.logAccess(req.apiKeyScope.id, req.path, patientPk, null, 403);
    return res.status(403).json(operationOutcome("error", "forbidden", "API key does not have access to this patient"));
  }

  try {
    const events = await queryPatientEvents(RELAY_URL, patientPk);
    const resources = await decryptAndNormalize(events, patientPk);

    const patientResource = {
      resourceType: "Patient",
      id: patientPk.slice(0, 16),
      identifier: [{ system: "urn:nostr:pubkey", value: patientPk }],
      meta: { lastUpdated: new Date().toISOString() },
    };

    const hasPatient = resources.some(r => r.resourceType === "Patient");
    const allResources = hasPatient ? resources : [patientResource, ...resources];

    keys.logAccess(req.apiKeyScope.id, req.path, patientPk, "$everything", 200);
    res.json(buildBundle(allResources));
  } catch (err) {
    keys.logAccess(req.apiKeyScope.id, req.path, patientPk, null, 500);
    res.status(500).json(operationOutcome("error", "exception", `Failed to query relay: ${err.message}`));
  }
});

// ─── Resource type queries ──────────────────────────────────────────────────
const SUPPORTED_TYPES = [
  "AllergyIntolerance", "Condition", "DiagnosticReport", "DocumentReference",
  "Encounter", "Immunization", "MedicationRequest", "Observation", "ServiceRequest",
];

SUPPORTED_TYPES.forEach(resourceType => {
  app.get(`/fhir/Patient/:patientPk/${resourceType}`, requireApiKey, async (req, res) => {
    const { patientPk } = req.params;

    if (!keys.canAccessPatient(req.apiKeyScope, patientPk)) {
      keys.logAccess(req.apiKeyScope.id, req.path, patientPk, resourceType, 403);
      return res.status(403).json(operationOutcome("error", "forbidden", "API key does not have access to this patient"));
    }

    if (!keys.canAccessResourceType(req.apiKeyScope, resourceType)) {
      keys.logAccess(req.apiKeyScope.id, req.path, patientPk, resourceType, 403);
      return res.status(403).json(operationOutcome("error", "forbidden", `API key does not have access to ${resourceType}`));
    }

    let kind;
    if (resourceType === "MedicationRequest") {
      kind = null;
    } else {
      kind = FHIR_KINDS[resourceType];
    }

    try {
      let events;
      if (kind) {
        events = await queryPatientResourceType(RELAY_URL, patientPk, resourceType);
      } else {
        const [medEvents, rxEvents] = await Promise.all([
          queryPatientResourceType(RELAY_URL, patientPk, "MedicationRequest"),
          queryPatientResourceType(RELAY_URL, patientPk, "RxOrder"),
        ]);
        events = [...medEvents, ...rxEvents];
      }

      const resources = await decryptAndNormalize(events, patientPk);
      const filtered = resources.filter(r => r.resourceType === resourceType);

      keys.logAccess(req.apiKeyScope.id, req.path, patientPk, resourceType, 200);
      res.json(buildBundle(filtered));
    } catch (err) {
      keys.logAccess(req.apiKeyScope.id, req.path, patientPk, resourceType, 500);
      res.status(500).json(operationOutcome("error", "exception", `Failed to query relay: ${err.message}`));
    }
  });
});

// ─── Catch-all for unsupported FHIR paths ───────────────────────────────────
app.get("/fhir/*", (req, res) => {
  res.status(404).json(operationOutcome("error", "not-found", `Endpoint not found: ${req.path}`));
});

// ─── Admin: Key Management ──────────────────────────────────────────────────
app.get("/admin/keys", requireAdmin, (req, res) => {
  res.json(keys.listKeys());
});

app.post("/admin/keys", requireAdmin, (req, res) => {
  const { label, patientScope, resourceScope, expiresAt } = req.body;
  if (!label) return res.status(400).json({ error: "label is required" });

  const result = keys.createKey(label, { patientScope, resourceScope, expiresAt });
  res.status(201).json({
    message: "API key created. Save this key — it will not be shown again.",
    ...result,
  });
});

app.delete("/admin/keys/:id", requireAdmin, (req, res) => {
  const result = keys.revokeKey(parseInt(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: "Key not found" });
  res.json({ message: "Key revoked" });
});

app.get("/admin/log", requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(keys.getAccessLog(limit));
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: practiceSharedX ? "ok" : "bootstrapping",
    mode: agentMode ? "agent" : "legacy",
    relay: RELAY_URL,
    practicePk: practicePkHex,
    agentPk: agentPkHex || undefined,
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────
async function start() {
  // Bootstrap X₁ from relay grants (agent mode only)
  if (agentMode) {
    const ok = await bootstrapFromGrants();
    if (!ok) {
      console.error("[FHIR API] Grant bootstrap failed. Starting anyway — will return 503 until grant is available.");
      console.error("[FHIR API] Publish grants from EHR Settings → Service Agents, then restart.");

      // Retry bootstrap every 30 seconds
      const retryInterval = setInterval(async () => {
        console.log("[FHIR API] Retrying grant bootstrap...");
        const retryOk = await bootstrapFromGrants();
        if (retryOk) {
          console.log("[FHIR API] Grant bootstrap succeeded on retry.");
          clearInterval(retryInterval);
        }
      }, 30000);
    }
  }

  app.listen(PORT, () => {
    console.log(`FHIR API server running on port ${PORT}`);
    console.log(`  Mode: ${agentMode ? "Agent (dedicated keypair)" : "Legacy (practice key — DEPRECATED)"}`);
    console.log(`  Relay: ${RELAY_URL}`);
    console.log(`  Practice PK: ${practicePkHex}`);
    if (agentPkHex) console.log(`  Agent PK: ${agentPkHex}`);
    console.log(`  X₁ loaded: ${practiceSharedX ? "yes" : "pending (will retry)"}`);
    console.log(`  FHIR endpoint: http://localhost:${PORT}/fhir`);
    console.log(`  Admin endpoint: http://localhost:${PORT}/admin`);
  });
}

start().catch(err => {
  console.error("Failed to start FHIR API:", err);
  process.exit(1);
});
