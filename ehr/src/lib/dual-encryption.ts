/**
 * src/lib/dual-encryption.ts
 * Phase 7: Dual encryption for practice AND patient access
 * Phase 18: Added precomputed-secret variants for multi-user staff access
 */

import { getSharedSecret } from "./nostr";
import { nip44Encrypt, nip44Decrypt } from "./nip44";

// ─── Original functions (practice key holder) ────────────────────────────────

export async function dualEncrypt(
  plaintext: string,
  practiceSk: Uint8Array,
  practicePkHex: string,
  patientPkHex: string
): Promise<{ practiceEncrypted: string; patientEncrypted: string }> {
  const practiceSharedX = getSharedSecret(practiceSk, practicePkHex);
  const practiceEncrypted = await nip44Encrypt(plaintext, practiceSharedX);
  
  const patientSharedX = getSharedSecret(practiceSk, patientPkHex);
  const patientEncrypted = await nip44Encrypt(plaintext, patientSharedX);
  
  return { practiceEncrypted, patientEncrypted };
}

export async function dualDecrypt(
  encrypted: string,
  viewerSk: Uint8Array,
  publisherPkHex: string
): Promise<string> {
  const sharedX = getSharedSecret(viewerSk, publisherPkHex);
  return await nip44Decrypt(encrypted, sharedX);
}

// ─── Multi-user functions (precomputed shared secrets) ───────────────────────

/**
 * Dual-encrypt using precomputed shared secrets instead of the practice SK.
 * Used by staff members who received shared secrets via key grants.
 *
 * @param plaintext       - FHIR JSON to encrypt
 * @param practiceSecret  - X₁ = getSharedSecret(practiceSk, practicePkHex) — universal
 * @param patientSecret   - X₂ = getSharedSecret(practiceSk, patientPkHex)  — per-patient
 */
export async function dualEncryptWithSecrets(
  plaintext: string,
  practiceSecret: Uint8Array,
  patientSecret: Uint8Array,
): Promise<{ practiceEncrypted: string; patientEncrypted: string }> {
  const practiceEncrypted = await nip44Encrypt(plaintext, practiceSecret);
  const patientEncrypted  = await nip44Encrypt(plaintext, patientSecret);
  return { practiceEncrypted, patientEncrypted };
}

/**
 * Decrypt practice-copy content using the precomputed practice shared secret.
 * Works for events signed by ANY authorized pubkey (practice or staff),
 * because all events encrypt .content with the same X₁.
 *
 * @param encrypted       - NIP-44 encrypted content string
 * @param practiceSecret  - X₁ = getSharedSecret(practiceSk, practicePkHex)
 */
export async function dualDecryptWithSecret(
  encrypted: string,
  practiceSecret: Uint8Array,
): Promise<string> {
  return await nip44Decrypt(encrypted, practiceSecret);
}

export function buildDualEncryptedTags(
  practicePkHex: string,
  patientPkHex: string,
  patientEncrypted: string,
  resourceType: string,
  patientId: string,
  additionalTags: string[][] = []
): string[][] {
  return [
    ["p", practicePkHex],
    ["p", patientPkHex],
    ["patient-content", patientEncrypted],
    ["fhir", resourceType],
    ["v", "R4"],
    ["enc", "nip44-v2"],
    ["pt", patientId],
    ...additionalTags
  ];
}

export function getPatientContent(event: { tags: string[][] }): string | null {
  const tag = event.tags.find(t => t[0] === "patient-content");
  return tag ? tag[1] : null;
}