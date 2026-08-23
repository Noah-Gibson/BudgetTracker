"use client";

import type { Envelope } from "@/lib/crypto/vault";

const DB = "cipher-budget-offline";
const STORE = "snapshots";
const KEY = "current";
export type VaultSnapshot = { version: 1; envelope: Envelope; savedAt: string };

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveVaultSnapshot(envelope: Envelope) {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put({ version: 1, envelope, savedAt: new Date().toISOString() } satisfies VaultSnapshot, KEY); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
}
export async function loadVaultSnapshot() {
  const db = await database();
  try { return await new Promise<VaultSnapshot | null>((resolve, reject) => { const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY); request.onsuccess = () => resolve((request.result as VaultSnapshot | undefined) ?? null); request.onerror = () => reject(request.error); }); } finally { db.close(); }
}
export async function clearVaultSnapshot() {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(KEY); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
}
