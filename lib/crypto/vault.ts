import type { BudgetVault, VaultDocument } from "@/lib/budget/types";

export type Envelope = { ciphertext: string; iv: string; tag: string; revision: number; vaultId: string; recoveryWrappedKey?: string; recoverySalt?: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const source = (value: Uint8Array) => new Uint8Array(value) as Uint8Array<ArrayBuffer>;

function bytesToB64(bytes: Uint8Array) { let raw = ""; bytes.forEach((byte) => { raw += String.fromCharCode(byte); }); return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function b64ToBytes(value: string) { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4); const raw = atob(padded); return Uint8Array.from(raw, (char) => char.charCodeAt(0)); }
function aad(vaultId: string, revision: number) { return encoder.encode(`cipher-budget:v1:${vaultId}:${revision}`); }

export function randomBytes(length: number) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return bytes; }
export function recoveryKey() { return bytesToB64(randomBytes(32)).match(/.{1,5}/g)?.join("-") ?? ""; }
export function normalizeRecoveryKey(value: string) { return value.replace(/[^A-Za-z0-9_-]/g, ""); }

export async function generateVaultKey() { return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); }
export async function exportVaultKey(key: CryptoKey) { return new Uint8Array(await crypto.subtle.exportKey("raw", key)); }
// A recovered key may be enrolled on an opted-in trusted browser. It remains
// encrypted at rest; making this in-memory handle wrappable lets the browser
// create that local envelope after recovery.
export async function importVaultKey(raw: Uint8Array) { return crypto.subtle.importKey("raw", source(raw), "AES-GCM", true, ["encrypt", "decrypt"]); }

async function recoveryKek(recovery: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", source(encoder.encode(normalizeRecoveryKey(recovery))), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: source(salt), iterations: 600000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function wrapWithRecovery(key: CryptoKey, recovery: string) {
  const salt = randomBytes(16); const iv = randomBytes(12); const kek = await recoveryKek(recovery, salt);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: source(iv) }, kek, source(await exportVaultKey(key)));
  return { recoverySalt: bytesToB64(salt), recoveryWrappedKey: `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(wrapped))}` };
}

export async function unwrapWithRecovery(recovery: string, saltValue: string, wrappedValue: string) {
  const [iv, ciphertext] = wrappedValue.split("."); if (!iv || !ciphertext) throw new Error("Invalid recovery envelope");
  const kek = await recoveryKek(recovery, b64ToBytes(saltValue));
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: source(b64ToBytes(iv)) }, kek, source(b64ToBytes(ciphertext)));
  return importVaultKey(new Uint8Array(raw));
}

async function passkeyKek(prfOutput: ArrayBuffer, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: source(salt), info: source(encoder.encode("cipher-budget:passkey-wrap:v1")) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function wrapWithPasskey(key: CryptoKey, prfOutput: ArrayBuffer, salt: Uint8Array) {
  const iv = randomBytes(12); const kek = await passkeyKek(prfOutput, salt);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: source(iv) }, kek, source(await exportVaultKey(key)));
  return `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(wrapped))}`;
}

export async function unwrapWithPasskey(wrappedValue: string, prfOutput: ArrayBuffer, salt: Uint8Array) {
  const [iv, ciphertext] = wrappedValue.split("."); if (!iv || !ciphertext) throw new Error("Invalid device envelope");
  const kek = await passkeyKek(prfOutput, salt);
  return importVaultKey(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: source(b64ToBytes(iv)) }, kek, source(b64ToBytes(ciphertext)))));
}

export async function encryptVault(vault: BudgetVault, key: CryptoKey, vaultId: string, revision: number): Promise<Pick<Envelope, "ciphertext" | "iv" | "tag">> {
  const iv = randomBytes(12); const output = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: source(iv), additionalData: source(aad(vaultId, revision)), tagLength: 128 }, key, source(encoder.encode(JSON.stringify(vault)))));
  return { ciphertext: bytesToB64(output.slice(0, -16)), tag: bytesToB64(output.slice(-16)), iv: bytesToB64(iv) };
}

export async function decryptVault(envelope: Envelope, key: CryptoKey): Promise<VaultDocument> {
  try {
    const body = b64ToBytes(envelope.ciphertext); const tag = b64ToBytes(envelope.tag); const joined = new Uint8Array(body.length + tag.length); joined.set(body); joined.set(tag, body.length);
    const value = await crypto.subtle.decrypt({ name: "AES-GCM", iv: source(b64ToBytes(envelope.iv)), additionalData: source(aad(envelope.vaultId, envelope.revision)), tagLength: 128 }, key, source(joined));
    return JSON.parse(decoder.decode(value)) as VaultDocument;
  } catch {
    // AES-GCM intentionally gives a generic error for a wrong key or modified
    // ciphertext. Give the user a clear, non-sensitive explanation instead.
    throw new Error("The vault key is invalid, or this encrypted vault has been changed.");
  }
}

export const b64 = { bytesToB64, b64ToBytes };
