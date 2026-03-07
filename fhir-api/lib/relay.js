/**
 * lib/relay.js
 * Nostr relay client for the FHIR API server
 * Connects via WebSocket, subscribes, collects events, disconnects
 */

const WebSocket = require("ws");

const FHIR_KINDS = {
  Patient: 1000,
  Encounter: 1001,
  MedicationRequest: 1002,
  Observation: 1003,
  Condition: 1004,
  AllergyIntolerance: 1005,
  Immunization: 1006,
  Message: 1007,
  ServiceRequest: 1008,
  DiagnosticReport: 1009,
  RxOrder: 1010,
  DocumentReference: 1011,
};

const ALL_CLINICAL_KINDS = Object.values(FHIR_KINDS);

const KIND_TO_FHIR = {};
Object.entries(FHIR_KINDS).forEach(([name, kind]) => { KIND_TO_FHIR[kind] = name; });

/**
 * Query events from the relay matching a filter
 * @param {string} relayUrl - WebSocket URL
 * @param {object} filter - Nostr subscription filter
 * @param {number} timeoutMs - Max time to wait for events
 * @returns {Promise<Array>} - Array of Nostr events
 */
function queryRelay(relayUrl, filter, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const seen = new Set();
    let resolved = false;
    let ws;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      resolve(events);
    };

    try {
      ws = new WebSocket(relayUrl);
    } catch (err) {
      reject(new Error(`Failed to connect to relay: ${err.message}`));
      return;
    }

    ws.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Relay connection error: ${err.message}`));
      }
    });

    ws.on("open", () => {
      const subId = `fhir-api-${Date.now()}`;
      ws.send(JSON.stringify(["REQ", subId, filter]));

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === "EVENT" && msg[1] === subId) {
            const ev = msg[2];
            if (!seen.has(ev.id)) {
              seen.add(ev.id);
              events.push(ev);
            }
          } else if (msg[0] === "EOSE" && msg[1] === subId) {
            finish();
          }
        } catch {}
      });
    });

    // Timeout fallback
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Query all clinical events for a patient
 */
async function queryPatientEvents(relayUrl, patientPkHex, kinds = null) {
  const filter = {
    kinds: kinds || ALL_CLINICAL_KINDS,
    "#p": [patientPkHex],
    limit: 5000,
  };
  return queryRelay(relayUrl, filter);
}

/**
 * Query events of a specific kind for a patient
 */
async function queryPatientResourceType(relayUrl, patientPkHex, resourceType) {
  const kind = FHIR_KINDS[resourceType];
  if (!kind) throw new Error(`Unknown FHIR resource type: ${resourceType}`);
  return queryRelay(relayUrl, {
    kinds: [kind],
    "#p": [patientPkHex],
    limit: 1000,
  });
}

module.exports = {
  queryRelay,
  queryPatientEvents,
  queryPatientResourceType,
  FHIR_KINDS,
  ALL_CLINICAL_KINDS,
  KIND_TO_FHIR,
};
