/**
 * src/lib/cache.ts
 * IndexedDB cache for decrypted Nostr events — enables local-first EHR.
 *
 * Stores decrypted FHIR JSON alongside event metadata so the UI can
 * hydrate instantly from cache before the relay WebSocket connects.
 *
 * Schema:
 *   events: { eventId, kind, patientId, pubkey, created_at, fhirJson, tags, cachedAt }
 *   meta:   { key, value }  — stores lastSync timestamp, etc.
 *   outbox: { eventId, event, kind, patientId, fhirJson, tags, queuedAt }  — write queue (v2)
 */

const DB_NAME = "nostr_ehr_cache";
const DB_VERSION = 2;

export interface CachedEvent {
  eventId: string;
  kind: number;
  patientId: string;
  pubkey: string;
  created_at: number;
  fhirJson: string;       // stringified decrypted FHIR resource
  tags: string[][];        // raw Nostr event tags (for status-update links, threading, etc.)
  cachedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) {
        const store = db.createObjectStore("events", { keyPath: "eventId" });
        store.createIndex("by_kind_patient", ["kind", "patientId"], { unique: false });
        store.createIndex("by_kind", "kind", { unique: false });
        store.createIndex("by_patient", "patientId", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      // v2: Write queue — stores signed events waiting to be published to relay
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "eventId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

// ─── Event Cache ──────────────────────────────────────────────────────────────

/**
 * Cache a single decrypted event. Idempotent — overwrites if eventId exists.
 */
export async function cacheEvent(
  eventId: string,
  kind: number,
  patientId: string,
  pubkey: string,
  created_at: number,
  fhirJson: string,
  tags: string[][]
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction("events", "readwrite");
    tx.objectStore("events").put({
      eventId,
      kind,
      patientId,
      pubkey,
      created_at,
      fhirJson,
      tags,
      cachedAt: Date.now(),
    } as CachedEvent);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    // Cache failures are non-fatal — relay is the source of truth
  }
}

/**
 * Batch-cache multiple events in a single transaction.
 */
export async function cacheEvents(
  events: { eventId: string; kind: number; patientId: string; pubkey: string; created_at: number; fhirJson: string; tags: string[][] }[]
): Promise<void> {
  if (events.length === 0) return;
  try {
    const db = await openDB();
    const tx = db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    for (const ev of events) {
      store.put({ ...ev, cachedAt: Date.now() } as CachedEvent);
    }
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Get all cached events for a specific kind + patientId.
 * This is the primary read path for components.
 */
export async function getCachedEvents(kind: number, patientId: string): Promise<CachedEvent[]> {
  try {
    const db = await openDB();
    const tx = db.transaction("events", "readonly");
    const index = tx.objectStore("events").index("by_kind_patient");
    const req = index.getAll([kind, patientId]);
    return await new Promise<CachedEvent[]>((res, rej) => {
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Get all cached events for a specific kind (across all patients).
 * Used by InboxSidebar which loads all messages.
 */
export async function getCachedEventsByKind(kind: number): Promise<CachedEvent[]> {
  try {
    const db = await openDB();
    const tx = db.transaction("events", "readonly");
    const index = tx.objectStore("events").index("by_kind");
    const req = index.getAll(kind);
    return await new Promise<CachedEvent[]>((res, rej) => {
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Get all cached events for a patient (any kind).
 * Useful for Patient Timeline (future feature).
 */
export async function getCachedEventsByPatient(patientId: string): Promise<CachedEvent[]> {
  try {
    const db = await openDB();
    const tx = db.transaction("events", "readonly");
    const index = tx.objectStore("events").index("by_patient");
    const req = index.getAll(patientId);
    return await new Promise<CachedEvent[]>((res, rej) => {
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Check if a specific event is cached.
 */
export async function hasEvent(eventId: string): Promise<boolean> {
  try {
    const db = await openDB();
    const tx = db.transaction("events", "readonly");
    const req = tx.objectStore("events").getKey(eventId);
    return await new Promise<boolean>((res, rej) => {
      req.onsuccess = () => res(req.result !== undefined);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return false;
  }
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

/**
 * Get last sync timestamp — used to request only newer events on reconnect.
 */
export async function getLastSync(): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").get("lastSync");
    return await new Promise<number>((res, rej) => {
      req.onsuccess = () => res(req.result?.value || 0);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return 0;
  }
}

export async function setLastSync(timestamp: number): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key: "lastSync", value: timestamp });
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Get cache stats — for the connection indicator.
 */
export async function getCacheStats(): Promise<{ eventCount: number; lastSync: number }> {
  try {
    const db = await openDB();
    const tx = db.transaction(["events", "meta"], "readonly");
    const countReq = tx.objectStore("events").count();
    const syncReq = tx.objectStore("meta").get("lastSync");
    return await new Promise<{ eventCount: number; lastSync: number }>((res, rej) => {
      tx.oncomplete = () =>
        res({
          eventCount: countReq.result || 0,
          lastSync: syncReq.result?.value || 0,
        });
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    return { eventCount: 0, lastSync: 0 };
  }
}

/**
 * Clear entire cache — emergency reset.
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(["events", "meta"], "readwrite");
    tx.objectStore("events").clear();
    tx.objectStore("meta").clear();
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    // Non-fatal
  }
}

// ─── Write Queue (Outbox) ─────────────────────────────────────────────────────
// Stores fully-signed Nostr events that could not be published to the relay.
// Flushed automatically when the relay reconnects (see useRelay in page.tsx).

export interface QueuedEvent {
  eventId: string;
  event: any;            // Full signed NostrEvent (ready to send as-is)
  kind: number;
  patientId: string;
  fhirJson: string;      // Decrypted FHIR JSON (already cached in events store for display)
  tags: string[][];
  queuedAt: number;      // Unix timestamp (seconds)
}

/**
 * Queue a signed event for later relay publish.
 */
export async function queueEvent(item: QueuedEvent): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").put(item);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    console.error("[cache] queueEvent failed:", e);
  }
}

/**
 * Get all queued events, oldest first (FIFO).
 */
export async function getQueuedEvents(): Promise<QueuedEvent[]> {
  try {
    const db = await openDB();
    const tx = db.transaction("outbox", "readonly");
    const req = tx.objectStore("outbox").getAll();
    return await new Promise<QueuedEvent[]>((res, rej) => {
      req.onsuccess = () => {
        const items = (req.result as QueuedEvent[]).sort((a, b) => a.queuedAt - b.queuedAt);
        res(items);
      };
      req.onerror = () => rej(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Remove a successfully published event from the queue.
 */
export async function removeQueuedEvent(eventId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").delete(eventId);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Get count of queued (pending) events.
 */
export async function getQueueCount(): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction("outbox", "readonly");
    const req = tx.objectStore("outbox").count();
    return await new Promise<number>((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return 0;
  }
}

/**
 * Clear entire outbox — e.g. after successful full flush.
 */
export async function clearOutbox(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").clear();
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    // Non-fatal
  }
}
