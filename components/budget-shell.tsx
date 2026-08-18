"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ThemeToggle } from "@/components/theme-toggle";
import { DriveSpreadsheetBackup } from "@/components/drive-spreadsheet-backup";
import { Button } from "primereact/button";
import { Card } from "primereact/card";
import { Checkbox } from "primereact/checkbox";
import { Dialog } from "primereact/dialog";
import { InputNumber } from "primereact/inputnumber";
import { InputText } from "primereact/inputtext";
import { ProgressBar } from "primereact/progressbar";
import { Toast } from "primereact/toast";
import { addDays, bucketMeta, clonePayMonth, clonePeriod, createEmptyVault, cyclePayPeriod, dueDatesWithin, money, newId, todayISO, totals, upgradeVault, type BudgetVault, type Bucket, type ExpenseEntry, type IncomeEntry, type PayMonth, type BudgetCycle, type PayPeriod, type RecurringBill, type RecurringBillCandidate, type LegacyBudgetPeriod, type LegacyBudgetVault, type LegacyExpenseEntry, type V2BudgetVault } from "@/lib/budget/types";
import { budgetWorkbook, importBudgetWorkbook } from "@/lib/budget/spreadsheet";
import { decryptVault, encryptVault, exportVaultKey, generateVaultKey, importVaultKey, randomBytes, recoveryKey, unwrapWithPasskey, unwrapWithRecovery, wrapWithRecovery, type Envelope } from "@/lib/crypto/vault";
import { beginDriveRecoveryAuthorization, checkDriveRecoveryBackup, clearDriveRecoveryAuthorization, loadDriveRecoveryBackup, prepareDriveRecoveryAuthorization, removeDriveRecoveryBackup, saveDriveRecoveryBackup, type DriveRecoveryPackage, type SpreadsheetBackupResult } from "@/lib/drive/recovery";

type ListEntry = { id: string; name: string; amountCents: number; date?: string; recurring?: boolean };
type DriveBackupStatus = "unverified" | "verified" | "stale";
type DriveUnlockStatus = "checking" | "connected" | "connect-required" | "missing-backup" | "stale-backup" | "unavailable" | "no-vault";
type PasskeyDeviceEnvelope = { kind?: "passkey"; salt: string; wrappedKey: string; deviceId: string };
type TrustedDeviceEnvelope = { kind: "trusted-device"; iv: string; wrappedKey: string; deviceId: string };
type DeviceEnvelope = PasskeyDeviceEnvelope | TrustedDeviceEnvelope;
const DEVICE_KEY = "cipher-budget:device-v1";
const DEVICE_DATABASE = "cipher-budget-device-keys";
const DEVICE_STORE = "keys";
const TRUSTED_DEVICE_KEY = "trusted-device-key-v1";
const expenseHints: Record<Bucket, string> = {
  needs: "e.g. Groceries",
  goals: "e.g. Student loan payment",
  wants: "e.g. Dining out"
};
const bytesToB64 = (value: Uint8Array) => {
  let text = "";
  value.forEach((byte) => { text += String.fromCharCode(byte); });
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const b64ToBytes = (value: string) => {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};
function deviceEnvelope(): DeviceEnvelope | null {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    const value = stored ? JSON.parse(stored) as { kind?: unknown; salt?: unknown; iv?: unknown; wrappedKey?: unknown; deviceId?: unknown } : null;
    if (!value || typeof value.wrappedKey !== "string" || typeof value.deviceId !== "string") return null;
    if (value.kind === "trusted-device" && typeof value.iv === "string") return value as TrustedDeviceEnvelope;
    return typeof value.salt === "string" ? value as PasskeyDeviceEnvelope : null;
  } catch { return null; }
}
function deviceDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DEVICE_DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DEVICE_STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Unable to access this browser's secure key storage."));
  });
}
async function readTrustedDeviceKey() {
  const db = await deviceDatabase();
  try {
    return await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const request = db.transaction(DEVICE_STORE, "readonly").objectStore(DEVICE_STORE).get(TRUSTED_DEVICE_KEY);
      request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function writeTrustedDeviceKey(key: CryptoKey) {
  const db = await deviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DEVICE_STORE, "readwrite");
      transaction.objectStore(DEVICE_STORE).put(key, TRUSTED_DEVICE_KEY);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
async function forgetTrustedDeviceKey() {
  const db = await deviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DEVICE_STORE, "readwrite");
      transaction.objectStore(DEVICE_STORE).delete(TRUSTED_DEVICE_KEY);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
async function rememberTrustedDevice(vaultKey: CryptoKey): Promise<TrustedDeviceEnvelope> {
  const deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, deviceKey, await exportVaultKey(vaultKey));
  await writeTrustedDeviceKey(deviceKey);
  return { kind: "trusted-device", iv: bytesToB64(iv), wrappedKey: bytesToB64(new Uint8Array(wrapped)), deviceId: newId() };
}
async function unlockTrustedDevice(device: TrustedDeviceEnvelope) {
  const deviceKey = await readTrustedDeviceKey();
  if (!deviceKey) throw new Error("This browser's trusted-device key is unavailable. Use your recovery key to enroll it again.");
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(device.iv) }, deviceKey, b64ToBytes(device.wrappedKey));
  return importVaultKey(new Uint8Array(raw));
}
function passkeyPrf(response: unknown): ArrayBuffer | undefined {
  const first = (response as { clientExtensionResults?: { prf?: { results?: { first?: ArrayBuffer | Uint8Array | string } } } }).clientExtensionResults?.prf?.results?.first;
  if (first instanceof ArrayBuffer) return first;
  if (first instanceof Uint8Array) return first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) as ArrayBuffer;
  return typeof first === "string" ? b64ToBytes(first).buffer : undefined;
}
async function requestPasskey(mode: "registration" | "authentication", salt?: string) {
  const optionsResponse = await fetch("/api/passkeys/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, prfSalt: salt }) });
  if (!optionsResponse.ok) throw new Error("Unable to start passkey verification. Check that the secure server environment is configured.");
  const options = await optionsResponse.json();
  // The API deliberately returns JSON-safe base64url. WebAuthn requires the
  // native BufferSource form, and SimpleWebAuthn only converts its standard
  // fields automatically, not extension inputs.
  if (mode === "authentication" && salt && options.extensions?.prf?.eval?.first === salt) {
    options.extensions.prf.eval.first = b64ToBytes(salt).buffer;
  }
  const response = mode === "registration" ? await startRegistration({ optionsJSON: options }) : await startAuthentication({ optionsJSON: options });
  // The PRF output is client-only key material. Authentication verification
  // does not need it, so never transmit it to the backend.
  const { clientExtensionResults: _clientExtensionResults, ...responseForVerification } = response;
  const verified = await fetch("/api/passkeys/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, response: responseForVerification }) });
  if (!verified.ok) throw new Error("The passkey could not be verified.");
  return { prf: mode === "authentication" ? passkeyPrf(response) : undefined };
}
function periodLabel(period: { startDate: string; endDate: string }) {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const start = new Date(period.startDate + "T12:00:00").toLocaleDateString(undefined, options);
  const end = new Date(period.endDate + "T12:00:00").toLocaleDateString(undefined, { ...options, year: "numeric" });
  return start + " – " + end;
}
function displayDate(value: string) { return new Date(value + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

function GoogleSignInButton() {
  // Do not silently reuse the last Google identity. Google still keeps its
  // own session cookie, but this OAuth parameter always opens its account
  // chooser so the user can deliberately select the correct account.
  return <button type="button" className="google-sign-in" onClick={() => signIn("google", undefined, { prompt: "select_account" })}>
    <svg aria-hidden="true" focusable="false" viewBox="0 0 18 18">
      <path fill="#EA4335" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.91c1.7-1.56 2.69-3.86 2.69-6.61Z" />
      <path fill="#4285F4" d="M9 18c2.43 0 4.47-.8 5.96-2.19l-2.91-2.26c-.8.54-1.83.86-3.05.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.95 10.69A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.69V4.98H.94A9 9 0 0 0 0 9c0 1.45.35 2.82.94 4.02l3.01-2.33Z" />
      <path fill="#34A853" d="M9 3.58c1.32 0 2.5.45 3.43 1.33l2.57-2.57C13.46.9 11.43 0 9 0A9 9 0 0 0 .94 4.98l3.01 2.33C4.66 5.17 6.65 3.58 9 3.58Z" />
    </svg><span>Sign in with Google</span>
  </button>;
}

export function BudgetShell() {
  const { data: session, status } = useSession();
  if (status === "loading") return <main className="center-screen"><i className="pi pi-spin pi-spinner" /> Loading secure session…</main>;
  if (!session?.user) return <main className="landing">
    <ThemeToggle className="landing-theme-toggle" />
    <section className="landing-copy"><p className="eyebrow">PRIVATE BY DESIGN</p><h1>Your budget, visible only to you.</h1><p>Manage every pay-month budget in a vault encrypted in your browser. The service stores encrypted data—not your financial details.</p><GoogleSignInButton /></section>
    <section className="security-panel"><i className="pi pi-shield security-icon" /><h2>We can&apos;t see your data</h2><ul><li>Google sign-in + a personal passkey</li><li>Browser-encrypted budget vault</li><li>Google Drive recovery backup</li><li>Pay-month budgeting that works beautifully on mobile</li></ul></section>
  </main>;
  return <VaultWorkspace email={session.user.email ?? "Signed in with Google"} image={session.user.image} onSignOut={() => { clearDriveRecoveryAuthorization(); void signOut({ callbackUrl: "/" }); }} />;
}

function VaultWorkspace({ email, image, onSignOut }: { email: string; image?: string | null; onSignOut: () => void }) {
  const [vault, setVault] = useState<BudgetVault | null>(null);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [recovery, setRecovery] = useState("");
  const [createdRecovery, setCreatedRecovery] = useState("");
  const [confirmRecovery, setConfirmRecovery] = useState("");
  const [driveBackup, setDriveBackup] = useState<{ vaultId: string; recoveryKey: string } | null>(null);
  const [driveBackupStatus, setDriveBackupStatus] = useState<DriveBackupStatus>("unverified");
  const [driveUnlockStatus, setDriveUnlockStatus] = useState<DriveUnlockStatus>("checking");
  const [staleDriveVaultId, setStaleDriveVaultId] = useState<string | null>(null);
  const [driveReady, setDriveReady] = useState(false);
  const [showDriveMigration, setShowDriveMigration] = useState(false);
  const [showManualRecovery, setShowManualRecovery] = useState(false);
  const [showManualUnlock, setShowManualUnlock] = useState(false);
  const [setup, setSetup] = useState(false);
  const [resetCandidate, setResetCandidate] = useState<{ replaceExisting: boolean; deletedVaultId?: string } | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [showAbandon, setShowAbandon] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [autoUnlocking, setAutoUnlocking] = useState(false);
  const [savedVaultGeneration, setSavedVaultGeneration] = useState(0);
  const toast = useRef<Toast>(null);
  const attemptedRememberedUnlock = useRef(false);
  const activeKey = useRef<CryptoKey | null>(null);
  const activeEnvelope = useRef<Envelope | null>(null);
  const preparedDriveBackup = useRef<DriveRecoveryPackage | null>(null);
  const pendingSave = useRef<BudgetVault | null>(null);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const lock = useCallback((message = "Vault locked. Verify your passkey to continue.") => {
    pendingSave.current = null; activeKey.current = null; activeEnvelope.current = null;
    setVault(null); setKey(null); setEnvelope(null); setNotice(message);
  }, []);
  const lockAndForgetBrowser = useCallback((message = "Vault locked and this browser has been forgotten.") => {
    localStorage.removeItem(DEVICE_KEY);
    void forgetTrustedDeviceKey();
    lock(message);
  }, [lock]);

  const fetchEnvelope = useCallback(async () => {
    const response = await fetch("/api/vault", { cache: "no-store" });
    if (!response.ok) throw new Error("Vault is not available. Verify your passkey first.");
    return (await response.json()).vault as Envelope | null;
  }, []);
  const unlockRemembered = async () => {
    setBusy(true); setNotice("");
    try {
      const device = deviceEnvelope(); if (!device) throw new Error("No remembered vault key is stored in this browser.");
      if (device.kind === "trusted-device") {
        const remote = await fetchEnvelope();
        if (!remote) { setSetup(true); return; }
        const unlocked = await unlockTrustedDevice(device);
        const document = await decryptVault(remote, unlocked); const { vault: decrypted } = upgradeVault(document); activeKey.current = unlocked; activeEnvelope.current = remote;
        if (document.version !== 3) void save(decrypted).catch((error) => setNotice(error instanceof Error ? error.message : "Could not secure the upgraded vault."));
        setKey(unlocked); setEnvelope(remote); setVault(decrypted);
        return;
      }
      const assertion = await requestPasskey("authentication", device.salt); const remote = await fetchEnvelope();
      if (!remote) { setSetup(true); return; }
      if (!assertion.prf) throw new Error("This passkey cannot unlock the remembered vault. Use your recovery key to enroll a supported browser.");
      const unlocked = await unwrapWithPasskey(device.wrappedKey, assertion.prf, b64ToBytes(device.salt));
      const document = await decryptVault(remote, unlocked); const { vault: decrypted } = upgradeVault(document); activeKey.current = unlocked; activeEnvelope.current = remote;
      if (document.version !== 3) void save(decrypted).catch((error) => setNotice(error instanceof Error ? error.message : "Could not secure the upgraded vault."));
      setKey(unlocked); setEnvelope(remote); setVault(decrypted);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to unlock the vault."); } finally { setBusy(false); }
  };
  useEffect(() => {
    setBrowserReady(true);
  }, []);
  useEffect(() => {
    let active = true;
    void prepareDriveRecoveryAuthorization().then(() => { if (active) setDriveReady(true); }).catch(() => { if (active) { setDriveReady(false); setDriveUnlockStatus("unavailable"); } });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!driveReady || vault || setup || createdRecovery || driveBackup) return;
    let active = true;
    preparedDriveBackup.current = null;
    setDriveUnlockStatus("checking");
    void (async () => {
      try {
        const remote = await fetchEnvelope();
        if (!active) return;
        if (!remote) { setDriveUnlockStatus("no-vault"); return; }
        const result = await checkDriveRecoveryBackup(email);
        if (!active) return;
        if (result.status !== "connected") { setDriveUnlockStatus(result.status); return; }
        if (result.backup.vaultId !== remote.vaultId) {
          preparedDriveBackup.current = null;
          setDriveBackupStatus("stale"); setStaleDriveVaultId(result.backup.vaultId);
          setDriveUnlockStatus("stale-backup");
          return;
        }
        preparedDriveBackup.current = result.backup;
        setDriveBackupStatus("verified"); setStaleDriveVaultId(null);
        setDriveUnlockStatus("connected");
      } catch {
        if (active) setDriveUnlockStatus("unavailable");
      }
    })();
    return () => { active = false; };
  }, [createdRecovery, driveBackup, driveReady, email, fetchEnvelope, setup, vault]);
  useEffect(() => {
    const remembered = deviceEnvelope();
    if (attemptedRememberedUnlock.current || vault || setup || createdRecovery || driveBackup || remembered?.kind !== "trusted-device") return;
    attemptedRememberedUnlock.current = true;
    setAutoUnlocking(true);
    void unlockRemembered().finally(() => setAutoUnlocking(false));
  }, [createdRecovery, driveBackup, setup, unlockRemembered, vault]);
  const unlockRecovery = async (recoveryValue = recovery, source = "recovery key", expectedVaultId?: string) => {
    setBusy(true); setNotice("");
    try {
      // A new browser has no site passkey yet. Retrieve only the account's
      // ciphertext, validate the recovery key locally, then verify a local
      // passkey or optionally enroll one before exposing the decrypted budget.
      const remote = await fetchEnvelope();
      if (!remote) { setSetup(true); return; }
      if (expectedVaultId && remote.vaultId !== expectedVaultId) {
        preparedDriveBackup.current = null;
        setDriveUnlockStatus("stale-backup");
        throw new Error("This Google Drive backup belongs to a deleted or different vault. Use the current vault’s recovery method instead.");
      }
      const unlocked = await unwrapWithRecovery(recoveryValue, remote.recoverySalt!, remote.recoveryWrappedKey!);
      let addedPasskey = false;
      try {
        // An existing passkey on this browser is sufficient. Do not create a
        // second credential just because the user chose recovery unlock.
        await requestPasskey("authentication");
      } catch {
        // WebAuthn cannot reliably distinguish a missing local credential
        // from a cancelled chooser. Make adding a credential an explicit,
        // informed fallback rather than silently registering another one.
        if (!window.confirm("No existing Cipher Budget passkey was verified on this browser. Create a new passkey for this browser now?")) {
          throw new Error("Vault recovery was cancelled before a browser passkey was verified.");
        }
        await requestPasskey("registration");
        addedPasskey = true;
      }
      if (remember) {
        const trustedDevice = await rememberTrustedDevice(unlocked);
        localStorage.setItem(DEVICE_KEY, JSON.stringify(trustedDevice));
      }
      const document = await decryptVault(remote, unlocked); const { vault: decrypted } = upgradeVault(document);
      const openedVault = expectedVaultId === remote.vaultId && decrypted.recoveryProvider !== "google-drive" ? { ...decrypted, recoveryProvider: "google-drive" as const } : decrypted;
      activeKey.current = unlocked; activeEnvelope.current = remote;
      if (document.version !== 3 || openedVault !== decrypted) void save(openedVault).catch((error) => setNotice(error instanceof Error ? error.message : "Could not secure the upgraded vault."));
      // A Drive restore has just proved both that its package belongs to this
      // vault and that its recovery secret unwraps the current vault key.
      // Preserve that verified status for the unlocked workspace; otherwise a
      // prior manual-key vault incorrectly offers Drive migration again.
      if (expectedVaultId === remote.vaultId) {
        setDriveBackupStatus("verified");
        setStaleDriveVaultId(null);
      }
      setRecovery(""); setKey(unlocked); setEnvelope(remote); setVault(openedVault);
      toast.current?.show({ severity: "success", summary: addedPasskey ? "Browser passkey added" : "Vault unlocked", detail: remember ? "This trusted browser will also reopen with your Google session." : addedPasskey ? "Keep your backup method available if this browser is forgotten." : `Unlocked with ${source}.` });
    } catch (error) { setNotice(error instanceof Error ? error.message : "The recovery key could not unlock this vault."); } finally { setBusy(false); }
  };
  const unlockPreparedDriveBackup = async () => {
    const backup = preparedDriveBackup.current;
    if (!backup) { setDriveUnlockStatus("connect-required"); return; }
    await unlockRecovery(backup.recoveryKey, "Google Drive backup", backup.vaultId);
  };
  const connectDriveAndUnlock = async () => {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      // Start authorization in the direct button event to preserve Safari's
      // popup activation. The same pending request is reused below.
      const authorization = beginDriveRecoveryAuthorization(email);
      const backup = await loadDriveRecoveryBackup({ prompt: "", loginHint: email });
      await authorization;
      const remote = await fetchEnvelope();
      if (!remote) { setDriveUnlockStatus("no-vault"); return; }
      if (backup.vaultId !== remote.vaultId) {
        setDriveBackupStatus("stale"); setStaleDriveVaultId(backup.vaultId);
        setDriveUnlockStatus("stale-backup");
        throw new Error("This Google Drive backup belongs to a deleted or different vault. Use the current vault’s recovery method instead.");
      }
      preparedDriveBackup.current = backup;
      setDriveBackupStatus("verified"); setStaleDriveVaultId(null); setDriveUnlockStatus("connected");
      setBusy(false);
      await unlockRecovery(backup.recoveryKey, "Google Drive backup", backup.vaultId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Google Drive could not restore this vault."); } finally { setBusy(false); }
  };
  const startSetup = async () => {
    setBusy(true); setNotice("");
    try {
      await requestPasskey("registration");
      await requestPasskey("authentication");
      // A browser can lose its remembered envelope while the encrypted vault
      // remains on the server. Never try to overwrite that vault as a fresh
      // revision-one save; require the explicit destructive reset decision.
      const existingVault = await fetchEnvelope();
      if (existingVault) {
        setResetCandidate({ replaceExisting: true, deletedVaultId: existingVault.vaultId });
        setSetup(false);
        return;
      }
      const vaultKey = await generateVaultKey(); const code = recoveryKey(); const recoveryWrapper = await wrapWithRecovery(vaultKey, code);
      if (remember) {
        const trustedDevice = await rememberTrustedDevice(vaultKey);
        localStorage.setItem(DEVICE_KEY, JSON.stringify(trustedDevice));
      }
      const initialVault = createEmptyVault(); const initialEnvelope = { vaultId: newId(), revision: 0, ciphertext: "", iv: "", tag: "", ...recoveryWrapper };
      activeKey.current = vaultKey; activeEnvelope.current = initialEnvelope;
      setKey(vaultKey); setVault(initialVault); setEnvelope(initialEnvelope);
      setDriveBackup({ vaultId: initialEnvelope.vaultId, recoveryKey: code }); setSetup(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Passkey setup failed.";
      if (/previously registered|already registered/i.test(message)) {
        setNotice("This passkey is already registered. Use “Reset vault with saved passkey” if you want to permanently replace the old vault.");
      } else {
        setNotice(message);
      }
    } finally { setBusy(false); }
  };
  const verifyExistingPasskeyForReset = async (manageBusy = true) => {
    if (manageBusy) { setBusy(true); setNotice(""); }
    try {
      // Reset is an ordinary passkey authentication. It must not depend on the
      // optional PRF extension, which some password-manager passkeys omit.
      await requestPasskey("authentication");
      const remote = await fetchEnvelope();
      setResetCandidate({ replaceExisting: Boolean(remote), deletedVaultId: remote?.vaultId });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The saved passkey could not be verified.");
    } finally { if (manageBusy) setBusy(false); }
  };
  const confirmVaultReset = async () => {
    if (!resetCandidate) return;
    setBusy(true); setNotice("");
    try {
      const newVaultKey = await generateVaultKey();
      const code = recoveryKey();
      const recoveryWrapper = await wrapWithRecovery(newVaultKey, code);
      if (resetCandidate.replaceExisting) {
        const deleted = await fetch("/api/vault", { method: "DELETE" });
        if (!deleted.ok) throw new Error("The old vault could not be deleted. No new vault was created.");
        localStorage.removeItem(DEVICE_KEY);
        await forgetTrustedDeviceKey();
      }
      // A reset creates a distinct vault and recovery wrapper. A prior Drive
      // package must never be treated as a backup for it, even if the user
      // elects the manual-key fallback rather than replacing the Drive package.
      setDriveBackupStatus(resetCandidate.deletedVaultId ? "stale" : "unverified");
      setStaleDriveVaultId(resetCandidate.deletedVaultId ?? null);
      const trustedDevice = remember ? await rememberTrustedDevice(newVaultKey) : null;
      if (trustedDevice) localStorage.setItem(DEVICE_KEY, JSON.stringify(trustedDevice));
      const initialVault = createEmptyVault(); const initialEnvelope = { vaultId: newId(), revision: 0, ciphertext: "", iv: "", tag: "", ...recoveryWrapper };
      activeKey.current = newVaultKey; activeEnvelope.current = initialEnvelope;
      setKey(newVaultKey);
      setVault(initialVault);
      setEnvelope(initialEnvelope);
      setDriveBackup({ vaultId: initialEnvelope.vaultId, recoveryKey: code });
      setResetCandidate(null); setSetup(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to create the new vault.");
    } finally { setBusy(false); }
  };
  const save = async (nextVault: BudgetVault) => {
    pendingSave.current = nextVault;
    if (saveInFlight.current) return saveInFlight.current;
    const drain = async () => {
      // Coalesce high-frequency edits (especially the target sliders), but
      // persist each resulting revision in order. Every request therefore uses
      // the revision returned by the preceding successful write.
      while (pendingSave.current) {
        const vaultToSave = pendingSave.current;
        pendingSave.current = null;
        const currentKey = activeKey.current; const currentEnvelope = activeEnvelope.current;
        if (!currentKey || !currentEnvelope) return;
        const revision = currentEnvelope.revision + 1;
        const encrypted = await encryptVault(vaultToSave, currentKey, currentEnvelope.vaultId, revision);
        const response = await fetch("/api/vault", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...encrypted, vaultId: currentEnvelope.vaultId, revision, recoveryWrappedKey: currentEnvelope.recoveryWrappedKey, recoverySalt: currentEnvelope.recoverySalt }) });
        if (response.status === 409) {
          lock("Your vault changed on another device. Unlock again to safely reload it.");
          return;
        }
        if (!response.ok) throw new Error("Encrypted save failed. Your changes remain only in this browser.");
        // An explicit lock may have occurred while the request was in flight.
        // Never repopulate state after that lock with a late response.
        if (activeKey.current !== currentKey || activeEnvelope.current !== currentEnvelope) return;
        const savedEnvelope = { ...currentEnvelope, ...encrypted, revision };
        activeEnvelope.current = savedEnvelope;
        setEnvelope(savedEnvelope);
        setSavedVaultGeneration((generation) => generation + 1);
      }
    };
    const operation = drain();
    saveInFlight.current = operation;
    try { await operation; } finally { if (saveInFlight.current === operation) saveInFlight.current = null; }
  };
  const confirmCeremony = async () => {
    if (!key || !vault || !envelope || confirmRecovery.trim() !== createdRecovery) { setNotice("Enter the recovery key exactly as shown to verify it."); return; }
    // The first persisted revision must be written exactly once. Without this
    // guard, a quick double-click can submit revision 1 twice: one request
    // succeeds and the other correctly reports an optimistic-lock conflict.
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      await save(vault);
      setCreatedRecovery(""); setConfirmRecovery("");
      toast.current?.show({ severity: "success", summary: "Vault secured", detail: "Your encrypted budget vault is ready." });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save your encrypted vault.");
    } finally {
      setBusy(false);
    }
  };
  const completeDriveBackup = async () => {
    if (!driveBackup || !vault || !envelope || busy) return;
    setBusy(true); setNotice("");
    try {
      await saveDriveRecoveryBackup(driveBackup.vaultId, driveBackup.recoveryKey, beginDriveRecoveryAuthorization(email));
      const driveBackedVault = { ...vault, recoveryProvider: "google-drive" as const };
      await save(driveBackedVault);
      setVault(driveBackedVault);
      setDriveBackup(null); setDriveBackupStatus("verified"); setStaleDriveVaultId(null); setCreatedRecovery(""); setConfirmRecovery("");
      toast.current?.show({ severity: "success", summary: "Google Drive backup verified", detail: "Your encrypted budget is ready. Cipher Budget cannot access your Drive recovery secret." });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Google Drive backup could not be completed."); } finally { setBusy(false); }
  };
  const useManualBackup = () => {
    if (!driveBackup) return;
    setCreatedRecovery(driveBackup.recoveryKey); setDriveBackup(null); setShowManualRecovery(false); setNotice("");
  };
  const verifyDriveBackup = async () => {
    if (!envelope || busy) return; setBusy(true); setNotice("");
    try {
      const backup = await loadDriveRecoveryBackup({ prompt: "", loginHint: email });
      if (backup.vaultId !== envelope.vaultId) {
        setDriveBackupStatus("stale"); setStaleDriveVaultId(backup.vaultId);
        throw new Error("This Google Drive backup belongs to a deleted or different vault.");
      }
      await unwrapWithRecovery(backup.recoveryKey, envelope.recoverySalt!, envelope.recoveryWrappedKey!);
      setDriveBackupStatus("verified"); setStaleDriveVaultId(null);
      toast.current?.show({ severity: "success", summary: "Google Drive backup verified", detail: "This browser confirmed the backup can unlock your vault." });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Google Drive backup verification failed."); } finally { setBusy(false); }
  };
  const removeDriveBackup = async () => {
    if (!window.confirm("Remove the Google Drive recovery backup? You will need another recovery method before deleting it.")) return;
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      await removeDriveRecoveryBackup();
      if (vault) {
        const withoutDriveRecovery = { ...vault, recoveryProvider: undefined };
        await save(withoutDriveRecovery);
        setVault(withoutDriveRecovery);
      }
      setDriveBackupStatus("unverified"); setStaleDriveVaultId(null);
      toast.current?.show({ severity: "success", summary: "Google Drive backup removed", detail: "Your encrypted vault remains available on this browser." });
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "Google Drive backup could not be removed."); } finally { setBusy(false); }
  };
  const removeStaleDriveBackup = async () => {
    if (!staleDriveVaultId || busy) return;
    setBusy(true); setNotice("");
    try {
      const outcome = await removeDriveRecoveryBackup(staleDriveVaultId);
      setStaleDriveVaultId(null); setDriveBackupStatus("unverified");
      if (outcome === "removed") {
        toast.current?.show({ severity: "success", summary: "Old Google Drive backup removed", detail: "It belonged to the deleted vault. Your current vault is still not backed up to Google Drive." });
      } else if (outcome === "different-vault") {
        toast.current?.show({ severity: "info", summary: "No old backup removed", detail: "The Google Drive package belongs to a different vault and was left untouched." });
      } else {
        toast.current?.show({ severity: "info", summary: "No old backup found", detail: "Your current vault is still not backed up to Google Drive." });
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "The old Google Drive backup could not be removed. Your current vault remains usable."); } finally { setBusy(false); }
  };
  const moveRecoveryToDrive = async () => {
    if (!key || !vault || !envelope || busy) return;
    setBusy(true); setNotice("");
    let previousEnvelope: Envelope | null = null;
    try {
      // Begin the popup immediately from the button tap. The later vault-save
      // work is asynchronous and would otherwise lose Safari's activation.
      const driveAuthorization = beginDriveRecoveryAuthorization(email);
      // Finish an in-flight budget save before changing its recovery wrapper.
      // This keeps the optimistic revision sequence intact while a user moves
      // from a manual key to Drive recovery.
      if (saveInFlight.current) await saveInFlight.current;
      const currentKey = activeKey.current;
      const currentEnvelope = activeEnvelope.current;
      if (!currentKey || !currentEnvelope) throw new Error("Unlock your vault again before changing its recovery method.");
      previousEnvelope = currentEnvelope;

      const newRecoveryKey = recoveryKey();
      const newRecoveryWrapper = await wrapWithRecovery(currentKey, newRecoveryKey);

      // The secret travels directly from this browser to Google's hidden
      // app-data folder and is read back there before the server wrapper is
      // changed. The application API never receives the secret.
      await saveDriveRecoveryBackup(currentEnvelope.vaultId, newRecoveryKey, driveAuthorization);

      const driveEnvelope = { ...currentEnvelope, ...newRecoveryWrapper };
      activeEnvelope.current = driveEnvelope;
      setEnvelope(driveEnvelope);
      const driveBackedVault = { ...vault, recoveryProvider: "google-drive" as const };
      await save(driveBackedVault);

      // save() replaces the active envelope with its newly encrypted revision.
      // A conflict locks the vault instead, so never claim that the old manual
      // key was invalidated unless the new wrapper actually reached the vault.
      const savedEnvelope = activeEnvelope.current;
      if (!savedEnvelope || savedEnvelope.vaultId !== driveEnvelope.vaultId || savedEnvelope.revision !== driveEnvelope.revision + 1) {
        throw new Error("The vault changed before the recovery method could be updated. Your previous recovery key is still active; unlock it and try again.");
      }
      setVault(driveBackedVault);
      setDriveBackupStatus("verified"); setStaleDriveVaultId(null);
      setShowDriveMigration(false);
      toast.current?.show({ severity: "success", summary: "Google Drive recovery enabled", detail: "A new recovery secret was verified in Google Drive. Your previous manual recovery key can no longer unlock this vault." });
    } catch (error) {
      // If the encrypted-vault update failed after the Drive upload, restore
      // the still-valid server wrapper locally when the vault remains open.
      // The uploaded package is harmless until its matching wrapper is saved.
      if (previousEnvelope && activeKey.current && activeEnvelope.current?.vaultId === previousEnvelope.vaultId && activeEnvelope.current?.revision === previousEnvelope.revision) {
        activeEnvelope.current = previousEnvelope;
        setEnvelope(previousEnvelope);
      }
      setNotice(error instanceof Error ? error.message : "Google Drive recovery could not be enabled. Your existing recovery key is unchanged.");
    } finally { setBusy(false); }
  };
  const saveRecoveryKey = async () => {
    const text = "Cipher Budget recovery key\n\n" + createdRecovery + "\n";
    // Safari on iOS opens Blob downloads in a separate Downloads view. Leaving
    // that view can reload this page and clear the intentionally in-memory
    // vault setup. Its native share sheet keeps this ceremony in place.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isIOS && navigator.share) {
      try {
        await navigator.share({ title: "Cipher Budget recovery key", text });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      }
      return;
    }
    const blob = new Blob([text], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "cipher-budget-recovery-key.txt"; link.click(); URL.revokeObjectURL(link.href);
  };
  const rememberedDevice = browserReady ? deviceEnvelope() : null;
  const hasDevice = Boolean(rememberedDevice);
  // A verified Drive restore/migration is also persisted inside the encrypted
  // vault. Silent Google authorization may later be unavailable, but that
  // should not make a known Drive-backed vault look unbacked. A confirmed
  // stale package always wins and is never presented as a valid backup.
  const hasVerifiedDriveBackup = driveBackupStatus !== "stale" && (driveBackupStatus === "verified" || vault?.recoveryProvider === "google-drive");
  const automaticallyUnlocking = Boolean(!browserReady || autoUnlocking || (rememberedDevice?.kind === "trusted-device" && !vault && !setup && !createdRecovery && !driveBackup && !attemptedRememberedUnlock.current));

  return <main className="app-shell"><Toast ref={toast} />
    <header className="topbar"><div className="brand"><i className="pi pi-lock" /> <span>Cipher Budget</span></div><div className="signed-in-user">{image ? <img src={image} referrerPolicy="no-referrer" alt="" /> : <span className="profile-fallback" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span>}<span>{email}</span></div><div className="topbar-actions"><ThemeToggle /><Button text icon="pi pi-lock" label="Lock" onClick={() => lockAndForgetBrowser()} /><Button text icon="pi pi-sign-out" label="Sign out" onClick={onSignOut} /></div></header>
    {automaticallyUnlocking && <section className="unlock-card"><i className="pi pi-spin pi-spinner unlock-icon" /><h1>Opening your private budget</h1><p>Unlocking this remembered personal browser…</p></section>}
    {!vault && !setup && !createdRecovery && !driveBackup && !automaticallyUnlocking && <section className="unlock-card">
      <i className="pi pi-shield unlock-icon" />
      <h1>Unlock your private budget</h1>
      <p>Google confirms your identity. Your recovery backup stays in Google Drive, not with Cipher Budget.</p>
      {notice && <p className="error">{notice}</p>}
      {driveUnlockStatus === "no-vault" ? <Button label="Set up a new vault" icon="pi pi-plus" loading={busy} onClick={() => setSetup(true)} /> : <>
        <div className="recovery-unlock">
          <h2>{driveUnlockStatus === "connected" ? "Google Drive backup connected" : "Restore an existing vault"}</h2>
          {driveUnlockStatus === "checking" && <p className="form-help"><i className="pi pi-spin pi-spinner" aria-hidden="true" /> Checking your Google Drive recovery…</p>}
          {driveUnlockStatus === "connected" && <><p className="drive-connected"><i className="pi pi-check-circle" aria-hidden="true" /> Your existing Google Drive permission is ready. Unlock with your passkey—no second Google sign-in.</p><div className="remember-choice"><Checkbox inputId="remember-unlock" checked={remember} onChange={(event) => setRemember(Boolean(event.checked))} /><label htmlFor="remember-unlock">Remember this personal browser</label></div><Button label="Unlock vault" icon="pi pi-lock-open" loading={busy} onClick={() => void unlockPreparedDriveBackup()} /></>}
          {driveUnlockStatus === "connect-required" && <><p>Your Google Drive recovery is not connected in this browser yet.</p><div className="remember-choice"><Checkbox inputId="remember-unlock" checked={remember} onChange={(event) => setRemember(Boolean(event.checked))} /><label htmlFor="remember-unlock">Remember this personal browser</label></div><Button outlined label="Continue with Google Drive" icon="pi pi-google" loading={busy} disabled={!driveReady} onClick={() => void connectDriveAndUnlock()} /></>}
          {driveUnlockStatus === "missing-backup" && <p className="form-help">No Cipher Budget recovery backup was found in this Google Drive account. Use the correct Google account or a recovery key instead.</p>}
          {driveUnlockStatus === "stale-backup" && <p className="error">This Google Drive backup belongs to a deleted or different vault. It cannot unlock this vault.</p>}
          {driveUnlockStatus === "unavailable" && <p className="form-help">Google Drive recovery is unavailable in this browser right now. You can still use a recovery key.</p>}
          {hasDevice && driveUnlockStatus !== "connected" && <Button outlined label="Unlock remembered vault" icon="pi pi-key" loading={busy} onClick={() => void unlockRemembered()} />}
          {showManualUnlock ? <div className="advanced-recovery"><p>Use this only if Google Drive recovery is unavailable.</p><InputText value={recovery} onChange={(event) => setRecovery(event.target.value)} placeholder="Recovery key" autoComplete="off" /><Button text label="Recover with key" icon="pi pi-key" loading={busy} onClick={() => void unlockRecovery()} /></div> : <Button text className="advanced-link" label="Use a recovery key instead" onClick={() => setShowManualUnlock(true)} />}
        </div>
        <Button text label="Set up a replacement passkey and vault" icon="pi pi-plus" disabled={busy} onClick={() => setSetup(true)} />
      </>}
      {driveUnlockStatus !== "no-vault" && <Button text severity="danger" label="Reset vault with saved passkey" icon="pi pi-refresh" loading={busy} onClick={() => void verifyExistingPasskeyForReset()} />}
    </section>}
    {setup && <section className="unlock-card"><i className="pi pi-key unlock-icon" /><h1>Create your encrypted vault</h1><p>Set up a site passkey. It is required alongside Google sign-in to access your financial data.</p><div className="remember-choice"><Checkbox inputId="remember-setup" checked={remember} onChange={(event) => setRemember(Boolean(event.checked))} /><label htmlFor="remember-setup">Remember this personal browser</label></div><small>Only select this on a personal, device-encrypted browser profile. It stores an encrypted vault-key envelope locally and still requires your Google session; it never stores budget plaintext or the raw vault key.</small>{notice && <p className="error">{notice}</p>}<div className="button-row"><Button label="Create vault with new passkey" icon="pi pi-shield" loading={busy} onClick={startSetup} /><Button text label="Back" onClick={() => setSetup(false)} /></div></section>}
    {vault && !driveBackup && <><PayMonthBoard vault={vault} onChange={(next) => { setVault(next); void save(next).catch((error) => setNotice(error instanceof Error ? error.message : "Save failed")); }} /><section className="drive-backup-settings"><div><i className="pi pi-google" /><span><strong>{hasVerifiedDriveBackup ? "Google Drive recovery" : "Move recovery to Google Drive"}</strong><small>{hasVerifiedDriveBackup ? "Your recovery secret was verified directly in your hidden Google Drive app-data folder. Cipher Budget cannot read it." : "This vault is not backed up to Google Drive yet. Replace the recovery key with a newly generated Google Drive recovery secret."}</small></span></div><div className="data-tool-actions">{hasVerifiedDriveBackup ? <><Button outlined label="Verify backup" icon="pi pi-check-circle" loading={busy} disabled={!driveReady} onClick={() => void verifyDriveBackup()} /><Button text severity="danger" label="Remove backup" icon="pi pi-trash" loading={busy} disabled={!driveReady} onClick={() => void removeDriveBackup()} /></> : <Button label="Use Google Drive recovery" icon="pi pi-google" loading={busy} disabled={!driveReady} onClick={() => { setNotice(""); setShowDriveMigration(true); }} />}</div>{notice && <p className="transfer-status" role="status">{notice}</p>}</section><DriveSpreadsheetBackup vault={vault} email={email} driveReady={driveReady} saveGeneration={savedVaultGeneration} onChange={(next) => { setVault(next); void save(next).catch((error) => setNotice(error instanceof Error ? error.message : "Save failed")); }} onBackupSuccess={(result: SpreadsheetBackupResult) => { setVault((current) => { if (!current?.spreadsheetBackup?.enabled) return current; const next = { ...current, spreadsheetBackup: { ...current.spreadsheetBackup, folderId: result.folderId, lastSuccessfulDate: result.backupDate, lastBackupFileId: result.fileId, lastBackupAt: result.backedUpAt } }; void save(next).catch((error) => setNotice(error instanceof Error ? error.message : "Backup status could not be saved.")); return next; }); }} />{driveBackupStatus === "stale" && staleDriveVaultId && <section className="drive-backup-settings stale-drive-backup"><div><i className="pi pi-exclamation-triangle" /><span><strong>Old Google Drive backup</strong><small>A recovery package for the deleted vault may remain in Google Drive. It cannot unlock this vault and this vault is not backed up there.</small></span></div><div className="data-tool-actions"><Button outlined severity="secondary" label="Check and remove old backup" icon="pi pi-trash" loading={busy} disabled={!driveReady} onClick={() => void removeStaleDriveBackup()} /></div></section>}</>}
    <Dialog visible={Boolean(driveBackup)} modal closable={false} dismissableMask={false} header="Back up your private budget" className="recovery-dialog" onHide={() => { }}><h2 className="dialog-question">Why do we need access to your Google Drive?</h2><p>We&apos;re storing the key that unlocks your data with you, not with us. That&apos;s what makes your data private from us. We can only access the key we store, not any other files in your Drive.</p><p className="form-help">Google Drive recovery is the recommended way to keep your budget available without managing a recovery key yourself.</p>{!driveReady && <p className="form-help">Preparing secure Google Drive access…</p>}{notice && <p className="error">{notice}</p>}<div className="button-row"><Button label="Back up securely to Google Drive" icon="pi pi-google" loading={busy} disabled={!driveReady} onClick={() => void completeDriveBackup()} /><Button text className="advanced-link" label="Can’t use Google Drive?" disabled={busy} onClick={() => setShowManualRecovery(true)} /></div><Dialog visible={showManualRecovery} modal header="Use a manual recovery key?" onHide={() => setShowManualRecovery(false)}><p>This advanced option is for people who cannot use Google Drive. You will need to save and verify a long recovery key yourself before the budget can be used.</p><div className="button-row"><Button outlined label="Use manual recovery key" icon="pi pi-key" onClick={useManualBackup} /><Button text label="Back to Google Drive" onClick={() => setShowManualRecovery(false)} /></div></Dialog></Dialog>
    <Dialog visible={showDriveMigration} modal closable={!busy} dismissableMask={!busy} header="Move recovery to Google Drive" className="recovery-dialog" onHide={() => { if (!busy) setShowDriveMigration(false); }}><p>We will generate a completely new recovery secret in this browser, store it directly in your selected Google Drive account, and read it back to verify it.</p><p className="danger-copy">After verification and the encrypted vault update succeed, your current manual recovery key will no longer unlock this vault. Any existing Cipher Budget recovery backup in the selected Google Drive account will be replaced.</p><p className="form-help">Cipher Budget never receives the Google Drive token or either recovery secret.</p>{!driveReady && <p className="form-help">Preparing secure Google Drive access…</p>}{notice && <p className="error">{notice}</p>}<div className="button-row"><Button label="Create Google Drive recovery" icon="pi pi-google" loading={busy} disabled={!driveReady} onClick={() => void moveRecoveryToDrive()} /><Button text label="Cancel" disabled={busy} onClick={() => setShowDriveMigration(false)} /></div></Dialog>
    <Dialog visible={Boolean(resetCandidate)} modal closable={!busy} dismissableMask={false} header={resetCandidate?.replaceExisting ? "Permanently replace encrypted vault?" : "Create a new vault?"} className="recovery-dialog" onHide={() => { if (!busy) setResetCandidate(null); }}><p className="danger-copy">{resetCandidate?.replaceExisting ? "You cannot unlock the existing vault with this passkey alone. Continuing permanently deletes its encrypted ciphertext. Even if you find the old recovery backup later, the old budget data cannot be recovered." : "No existing encrypted vault was found. Continuing creates a new empty vault with your verified passkey."}</p><p>You will back up the new vault to Google Drive before it can be used.</p>{notice && <p className="error">{notice}</p>}<div className="button-row"><Button severity="danger" label={resetCandidate?.replaceExisting ? "Delete old vault and create new" : "Create new vault"} icon="pi pi-exclamation-triangle" loading={busy} onClick={confirmVaultReset} /><Button text label="Cancel" disabled={busy} onClick={() => setResetCandidate(null)} /></div></Dialog>
    <Dialog visible={Boolean(createdRecovery)} modal closable={false} dismissableMask={false} header="Record your recovery key" className="recovery-dialog" onHide={() => setShowAbandon(true)}><p className="danger-copy">This recovery key is the only backup if you lose your passkey. If you do not record it, you WILL permanently lose access to all your budget data. After this screen is closed, it is never accessible or recoverable by anyone again.</p><code className="recovery-code">{createdRecovery}</code><div className="button-row"><Button text label="Copy" icon="pi pi-copy" onClick={() => navigator.clipboard.writeText(createdRecovery)} /><Button text label="Print" icon="pi pi-print" onClick={() => window.print()} /><Button text label="Save text" icon="pi pi-download" onClick={() => void saveRecoveryKey()} /></div><p>Store it in a password manager or another secure offline location. Do not share it or keep it in unsecured notes.</p><label htmlFor="confirm-recovery">Enter the complete recovery key to verify you recorded it.</label><InputText id="confirm-recovery" value={confirmRecovery} onChange={(event) => setConfirmRecovery(event.target.value)} autoComplete="off" className="full-width" />{notice && <p className="error">{notice}</p>}<Button label="I recorded it — secure my vault" icon="pi pi-check" loading={busy} disabled={busy} onClick={confirmCeremony} /><Button text severity="secondary" label="I need more time" disabled={busy} onClick={() => setShowAbandon(true)} /><Dialog visible={showAbandon} modal header="Leave vault setup?" onHide={() => setShowAbandon(false)}><p>If you leave without recording and verifying this key, all newly created encrypted vault data will be discarded. You will need to set up a new vault later.</p><Button severity="danger" label="Discard unverified vault" onClick={() => { setCreatedRecovery(""); setConfirmRecovery(""); setShowAbandon(false); lock("Vault setup was abandoned. No financial data was saved."); }} /></Dialog></Dialog>
  </main>;
}

function PayMonthBoard({ vault, onChange }: { vault: BudgetVault; onChange: (vault: BudgetVault) => void }) {
  const [activeId, setActiveId] = useState(vault.payMonths.at(-1)?.id ?? ""); const [firstStart, setFirstStart] = useState(todayISO()); const [editStart, setEditStart] = useState(""); const [dialog, setDialog] = useState<"edit" | null>(null); const [showPayMonthInfo, setShowPayMonthInfo] = useState(false); const [transferBusy, setTransferBusy] = useState(false); const [transferStatus, setTransferStatus] = useState(""); const importInput = useRef<HTMLInputElement>(null);
  const month = vault.payMonths.find((item) => item.id === activeId) ?? vault.payMonths.at(-1);
  useEffect(() => { if (!vault.payMonths.some((item) => item.id === activeId)) setActiveId(vault.payMonths.at(-1)?.id ?? ""); }, [activeId, vault.payMonths]);
  const updateMonth = (next: PayMonth) => onChange({ ...vault, payMonths: vault.payMonths.map((item) => item.id === next.id ? next : item) });
  const addMonth = () => { const previous = vault.payMonths.at(-1); const start = previous ? addDays(previous.endDate, 1) : firstStart; const next = clonePayMonth(previous, start, vault.settings.defaultTargets, vault.recurringExpenses); onChange({ ...vault, payMonths: [...vault.payMonths, next] }); setActiveId(next.id); };
  const deleteMonth = () => { if (!month || !window.confirm("Delete this pay-month budget and all of its entries? This cannot be undone.")) return; const index = vault.payMonths.findIndex((item) => item.id === month.id); const remaining = vault.payMonths.filter((item) => item.id !== month.id); onChange({ ...vault, payMonths: remaining }); setActiveId(remaining[Math.max(0, index - 1)]?.id ?? ""); setDialog(null); };
  const exportSpreadsheet = async () => { setTransferBusy(true); setTransferStatus(""); try { const bytes = await budgetWorkbook(vault); const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })); const link = document.createElement("a"); link.href = url; link.download = "cipher-budget-export.xlsx"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); setTransferStatus("Spreadsheet exported. It contains readable financial data—store it securely."); } catch (error) { setTransferStatus(error instanceof Error ? error.message : "Could not export the spreadsheet."); } finally { setTransferBusy(false); } };
  const importSpreadsheet = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !window.confirm("Importing replaces all current pay-month budgets, income, expenses, and recurring monthly expenses. Continue?")) return; setTransferBusy(true); setTransferStatus(""); try { const imported = await importBudgetWorkbook(file); onChange({ ...imported, recoveryProvider: vault.recoveryProvider, spreadsheetBackup: vault.spreadsheetBackup }); setActiveId(imported.payMonths.at(-1)?.id ?? ""); setTransferStatus("Spreadsheet imported. Your encrypted vault is saving the imported budget."); } catch (error) { setTransferStatus(error instanceof Error ? error.message : "Could not import the spreadsheet."); } finally { setTransferBusy(false); } };
  if (!month) return <section className="empty-state"><h1>Start your first pay-month budget</h1><p>Choose the first day. Your budget will cover 28 days.</p><label className="field-label" htmlFor="first-pay-month-start">First budget start date</label><input id="first-pay-month-start" className="native-input" type="date" value={firstStart} onChange={(event) => setFirstStart(event.target.value)} /><Button label="Create pay-month budget" icon="pi pi-calendar-plus" onClick={addMonth} /></section>;
  const values = totals(month);
  return <section className="budget-board">
    <div className="period-toolbar"><div><div className="pay-month-label"><p className="eyebrow">PAY-MONTH <button type="button" className="pay-month-info" aria-expanded={showPayMonthInfo} aria-controls="pay-month-explainer" aria-label="What is a pay-month?" onClick={() => setShowPayMonthInfo((shown) => !shown)}><i className="pi pi-info-circle" /></button></p>{showPayMonthInfo && <p id="pay-month-explainer" className="pay-month-explainer" role="status">A pay-month is two biweekly paychecks totaling 28 days.</p>}</div><h1>{periodLabel(month)}</h1></div><div className="period-actions"><select aria-label="Choose pay-month budget" value={month.id} onChange={(event) => setActiveId(event.target.value)}>{vault.payMonths.map((item) => <option key={item.id} value={item.id}>{periodLabel(item)}</option>)}</select><Button label="New pay-month budget" icon="pi pi-plus" onClick={addMonth} /><Button className="manage-period" text rounded aria-label="Edit pay-month budget" tooltip="Edit pay-month budget" tooltipOptions={{ position: "top" }} icon="pi pi-pencil" onClick={() => { setEditStart(month.startDate); setDialog("edit"); }} /></div></div>
    <div className="summary-grid"><Summary label="Pay-month income" value={money(values.income)} icon="pi pi-wallet" /><Summary label="Pay-month expenses" value={money(values.expenses)} icon="pi pi-credit-card" /><Summary label="Pay-month balance" value={money(values.remaining)} icon="pi pi-chart-line" tone={values.remaining < 0 ? "negative" : "positive"} /></div>
    <div className="bucket-grid">{(Object.keys(bucketMeta) as Bucket[]).map((bucket) => <PayMonthBucketPanel key={bucket} bucket={bucket} vault={vault} month={month} income={values.income} spent={values.byBucket(bucket)} onChange={onChange} />)}</div>
    <PayMonthIncomePanel month={month} onChange={updateMonth} />
    <section className="data-tools"><div><i className="pi pi-file-excel" /><span><strong>Spreadsheet backup & import</strong><small>Exports are readable .xlsx files and are not encrypted. Import only a Cipher Budget workbook you trust; importing replaces this vault’s current budget data.</small></span></div><div className="data-tool-actions"><Button outlined label="Export spreadsheet" icon="pi pi-download" loading={transferBusy} onClick={() => void exportSpreadsheet()} /><Button outlined label="Import spreadsheet" icon="pi pi-upload" disabled={transferBusy} onClick={() => importInput.current?.click()} /><input ref={importInput} className="visually-hidden" type="file" accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx" onChange={(event) => void importSpreadsheet(event)} /></div>{transferStatus && <p className="transfer-status" role="status">{transferStatus}</p>}</section>
    <section className="security-settings"><div><i className="pi pi-shield" /><span><strong>Encrypted vault is unlocked</strong><small>Financial data is decrypted only in this browser until it locks.</small></span></div></section>
    <Dialog visible={dialog === "edit"} modal header="Edit pay-month budget" className="compact-dialog" onHide={() => setDialog(null)}><p>Changing the start date keeps this budget at 28 days.</p><label className="field-label" htmlFor="edit-pay-month-start">Budget start date</label><input className="native-input" id="edit-pay-month-start" type="date" value={editStart} onChange={(event) => setEditStart(event.target.value)} /><div className="dialog-actions"><Button label="Save budget" icon="pi pi-check" onClick={() => { if (editStart) { updateMonth({ ...month, startDate: editStart, endDate: addDays(editStart, 27) }); setDialog(null); } }} /><Button text label="Cancel" onClick={() => setDialog(null)} /><Button outlined severity="danger" label="Delete budget" icon="pi pi-trash" onClick={deleteMonth} /></div></Dialog>
  </section>;
}

function PayMonthIncomePanel({ month, onChange }: { month: PayMonth; onChange: (month: PayMonth) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [editing, setEditing] = useState<IncomeEntry | null>(null); const [error, setError] = useState(""); const [open, setOpen] = useState(false);
  const clear = () => { setName(""); setAmount(null); setEditing(null); setError(""); };
  const submit = () => { if (!name.trim() || !amount || amount <= 0) { setError("Enter an income source and a positive amount."); return; } const entry: IncomeEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100) }; onChange({ ...month, incomes: editing ? month.incomes.map((item) => item.id === editing.id ? entry : item) : [...month.incomes, entry] }); clear(); };
  const editIncome = (income?: IncomeEntry) => { if (income) { setEditing(income); setName(income.name); setAmount(income.amountCents / 100); setError(""); } else { clear(); } setOpen(true); };
  const close = () => { setOpen(false); clear(); };
  const total = month.incomes.reduce((sum, income) => sum + income.amountCents, 0);
  return <><Card className="income-panel income-panel-compact"><div className="income-summary"><div><span>Income</span><strong>{money(total)}</strong><small>{month.incomes.length ? `${month.incomes.length} ${month.incomes.length === 1 ? "source" : "sources"}` : "No income sources"}</small></div><Button text rounded icon="pi pi-pencil" aria-label="Edit income" tooltip="Edit income" tooltipOptions={{ position: "top" }} onClick={() => editIncome()} /></div></Card><Dialog visible={open} modal header="Income" className="compact-dialog income-dialog" onHide={close}><p>All income in this pay-month budget is included in your totals.</p><div className="entry-form income-form"><div className="field"><label htmlFor="pay-month-income-name">Income source</label><InputText id="pay-month-income-name" value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="e.g. Paycheck" /></div><div className="field"><label htmlFor="pay-month-income-amount">Amount</label><InputNumber inputId="pay-month-income-amount" value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="form-buttons"><Button label={editing ? "Save income" : "Add income"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete income" icon="pi pi-trash" onClick={() => { if (window.confirm("Delete this income entry? This cannot be undone.")) { onChange({ ...month, incomes: month.incomes.filter((item) => item.id !== editing.id) }); clear(); } }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<PayMonthEntryList entries={month.incomes} onEdit={editIncome} /></Dialog></>;
}

function PayMonthBucketPanel({ bucket, vault, month, income, spent, onChange }: { bucket: Bucket; vault: BudgetVault; month: PayMonth; income: number; spent: number; onChange: (vault: BudgetVault) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [date, setDate] = useState(todayISO()); const [recurring, setRecurring] = useState(false); const [editing, setEditing] = useState<ExpenseEntry | null>(null); const [error, setError] = useState(""); const target = Math.round(income * month.targetPercentages[bucket] / 100); const remaining = target - spent; const expenses = month.expenses.filter((item) => item.bucket === bucket);
  const clear = () => { setName(""); setAmount(null); setDate(todayISO()); setRecurring(false); setEditing(null); setError(""); };
  const replaceMonth = (next: PayMonth, recurringExpenses = vault.recurringExpenses) => onChange({ ...vault, recurringExpenses, payMonths: vault.payMonths.map((item) => item.id === next.id ? next : item) });
  const submit = () => {
    if (!name.trim() || !amount || amount <= 0) { setError("Enter an expense name and a positive amount before saving."); return; }
    if (recurring && !date) { setError("Choose a date for a recurring monthly expense."); return; }
    if (date && (date < month.startDate || date > month.endDate)) { setError("Choose a date inside this 28-day pay-month budget, or leave it blank."); return; }
    const templateId = recurring ? editing?.templateId ?? newId() : undefined;
    const entry: ExpenseEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100), bucket, ...(date ? { date } : {}), ...(templateId ? { templateId } : {}) };
    const templates = editing?.templateId && !recurring ? vault.recurringExpenses.filter((item) => item.id !== editing.templateId) : recurring ? [...vault.recurringExpenses.filter((item) => item.id !== templateId), { id: templateId!, name: entry.name, amountCents: entry.amountCents, bucket, dueDay: Number(date.slice(8, 10)), active: true }] : vault.recurringExpenses;
    replaceMonth({ ...month, expenses: editing ? month.expenses.map((item) => item.id === editing.id ? entry : item) : [...month.expenses, entry] }, templates); clear();
  };
  const deleteExpense = () => { if (!editing || !window.confirm("Delete this expense occurrence? This cannot be undone.")) return; let templates = vault.recurringExpenses; if (editing.templateId && window.confirm("Also stop this expense from recurring in future pay-month budgets? Choose Cancel to delete this occurrence only.")) templates = templates.filter((item) => item.id !== editing.templateId); replaceMonth({ ...month, expenses: month.expenses.filter((item) => item.id !== editing.id) }, templates); clear(); };
  const nameId = `${bucket}-pay-month-expense-name`; const amountId = `${bucket}-pay-month-expense-amount`; const dateId = `${bucket}-pay-month-expense-date`;
  return <Card className={`bucket-card ${bucket}`}><div className="bucket-header"><div><p>{bucketMeta[bucket].label}</p><strong>{money(remaining)} <small>remaining</small></strong></div><div className="target-input"><label htmlFor={`${bucket}-pay-month-target`}>Pay-month target</label><InputNumber inputId={`${bucket}-pay-month-target`} value={month.targetPercentages[bucket]} min={0} max={100} maxFractionDigits={2} useGrouping={false} suffix="%" onValueChange={(event) => replaceMonth({ ...month, targetPercentages: { ...month.targetPercentages, [bucket]: Math.min(100, Math.max(0, event.value ?? 0)) } })} /></div></div><ProgressBar value={target ? Math.min(100, Math.round(spent / target * 100)) : 0} showValue={false} /><p className={remaining < 0 ? "over" : "muted"}>{money(spent)} spent of {money(target)}</p><div className="entry-form expense-form"><div className="field"><label htmlFor={nameId}>Expense name</label><InputText id={nameId} value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder={expenseHints[bucket]} /></div><div className="expense-details"><div className="field"><label htmlFor={amountId}>Amount</label><InputNumber inputId={amountId} value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="field expense-date-field"><label htmlFor={dateId}>Date {recurring ? "" : <span className="optional-label">(optional)</span>}</label><input className="native-input" id={dateId} type="date" min={month.startDate} max={month.endDate} value={date} onChange={(event) => { setDate(event.target.value); setError(""); }} /></div></div><div className="remember-choice recurring-choice"><Checkbox inputId={`${bucket}-recurring`} checked={recurring} onChange={(event) => { setRecurring(Boolean(event.checked)); setError(""); }} /><label htmlFor={`${bucket}-recurring`}>Recurring monthly</label></div><div className="form-buttons"><Button label={editing ? "Save expense" : "Add expense"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete expense" icon="pi pi-trash" onClick={deleteExpense} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<PayMonthExpenseList entries={expenses} onEdit={(expense) => { setEditing(expense); setName(expense.name); setAmount(expense.amountCents / 100); setDate(expense.date ?? ""); setRecurring(Boolean(expense.templateId)); setError(""); }} /></Card>;
}

function PayMonthEntryList({ entries, onEdit }: { entries: IncomeEntry[]; onEdit: (entry: IncomeEntry) => void }) { if (!entries.length) return <p className="empty-list">No entries yet.</p>; return <ul className="entry-list">{entries.map((item) => <li key={item.id}><div className="entry-details"><span>{item.name}</span>{item.date && <small>{displayDate(item.date)}</small>}</div><strong>{money(item.amountCents)}</strong><button type="button" className="manage-entry" aria-label={`Edit ${item.name}`} onClick={() => onEdit(item)}><i className="pi pi-pencil" /></button></li>)}</ul>; }
function PayMonthExpenseList({ entries, onEdit }: { entries: ExpenseEntry[]; onEdit: (entry: ExpenseEntry) => void }) { if (!entries.length) return <p className="empty-list">No entries yet.</p>; return <ul className="entry-list">{entries.map((item) => <li key={item.id}><div className="entry-details"><span>{item.name}{item.templateId && <i className="pi pi-sync recurring active" title="Recurring monthly expense" />}</span>{item.date && <small>{displayDate(item.date)}</small>}</div><strong>{money(item.amountCents)}</strong><button type="button" className="manage-entry" aria-label={`Edit ${item.name}`} onClick={() => onEdit(item)}><i className="pi pi-pencil" /></button></li>)}</ul>; }

function LegacyBudgetBoard({ vault, onChange }: { vault: LegacyBudgetVault; onChange: (vault: LegacyBudgetVault) => void }) {
  const [activeId, setActiveId] = useState(vault.periods.at(-1)?.id ?? "");
  const [firstStart, setFirstStart] = useState(todayISO());
  const [editStart, setEditStart] = useState("");
  const [dialog, setDialog] = useState<"edit" | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferStatus, setTransferStatus] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const period = vault.periods.find((item) => item.id === activeId) ?? vault.periods.at(-1);
  useEffect(() => { if (!vault.periods.some((item) => item.id === activeId)) setActiveId(vault.periods.at(-1)?.id ?? ""); }, [activeId, vault.periods]);
  const updatePeriod = (next: LegacyBudgetPeriod) => onChange({ ...vault, periods: vault.periods.map((item) => item.id === next.id ? next : item) });
  const addPeriod = () => {
    const previous = vault.periods.at(-1);
    const start = previous ? addDays(previous.endDate, 1) : firstStart;
    const next = clonePeriod(previous, start, vault.settings.defaultTargets);
    onChange({ ...vault, periods: [...vault.periods, next] }); setActiveId(next.id);
  };
  if (!period) return <section className="empty-state"><h1>Start your first pay period</h1><p>Choose the first day of your 14-day period. Future periods automatically begin the day after the previous one ends.</p><label className="field-label" htmlFor="first-period-start">First period start date</label><input id="first-period-start" type="date" value={firstStart} onChange={(event) => setFirstStart(event.target.value)} /><Button label="Create pay period" icon="pi pi-calendar-plus" onClick={addPeriod} /></section>;
  const values = totals(period);
  const deletePeriod = () => {
    if (!window.confirm("Delete this pay period and every income and expense in it? This cannot be undone.")) return;
    const index = vault.periods.findIndex((item) => item.id === period.id);
    const remaining = vault.periods.filter((item) => item.id !== period.id);
    onChange({ ...vault, periods: remaining }); setActiveId(remaining[Math.max(0, index - 1)]?.id ?? ""); setDialog(null);
  };
  const exportSpreadsheet = async () => {
    setTransferBusy(true); setTransferStatus("");
    try {
      const bytes = await budgetWorkbook(vault as unknown as BudgetVault);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a");
      link.href = url; link.download = "cipher-budget-export.xlsx"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setTransferStatus("Spreadsheet exported. It contains readable financial data—store it securely.");
    } catch (error) {
      setTransferStatus(error instanceof Error ? error.message : "Could not export the spreadsheet.");
    } finally { setTransferBusy(false); }
  };
  const importSpreadsheet = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!window.confirm("Importing replaces all current budget periods and entries with this spreadsheet. Continue?")) return;
    setTransferBusy(true); setTransferStatus("");
    try {
      const imported = await importBudgetWorkbook(file);
      const legacy = imported as unknown as LegacyBudgetVault;
      onChange(legacy);
      setActiveId(legacy.periods.at(-1)?.id ?? "");
      setTransferStatus("Spreadsheet imported. Your encrypted vault is saving the imported budget.");
    } catch (error) {
      setTransferStatus(error instanceof Error ? error.message : "Could not import the spreadsheet.");
    } finally { setTransferBusy(false); }
  };
  return <section className="budget-board">
    <div className="period-toolbar"><div><p className="eyebrow">PAY PERIOD</p><h1>{periodLabel(period)}</h1></div><div className="period-actions"><select aria-label="Choose pay period" value={period.id} onChange={(event) => setActiveId(event.target.value)}>{vault.periods.map((item) => <option key={item.id} value={item.id}>{periodLabel(item)}</option>)}</select><Button label="New period" icon="pi pi-plus" onClick={addPeriod} /><Button className="manage-period" text rounded aria-label="Edit pay period" tooltip="Edit pay period" tooltipOptions={{ position: "top" }} icon="pi pi-pencil" onClick={() => { setEditStart(period.startDate); setDialog("edit"); }} /></div></div>
    <div className="summary-grid"><Summary label="Total income" value={money(values.income)} icon="pi pi-wallet" /><Summary label="Total expenses" value={money(values.expenses)} icon="pi pi-credit-card" /><Summary label="Remaining balance" value={money(values.remaining)} icon="pi pi-chart-line" tone={values.remaining < 0 ? "negative" : "positive"} /></div>
    <LegacyIncomePanel period={period} onChange={updatePeriod} />
    <div className="bucket-grid">{(Object.keys(bucketMeta) as Bucket[]).map((bucket) => <LegacyBucketPanel key={bucket} bucket={bucket} period={period} income={values.income} spent={values.byBucket(bucket)} onChange={updatePeriod} />)}</div>
    <section className="data-tools"><div><i className="pi pi-file-excel" /><span><strong>Spreadsheet backup & import</strong><small>Exports are readable .xlsx files and are not encrypted. Import only a Cipher Budget workbook you trust; importing replaces this vault’s current budget data.</small></span></div><div className="data-tool-actions"><Button outlined label="Export spreadsheet" icon="pi pi-download" loading={transferBusy} onClick={() => void exportSpreadsheet()} /><Button outlined label="Import spreadsheet" icon="pi pi-upload" disabled={transferBusy} onClick={() => importInput.current?.click()} /><input ref={importInput} className="visually-hidden" type="file" accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx" onChange={(event) => void importSpreadsheet(event)} /></div>{transferStatus && <p className="transfer-status" role="status">{transferStatus}</p>}</section>
    <section className="security-settings"><div><i className="pi pi-shield" /><span><strong>Encrypted vault is unlocked</strong><small>Financial data is decrypted only in this browser until it locks.</small></span></div></section>
    <Dialog visible={dialog === "edit"} modal header="Edit pay period" className="compact-dialog" onHide={() => setDialog(null)}><p>Changing the start date automatically keeps this pay period 14 days long.</p><label className="field-label" htmlFor="edit-period-start">Start date</label><input className="native-input" id="edit-period-start" type="date" value={editStart} onChange={(event) => setEditStart(event.target.value)} /><div className="dialog-actions"><Button label="Save period" icon="pi pi-check" onClick={() => { if (editStart) updatePeriod({ ...period, startDate: editStart, endDate: addDays(editStart, 13) }); setDialog(null); }} /><Button text label="Cancel" onClick={() => setDialog(null)} /><Button outlined severity="danger" label="Delete period" icon="pi pi-trash" onClick={deletePeriod} /></div></Dialog>
  </section>;
}
function Summary({ label, value, icon, tone }: { label: string; value: string; icon: string; tone?: string }) { return <Card className={"summary-card " + (tone ?? "")}><i className={icon} /><span>{label}</span><strong>{value}</strong></Card>; }

function LegacyIncomePanel({ period, onChange }: { period: LegacyBudgetPeriod; onChange: (period: LegacyBudgetPeriod) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [editing, setEditing] = useState<IncomeEntry | null>(null); const [error, setError] = useState("");
  const clear = () => { setName(""); setAmount(null); setEditing(null); setError(""); };
  const submit = () => {
    if (!name.trim() || !amount || amount <= 0) { setError(!name.trim() && (!amount || amount <= 0) ? "Enter an income source and a positive amount." : !name.trim() ? "Enter an income source." : "Enter an amount greater than $0.00."); return; }
    const entry: IncomeEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100) };
    onChange({ ...period, incomes: editing ? period.incomes.map((item) => item.id === editing.id ? entry : item) : [...period.incomes, entry] }); clear();
  };
  return <Card className="income-panel" title="Income"><p className="form-help">Add each source of income for this pay period.</p><div className="entry-form income-form"><div className="field"><label htmlFor="income-name">Income source</label><InputText id="income-name" value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="e.g. Paycheck" /></div><div className="field"><label htmlFor="income-amount">Amount</label><InputNumber inputId="income-amount" value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="form-buttons"><Button label={editing ? "Save income" : "Add income"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete income" icon="pi pi-trash" onClick={() => { if (!window.confirm("Delete this income entry? This cannot be undone.")) return; onChange({ ...period, incomes: period.incomes.filter((item) => item.id !== editing.id) }); clear(); }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<EntryList entries={period.incomes} onEdit={(item) => { setEditing(item as IncomeEntry); setName(item.name); setAmount(item.amountCents / 100); setError(""); }} /></Card>;
}

function LegacyBucketPanel({ bucket, period, income, spent, onChange }: { bucket: Bucket; period: LegacyBudgetPeriod; income: number; spent: number; onChange: (period: LegacyBudgetPeriod) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [date, setDate] = useState(todayISO()); const [editing, setEditing] = useState<LegacyExpenseEntry | null>(null); const [error, setError] = useState("");
  const target = Math.round(income * period.targetPercentages[bucket] / 100); const remaining = target - spent; const expenses = period.expenses.filter((item) => item.bucket === bucket);
  const clear = () => { setName(""); setAmount(null); setDate(todayISO()); setEditing(null); setError(""); };
  const submit = () => {
    if (!name.trim() || !amount || amount <= 0) { setError("Enter an expense name and a positive amount before saving."); return; }
    const entry: LegacyExpenseEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100), date: date || undefined, bucket, recurring: editing?.recurring ?? false };
    onChange({ ...period, expenses: editing ? period.expenses.map((item) => item.id === editing.id ? entry : item) : [...period.expenses, entry] }); clear();
  };
  const nameId = bucket + "-expense-name"; const amountId = bucket + "-expense-amount"; const dateId = bucket + "-expense-date";
  return <Card className={"bucket-card " + bucket}><div className="bucket-header"><div><p>{bucketMeta[bucket].label}</p><strong>{money(remaining)} <small>remaining</small></strong></div><div className="target-input"><label htmlFor={bucket + "-target"}>Target</label><InputNumber inputId={bucket + "-target"} value={period.targetPercentages[bucket]} min={0} max={100} maxFractionDigits={2} useGrouping={false} suffix="%" onValueChange={(event) => onChange({ ...period, targetPercentages: { ...period.targetPercentages, [bucket]: Math.min(100, Math.max(0, event.value ?? 0)) } })} /></div></div><ProgressBar value={target ? Math.min(100, Math.round(spent / target * 100)) : 0} showValue={false} /><p className={remaining < 0 ? "over" : "muted"}>{money(spent)} spent of {money(target)}</p><div className="entry-form expense-form"><div className="field"><label htmlFor={nameId}>Expense name</label><InputText id={nameId} value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder={expenseHints[bucket]} /></div><div className="expense-details"><div className="field"><label htmlFor={amountId}>Amount</label><InputNumber inputId={amountId} value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="field expense-date-field"><label htmlFor={dateId}>Date <span className="optional-label">(optional)</span></label><input className="native-input" id={dateId} type="date" value={date} onChange={(event) => { setDate(event.target.value); setError(""); }} /></div></div><div className="form-buttons"><Button label={editing ? "Save expense" : "Add expense"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete expense" icon="pi pi-trash" onClick={() => { if (!window.confirm("Delete this expense? This cannot be undone.")) return; onChange({ ...period, expenses: period.expenses.filter((item) => item.id !== editing.id) }); clear(); }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<EntryList entries={expenses} onEdit={(item) => { const expense = item as LegacyExpenseEntry; setEditing(expense); setName(expense.name); setAmount(expense.amountCents / 100); setDate(expense.date ?? ""); setError(""); }} onToggle={(id) => onChange({ ...period, expenses: period.expenses.map((item) => item.id === id ? { ...item, recurring: !item.recurring } : item) })} /></Card>;
}

function EntryList({ entries, onEdit, onToggle }: { entries: ListEntry[]; onEdit: (item: ListEntry) => void; onToggle?: (id: string) => void }) {
  if (!entries.length) return <p className="empty-list">No entries yet.</p>;
  return <ul className="entry-list">{entries.map((item) => <li key={item.id}><div className="entry-details"><span>{item.name}</span>{(item.date || onToggle) && <small>{item.date && displayDate(item.date)}{item.date && onToggle && " · "}{onToggle && <button type="button" className={item.recurring ? "recurring active" : "recurring"} onClick={() => onToggle(item.id)}><i className="pi pi-sync" /> {item.recurring ? "Recurring" : "One time"}</button>}</small>}</div><strong>{money(item.amountCents)}</strong><button type="button" className="manage-entry" aria-label={"Edit " + item.name} title={"Edit " + item.name} onClick={() => onEdit(item)}><i className="pi pi-pencil" /></button></li>)}</ul>;
}

/* Retired v2 workspace retained only as source-history context while encrypted v2 vaults migrate locally. */
function BudgetCycleBoard({ vault, onChange, migrationCandidates, onDismissMigration }: { vault: V2BudgetVault; onChange: (vault: V2BudgetVault) => void; migrationCandidates: RecurringBillCandidate[]; onDismissMigration: () => void }) { /*
  const [activeId, setActiveId] = useState(vault.cycles.at(-1)?.id ?? ""); const [firstStart, setFirstStart] = useState(todayISO()); const [editStart, setEditStart] = useState(""); const [dialog, setDialog] = useState<"edit" | null>(null); const [transferBusy, setTransferBusy] = useState(false); const [transferStatus, setTransferStatus] = useState(""); const importInput = useRef<HTMLInputElement>(null);
  const cycle = vault.cycles.find((item) => item.id === activeId) ?? vault.cycles.at(-1);
  useEffect(() => { if (!vault.cycles.some((item) => item.id === activeId)) setActiveId(vault.cycles.at(-1)?.id ?? ""); }, [activeId, vault.cycles]);
  const updateCycle = (next: BudgetCycle) => onChange({ ...vault, cycles: vault.cycles.map((item) => item.id === next.id ? next : item) });
  const addCycle = () => { const previous = vault.cycles.at(-1); const start = previous ? addDays(previous.endDate, 1) : firstStart; const next = cloneCycle(previous, start, vault.settings.defaultTargets, vault.recurringBills); onChange({ ...vault, cycles: [...vault.cycles, next] }); setActiveId(next.id); };
  const deleteCycle = () => { if (!cycle || !window.confirm("Delete this two-pay-period budget cycle and all of its entries? This cannot be undone.")) return; const index = vault.cycles.findIndex((item) => item.id === cycle.id); const remaining = vault.cycles.filter((item) => item.id !== cycle.id); onChange({ ...vault, cycles: remaining }); setActiveId(remaining[Math.max(0, index - 1)]?.id ?? ""); setDialog(null); };
  const exportSpreadsheet = async () => { setTransferBusy(true); setTransferStatus(""); try { const bytes = await budgetWorkbook(vault); const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })); const link = document.createElement("a"); link.href = url; link.download = "cipher-budget-export.xlsx"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); setTransferStatus("Spreadsheet exported. It contains readable financial data—store it securely."); } catch (error) { setTransferStatus(error instanceof Error ? error.message : "Could not export the spreadsheet."); } finally { setTransferBusy(false); } };
  const importSpreadsheet = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !window.confirm("Importing replaces all current budget cycles, income, expenses, and recurring bills. Continue?")) return; setTransferBusy(true); setTransferStatus(""); try { const imported = await importBudgetWorkbook(file); onChange(imported); setActiveId(imported.cycles.at(-1)?.id ?? ""); setTransferStatus("Spreadsheet imported. Your encrypted vault is saving the imported budget."); } catch (error) { setTransferStatus(error instanceof Error ? error.message : "Could not import the spreadsheet."); } finally { setTransferBusy(false); } };
  const addRecurringBills = (bills: RecurringBill[]) => { if (!cycle || !bills.length) return; const generated = bills.flatMap((bill) => bill.active ? dueDatesWithin(cycle.startDate, cycle.endDate, bill.dueDay).map((date) => ({ id: newId(), name: bill.name, amountCents: bill.amountCents, date, bucket: bill.bucket, templateId: bill.id })) : []); const nextCycle = { ...cycle, expenses: [...cycle.expenses, ...generated] }; onChange({ ...vault, recurringBills: [...vault.recurringBills, ...bills], cycles: vault.cycles.map((item) => item.id === cycle.id ? nextCycle : item) }); };
  if (!cycle) return <section className="empty-state"><h1>Start your first two-pay-period plan</h1><p>Choose the first day. Your plan will cover 28 days, with two automatic 14-day pay periods.</p><label className="field-label" htmlFor="first-cycle-start">First plan start date</label><input id="first-cycle-start" className="native-input" type="date" value={firstStart} onChange={(event) => setFirstStart(event.target.value)} /><Button label="Create two-pay-period plan" icon="pi pi-calendar-plus" onClick={addCycle} /></section>;
  const values = totals(cycle);
  return <section className="budget-board">
    <div className="period-toolbar"><div><p className="eyebrow">TWO-PAY-PERIOD PLAN</p><h1>{periodLabel(cycle)}</h1></div><div className="period-actions"><select aria-label="Choose budget cycle" value={cycle.id} onChange={(event) => setActiveId(event.target.value)}>{vault.cycles.map((item) => <option key={item.id} value={item.id}>{periodLabel(item)}</option>)}</select><Button label="New two-pay-period plan" icon="pi pi-plus" onClick={addCycle} /><Button className="manage-period" text rounded aria-label="Edit budget cycle" tooltip="Edit budget cycle" tooltipOptions={{ position: "top" }} icon="pi pi-pencil" onClick={() => { setEditStart(cycle.startDate); setDialog("edit"); }} /></div></div>
    <div className="summary-grid"><Summary label="Cycle income" value={money(values.income)} icon="pi pi-wallet" /><Summary label="Cycle expenses" value={money(values.expenses)} icon="pi pi-credit-card" /><Summary label="Cycle balance" value={money(values.remaining)} icon="pi pi-chart-line" tone={values.remaining < 0 ? "negative" : "positive"} /></div>
    <section className="paycheck-grid">{cycle.payPeriods.map((period, index) => <PayPeriodIncomePanel key={period.id} period={period} number={index + 1} onChange={(next) => updateCycle({ ...cycle, payPeriods: cycle.payPeriods.map((item) => item.id === next.id ? next : item) as [PayPeriod, PayPeriod] })} />)}</section>
    <div className="bucket-grid">{(Object.keys(bucketMeta) as Bucket[]).map((bucket) => <CycleBucketPanel key={bucket} bucket={bucket} cycle={cycle} income={values.income} spent={values.byBucket(bucket)} onChange={updateCycle} />)}</div>
    <RecurringBillsPanel bills={vault.recurringBills} onAdd={(bill) => addRecurringBills([bill])} onChange={(bills) => onChange({ ...vault, recurringBills: bills })} />
    <section className="data-tools"><div><i className="pi pi-file-excel" /><span><strong>Spreadsheet backup & import</strong><small>Exports are readable .xlsx files and are not encrypted. Import only a Cipher Budget workbook you trust; importing replaces this vault’s current budget data.</small></span></div><div className="data-tool-actions"><Button outlined label="Export spreadsheet" icon="pi pi-download" loading={transferBusy} onClick={() => void exportSpreadsheet()} /><Button outlined label="Import spreadsheet" icon="pi pi-upload" disabled={transferBusy} onClick={() => importInput.current?.click()} /><input ref={importInput} className="visually-hidden" type="file" accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx" onChange={(event) => void importSpreadsheet(event)} /></div>{transferStatus && <p className="transfer-status" role="status">{transferStatus}</p>}</section>
    <section className="security-settings"><div><i className="pi pi-shield" /><span><strong>Encrypted vault is unlocked</strong><small>Financial data is decrypted only in this browser until it locks.</small></span></div></section>
    <Dialog visible={dialog === "edit"} modal header="Edit two-pay-period plan" className="compact-dialog" onHide={() => setDialog(null)}><p>Changing the start date keeps this plan at two consecutive 14-day pay periods.</p><label className="field-label" htmlFor="edit-cycle-start">Plan start date</label><input className="native-input" id="edit-cycle-start" type="date" value={editStart} onChange={(event) => setEditStart(event.target.value)} /><div className="dialog-actions"><Button label="Save plan" icon="pi pi-check" onClick={() => { if (editStart) { const periods = cycle.payPeriods.map((period, index) => ({ ...period, startDate: addDays(editStart, index * 14), endDate: addDays(editStart, index * 14 + 13) })) as [PayPeriod, PayPeriod]; updateCycle({ ...cycle, startDate: editStart, endDate: addDays(editStart, 27), payPeriods: periods }); setDialog(null); } }} /><Button text label="Cancel" onClick={() => setDialog(null)} /><Button outlined severity="danger" label="Delete plan" icon="pi pi-trash" onClick={deleteCycle} /></div></Dialog>
    <MigrationAssistant candidates={migrationCandidates} onDismiss={onDismissMigration} onAdd={(items) => addRecurringBills(items.map(({ candidate, dueDay }) => ({ id: candidate.id, name: candidate.name, amountCents: candidate.amountCents, bucket: candidate.bucket, dueDay, active: true })))} />
  </section>;
}

*/ return null;
}

function PayPeriodIncomePanel({ period, number, onChange }: { period: PayPeriod; number: number; onChange: (period: PayPeriod) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [editing, setEditing] = useState<IncomeEntry | null>(null); const [error, setError] = useState(""); const prefix = `income-${number}`;
  const clear = () => { setName(""); setAmount(null); setEditing(null); setError(""); };
  const submit = () => { if (!name.trim() || !amount || amount <= 0) { setError("Enter an income source and a positive amount."); return; } const entry: IncomeEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100) }; onChange({ ...period, incomes: editing ? period.incomes.map((item) => item.id === editing.id ? entry : item) : [...period.incomes, entry] }); clear(); };
  return <Card className="income-panel" title={`Pay period ${number}: ${periodLabel(period)} income`}><p className="form-help">Income in this paycheck window is included in the full 28-day plan.</p><div className="entry-form income-form"><div className="field"><label htmlFor={prefix + "-name"}>Income source</label><InputText id={prefix + "-name"} value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="e.g. Paycheck" /></div><div className="field"><label htmlFor={prefix + "-amount"}>Amount</label><InputNumber inputId={prefix + "-amount"} value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="form-buttons"><Button label={editing ? "Save income" : "Add income"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete income" icon="pi pi-trash" onClick={() => { if (window.confirm("Delete this income entry? This cannot be undone.")) { onChange({ ...period, incomes: period.incomes.filter((item) => item.id !== editing.id) }); clear(); } }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<EntryList entries={period.incomes} onEdit={(item) => { const income = item as IncomeEntry; setEditing(income); setName(income.name); setAmount(income.amountCents / 100); setError(""); }} /></Card>;
}

function CycleBucketPanel({ bucket, cycle, income, spent, onChange }: { bucket: Bucket; cycle: BudgetCycle; income: number; spent: number; onChange: (cycle: BudgetCycle) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [date, setDate] = useState(todayISO()); const [editing, setEditing] = useState<ExpenseEntry | null>(null); const [error, setError] = useState(""); const target = Math.round(income * cycle.targetPercentages[bucket] / 100); const remaining = target - spent; const expenses = cycle.expenses.filter((item) => item.bucket === bucket); const nameId = `${bucket}-cycle-expense-name`; const amountId = `${bucket}-cycle-expense-amount`; const dateId = `${bucket}-cycle-expense-date`;
  const clear = () => { setName(""); setAmount(null); setDate(todayISO()); setEditing(null); setError(""); };
  const submit = () => { if (!name.trim() || !amount || amount <= 0) { setError("Enter an expense name and a positive amount before saving."); return; } if (date && (date < cycle.startDate || date > cycle.endDate)) { setError("Choose a date inside this 28-day plan, or leave it blank."); return; } const entry: ExpenseEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100), bucket, ...(date ? { date } : {}), ...(editing?.templateId ? { templateId: editing.templateId } : {}) }; onChange({ ...cycle, expenses: editing ? cycle.expenses.map((item) => item.id === editing.id ? entry : item) : [...cycle.expenses, entry] }); clear(); };
  return <Card className={`bucket-card ${bucket}`}><div className="bucket-header"><div><p>{bucketMeta[bucket].label}</p><strong>{money(remaining)} <small>remaining</small></strong></div><div className="target-input"><label htmlFor={`${bucket}-cycle-target`}>Cycle target</label><InputNumber inputId={`${bucket}-cycle-target`} value={cycle.targetPercentages[bucket]} min={0} max={100} maxFractionDigits={2} useGrouping={false} suffix="%" onValueChange={(event) => onChange({ ...cycle, targetPercentages: { ...cycle.targetPercentages, [bucket]: Math.min(100, Math.max(0, event.value ?? 0)) } })} /></div></div><ProgressBar value={target ? Math.min(100, Math.round(spent / target * 100)) : 0} showValue={false} /><p className={remaining < 0 ? "over" : "muted"}>{money(spent)} spent of {money(target)}</p><div className="entry-form expense-form"><div className="field"><label htmlFor={nameId}>Expense name</label><InputText id={nameId} value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder={expenseHints[bucket]} /></div><div className="expense-details"><div className="field"><label htmlFor={amountId}>Amount</label><InputNumber inputId={amountId} value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="field expense-date-field"><label htmlFor={dateId}>Date <span className="optional-label">(optional)</span></label><input className="native-input" id={dateId} type="date" min={cycle.startDate} max={cycle.endDate} value={date} onChange={(event) => { setDate(event.target.value); setError(""); }} /></div></div><div className="form-buttons"><Button label={editing ? "Save expense" : "Add expense"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete expense" icon="pi pi-trash" onClick={() => { if (window.confirm("Delete this expense? This cannot be undone.")) { onChange({ ...cycle, expenses: cycle.expenses.filter((item) => item.id !== editing.id) }); clear(); } }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<CycleExpenseList cycle={cycle} entries={expenses} onEdit={(expense) => { setEditing(expense); setName(expense.name); setAmount(expense.amountCents / 100); setDate(expense.date ?? ""); setError(""); }} /></Card>;
}

function CycleExpenseList({ cycle, entries, onEdit }: { cycle: BudgetCycle; entries: ExpenseEntry[]; onEdit: (entry: ExpenseEntry) => void }) { if (!entries.length) return <p className="empty-list">No entries yet.</p>; return <ul className="entry-list">{entries.map((item) => <li key={item.id}><div className="entry-details"><span>{item.name}{item.templateId && <i className="pi pi-sync recurring active" title="Monthly recurring bill" />}</span>{item.date && <small>{displayDate(item.date)}{cyclePayPeriod(cycle, item.date) && ` · Pay period ${cyclePayPeriod(cycle, item.date)}`}</small>}</div><strong>{money(item.amountCents)}</strong><button type="button" className="manage-entry" aria-label={`Edit ${item.name}`} onClick={() => onEdit(item)}><i className="pi pi-pencil" /></button></li>)}</ul>; }

function RecurringBillsPanel({ bills, onAdd, onChange }: { bills: RecurringBill[]; onAdd: (bill: RecurringBill) => void; onChange: (bills: RecurringBill[]) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [bucket, setBucket] = useState<Bucket>("needs"); const [dueDay, setDueDay] = useState<number | null>(null); const [notes, setNotes] = useState(""); const [editing, setEditing] = useState<RecurringBill | null>(null); const [error, setError] = useState("");
  const clear = () => { setName(""); setAmount(null); setBucket("needs"); setDueDay(null); setNotes(""); setEditing(null); setError(""); };
  const submit = () => { if (!name.trim() || !amount || amount <= 0 || !dueDay || dueDay < 1 || dueDay > 31) { setError("Enter a bill name, positive amount, and due day from 1 to 31."); return; } const bill: RecurringBill = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100), bucket, dueDay, active: editing?.active ?? true, ...(notes.trim() ? { notes: notes.trim() } : {}) }; if (editing) onChange(bills.map((item) => item.id === editing.id ? bill : item)); else onAdd(bill); clear(); };
  return <Card className="recurring-bills" title="Monthly recurring bills"><p className="form-help">Bills are scheduled by calendar due day and added once only when due inside a 28-day plan. Changes affect future plans.</p><div className="entry-form recurring-form"><div className="field"><label htmlFor="bill-name">Bill name</label><InputText id="bill-name" value={name} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="e.g. Rent" /></div><div className="field"><label htmlFor="bill-amount">Amount</label><InputNumber inputId="bill-amount" value={amount} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="field"><label htmlFor="bill-category">Category</label><select id="bill-category" value={bucket} onChange={(event) => setBucket(event.target.value as Bucket)}>{(Object.keys(bucketMeta) as Bucket[]).map((value) => <option key={value} value={value}>{bucketMeta[value].label}</option>)}</select></div><div className="field"><label htmlFor="bill-day">Due day</label><InputNumber inputId="bill-day" value={dueDay} min={1} max={31} useGrouping={false} onValueChange={(event) => { setDueDay(event.value ?? null); setError(""); }} placeholder="1–31" /></div><div className="field recurring-notes"><label htmlFor="bill-notes">Notes <span className="optional-label">(optional)</span></label><InputText id="bill-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="e.g. paid automatically" /></div><div className="form-buttons"><Button label={editing ? "Save bill" : "Add monthly bill"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete bill" icon="pi pi-trash" onClick={() => { if (window.confirm("Delete this recurring bill? Existing generated expense entries stay in history.")) { onChange(bills.filter((item) => item.id !== editing.id)); clear(); } }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<ul className="entry-list">{bills.length ? bills.map((bill) => <li key={bill.id}><div className="entry-details"><span>{bill.name}</span><small>Due day {bill.dueDay} · Next due {displayDate(dueDatesWithin(todayISO(), addDays(todayISO(), 31), bill.dueDay)[0])} · {bucketMeta[bill.bucket].label}{bill.notes ? ` · ${bill.notes}` : ""}</small></div><strong>{money(bill.amountCents)}</strong><button type="button" className={bill.active ? "recurring active" : "recurring"} onClick={() => onChange(bills.map((item) => item.id === bill.id ? { ...item, active: !item.active } : item))}>{bill.active ? "Active" : "Paused"}</button><button type="button" className="manage-entry" aria-label={`Edit ${bill.name}`} onClick={() => { setEditing(bill); setName(bill.name); setAmount(bill.amountCents / 100); setBucket(bill.bucket); setDueDay(bill.dueDay); setNotes(bill.notes ?? ""); setError(""); }}><i className="pi pi-pencil" /></button></li>) : <li className="empty-list">No monthly bills yet.</li>}</ul></Card>;
}

function MigrationAssistant({ candidates, onAdd, onDismiss }: { candidates: RecurringBillCandidate[]; onAdd: (items: { candidate: RecurringBillCandidate; dueDay: number }[]) => void; onDismiss: () => void }) {
  const [days, setDays] = useState<Record<string, string>>({}); const [shown, setShown] = useState(false); useEffect(() => { if (candidates.length) { setDays(Object.fromEntries(candidates.map((candidate) => [candidate.id, String(candidate.suggestedDueDay ?? "")]))); setShown(true); } }, [candidates]); if (!candidates.length) return null;
  return <Dialog visible={shown} modal closable={false} dismissableMask={false} header="Set up your monthly bills" onHide={() => { }}><p>Your prior recurring entries were kept as history. Confirm a calendar due day before creating any future monthly bill; no bill will be activated automatically.</p><div className="migration-candidates">{candidates.map((candidate) => <div key={candidate.id}><span><strong>{candidate.name}</strong><small>{money(candidate.amountCents)} · {bucketMeta[candidate.bucket].label}</small></span><InputNumber value={Number(days[candidate.id]) || null} min={1} max={31} useGrouping={false} placeholder="Due day" onValueChange={(event) => setDays({ ...days, [candidate.id]: String(event.value ?? "") })} /></div>)}</div><div className="button-row"><Button label="Create confirmed monthly bills" icon="pi pi-check" onClick={() => { onAdd(candidates.flatMap((candidate) => { const dueDay = Number(days[candidate.id]); return Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31 ? [{ candidate, dueDay }] : []; })); setShown(false); onDismiss(); }} /><Button text label="Skip for now" onClick={() => { setShown(false); onDismiss(); }} /></div></Dialog>;
}
