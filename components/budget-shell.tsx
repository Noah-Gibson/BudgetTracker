"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Button } from "primereact/button";
import { Card } from "primereact/card";
import { Checkbox } from "primereact/checkbox";
import { Dialog } from "primereact/dialog";
import { InputNumber } from "primereact/inputnumber";
import { InputText } from "primereact/inputtext";
import { ProgressBar } from "primereact/progressbar";
import { Toast } from "primereact/toast";
import { addDays, bucketMeta, clonePeriod, createEmptyVault, money, newId, todayISO, totals, type BudgetPeriod, type Bucket, type BudgetVault, type ExpenseEntry, type IncomeEntry } from "@/lib/budget/types";
import { decryptVault, encryptVault, exportVaultKey, generateVaultKey, importVaultKey, randomBytes, recoveryKey, unwrapWithPasskey, unwrapWithRecovery, wrapWithRecovery, type Envelope } from "@/lib/crypto/vault";

type PasskeyDeviceEnvelope = { kind?: "passkey"; salt: string; wrappedKey: string; deviceId: string };
type TrustedDeviceEnvelope = { kind: "trusted-device"; iv: string; wrappedKey: string; deviceId: string };
type DeviceEnvelope = PasskeyDeviceEnvelope | TrustedDeviceEnvelope;
type ListEntry = { id: string; name: string; amountCents: number; date?: string; recurring?: boolean };
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
function periodLabel(period: BudgetPeriod) {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const start = new Date(period.startDate + "T12:00:00").toLocaleDateString(undefined, options);
  const end = new Date(period.endDate + "T12:00:00").toLocaleDateString(undefined, { ...options, year: "numeric" });
  return start + " – " + end;
}
function displayDate(value: string) { return new Date(value + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

function GoogleSignInButton() {
  return <button type="button" className="google-sign-in" onClick={() => signIn("google")}>
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
    <section className="landing-copy"><p className="eyebrow">PRIVATE BY DESIGN</p><h1>Your budget, visible only to you.</h1><p>Plan every pay period with a vault encrypted in your browser. The service stores encrypted data—not your financial details.</p><GoogleSignInButton /></section>
    <section className="security-panel"><i className="pi pi-shield security-icon" /><h2>Zero-knowledge budgeting</h2><ul><li>Google sign-in + a personal passkey</li><li>End-to-end encrypted budget vault</li><li>Offline recovery key you control</li><li>Biweekly planning that works beautifully on mobile</li></ul></section>
  </main>;
  return <VaultWorkspace email={session.user.email ?? "Signed in with Google"} image={session.user.image} onSignOut={() => signOut({ callbackUrl: "/" })} />;
}

function VaultWorkspace({ email, image, onSignOut }: { email: string; image?: string | null; onSignOut: () => void }) {
  const [vault, setVault] = useState<BudgetVault | null>(null);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [recovery, setRecovery] = useState("");
  const [createdRecovery, setCreatedRecovery] = useState("");
  const [confirmRecovery, setConfirmRecovery] = useState("");
  const [setup, setSetup] = useState(false);
  const [resetCandidate, setResetCandidate] = useState<{ replaceExisting: boolean } | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [showAbandon, setShowAbandon] = useState(false);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [browserReady, setBrowserReady] = useState(false);
  const [autoUnlocking, setAutoUnlocking] = useState(false);
  const toast = useRef<Toast>(null);
  const attemptedRememberedUnlock = useRef(false);
  const lock = useCallback((message = "Vault locked. Verify your passkey to continue.") => { setVault(null); setKey(null); setEnvelope(null); setNotice(message); }, []);

  useEffect(() => {
    const activity = () => setLastActivity(Date.now());
    window.addEventListener("pointerdown", activity); window.addEventListener("keydown", activity);
    const timer = window.setInterval(() => { if (vault && Date.now() - lastActivity > 15 * 60_000) lock("Vault locked after 15 minutes of inactivity."); }, 30_000);
    return () => { window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity); window.clearInterval(timer); };
  }, [lastActivity, lock, vault]);

  const fetchEnvelope = async () => {
    const response = await fetch("/api/vault", { cache: "no-store" });
    if (!response.ok) throw new Error("Vault is not available. Verify your passkey first.");
    return (await response.json()).vault as Envelope | null;
  };
  const unlockRemembered = async () => {
    setBusy(true); setNotice("");
    try {
      const device = deviceEnvelope(); if (!device) throw new Error("No remembered vault key is stored in this browser.");
      if (device.kind === "trusted-device") {
        const remote = await fetchEnvelope();
        if (!remote) { setSetup(true); return; }
        const unlocked = await unlockTrustedDevice(device);
        setKey(unlocked); setEnvelope(remote); setVault(await decryptVault(remote, unlocked)); setLastActivity(Date.now());
        return;
      }
      const assertion = await requestPasskey("authentication", device.salt); const remote = await fetchEnvelope();
      if (!remote) { setSetup(true); return; }
      if (!assertion.prf) throw new Error("This passkey cannot unlock the remembered vault. Use your recovery key to enroll a supported browser.");
      const unlocked = await unwrapWithPasskey(device.wrappedKey, assertion.prf, b64ToBytes(device.salt));
      setKey(unlocked); setEnvelope(remote); setVault(await decryptVault(remote, unlocked)); setLastActivity(Date.now());
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to unlock the vault."); } finally { setBusy(false); }
  };
  useEffect(() => {
    setBrowserReady(true);
  }, []);
  useEffect(() => {
    const remembered = deviceEnvelope();
    if (attemptedRememberedUnlock.current || vault || setup || createdRecovery || remembered?.kind !== "trusted-device") return;
    attemptedRememberedUnlock.current = true;
    setAutoUnlocking(true);
    void unlockRemembered().finally(() => setAutoUnlocking(false));
  }, [createdRecovery, setup, unlockRemembered, vault]);
  const unlockRecovery = async () => {
    setBusy(true); setNotice("");
    try {
      await requestPasskey("authentication"); const remote = await fetchEnvelope();
      if (!remote) { setSetup(true); return; }
      const unlocked = await unwrapWithRecovery(recovery, remote.recoverySalt!, remote.recoveryWrappedKey!);
      if (remember) {
        const trustedDevice = await rememberTrustedDevice(unlocked);
        localStorage.setItem(DEVICE_KEY, JSON.stringify(trustedDevice));
      }
      setRecovery(""); setKey(unlocked); setEnvelope(remote); setVault(await decryptVault(remote, unlocked)); setLastActivity(Date.now());
    } catch (error) { setNotice(error instanceof Error ? error.message : "The recovery key could not unlock this vault."); } finally { setBusy(false); }
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
        setResetCandidate({ replaceExisting: true });
        setSetup(false);
        return;
      }
      const vaultKey = await generateVaultKey(); const code = recoveryKey(); const recoveryWrapper = await wrapWithRecovery(vaultKey, code);
      if (remember) {
        const trustedDevice = await rememberTrustedDevice(vaultKey);
        localStorage.setItem(DEVICE_KEY, JSON.stringify(trustedDevice));
      }
      setKey(vaultKey); setVault(createEmptyVault()); setEnvelope({ vaultId: newId(), revision: 0, ciphertext: "", iv: "", tag: "", ...recoveryWrapper });
      setCreatedRecovery(code); setSetup(false);
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
      setResetCandidate({ replaceExisting: Boolean(remote) });
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
      const trustedDevice = remember ? await rememberTrustedDevice(newVaultKey) : null;
      if (trustedDevice) localStorage.setItem(DEVICE_KEY, JSON.stringify(trustedDevice));
      setKey(newVaultKey);
      setVault(createEmptyVault());
      setEnvelope({ vaultId: newId(), revision: 0, ciphertext: "", iv: "", tag: "", ...recoveryWrapper });
      setCreatedRecovery(code);
      setResetCandidate(null); setSetup(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to create the new vault.");
    } finally { setBusy(false); }
  };
  const save = async (nextVault: BudgetVault) => {
    if (!key || !envelope) return;
    const revision = envelope.revision + 1;
    const encrypted = await encryptVault(nextVault, key, envelope.vaultId, revision);
    const response = await fetch("/api/vault", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...encrypted, vaultId: envelope.vaultId, revision, recoveryWrappedKey: envelope.recoveryWrappedKey, recoverySalt: envelope.recoverySalt }) });
    if (response.status === 409) { lock("Your vault changed on another device. Unlock again to safely reload it."); return; }
    if (!response.ok) throw new Error("Encrypted save failed. Your changes remain only in this browser.");
    setEnvelope({ ...envelope, ...encrypted, revision }); setVault(nextVault);
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
  const lockAndForgetBrowser = () => {
    localStorage.removeItem(DEVICE_KEY);
    void forgetTrustedDeviceKey();
    lock("Vault locked and this browser has been forgotten.");
  };
  const rememberedDevice = browserReady ? deviceEnvelope() : null;
  const hasDevice = Boolean(rememberedDevice);
  const automaticallyUnlocking = Boolean(!browserReady || autoUnlocking || (rememberedDevice?.kind === "trusted-device" && !vault && !setup && !createdRecovery && !attemptedRememberedUnlock.current));

  return <main className="app-shell"><Toast ref={toast} />
    <header className="topbar"><div className="brand"><i className="pi pi-lock" /> <span>Cipher Budget</span></div><div className="signed-in-user">{image ? <img src={image} referrerPolicy="no-referrer" alt="" /> : <span className="profile-fallback" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span>}<span>{email}</span></div><div className="topbar-actions"><Button text icon="pi pi-lock" label="Lock" onClick={lockAndForgetBrowser} /><Button text icon="pi pi-sign-out" label="Sign out" onClick={onSignOut} /></div></header>
    {automaticallyUnlocking && <section className="unlock-card"><i className="pi pi-spin pi-spinner unlock-icon" /><h1>Opening your private budget</h1><p>Unlocking this remembered personal browser…</p></section>}
    {!vault && !setup && !createdRecovery && !automaticallyUnlocking && <section className="unlock-card"><i className="pi pi-shield unlock-icon" /><h1>Unlock your private budget</h1><p>Google confirms your identity. A passkey protects setup and destructive resets; a remembered personal browser can unlock with your Google session.</p>{notice && <p className="error">{notice}</p>}{hasDevice ? <Button text label="Set up a replacement passkey and vault" icon="pi pi-plus" disabled={busy} onClick={() => setSetup(true)} /> : <><Button label="Set up a new vault" icon="pi pi-plus" loading={busy} onClick={() => setSetup(true)} /><div className="recovery-unlock"><h2>Already have a vault?</h2><p>Use your recovery key to add this browser.</p><InputText value={recovery} onChange={(event) => setRecovery(event.target.value)} placeholder="Recovery key" autoComplete="off" /><div className="remember-choice"><Checkbox inputId="remember-unlock" checked={remember} onChange={(event) => setRemember(Boolean(event.checked))} /><label htmlFor="remember-unlock">Remember this personal browser (no passkey on return)</label></div><Button outlined label="Recover and unlock" icon="pi pi-key" loading={busy} onClick={unlockRecovery} /></div></>}<Button text severity="danger" label="Reset vault with saved passkey" icon="pi pi-refresh" loading={busy} onClick={() => void verifyExistingPasskeyForReset()} /></section>}
    {setup && <section className="unlock-card"><i className="pi pi-key unlock-icon" /><h1>Create your encrypted vault</h1><p>Set up a site passkey. It is required alongside Google sign-in to access your financial data.</p><div className="remember-choice"><Checkbox inputId="remember-setup" checked={remember} onChange={(event) => setRemember(Boolean(event.checked))} /><label htmlFor="remember-setup">Remember this personal browser (no passkey on return)</label></div><small>Only select this on a personal, device-encrypted browser profile. It stores an encrypted vault-key envelope locally and still requires your Google session; it never stores budget plaintext or the raw vault key.</small>{notice && <p className="error">{notice}</p>}<div className="button-row"><Button label="Create vault with passkey" icon="pi pi-shield" loading={busy} onClick={startSetup} /><Button text label="Back" onClick={() => setSetup(false)} /></div></section>}
    {vault && <BudgetBoard vault={vault} onChange={(next) => { setVault(next); void save(next).catch((error) => setNotice(error instanceof Error ? error.message : "Save failed")); }} />}
    <Dialog visible={Boolean(resetCandidate)} modal closable={!busy} dismissableMask={false} header={resetCandidate?.replaceExisting ? "Permanently replace encrypted vault?" : "Create a new vault?"} className="recovery-dialog" onHide={() => { if (!busy) setResetCandidate(null); }}><p className="danger-copy">{resetCandidate?.replaceExisting ? "You cannot unlock the existing vault with this passkey alone. Continuing permanently deletes its encrypted ciphertext. Even if you find the old recovery key later, the old budget data cannot be recovered." : "No existing encrypted vault was found. Continuing creates a new empty vault with your verified passkey."}</p><p>You will be shown a new recovery key before the new vault can be used.</p>{notice && <p className="error">{notice}</p>}<div className="button-row"><Button severity="danger" label={resetCandidate?.replaceExisting ? "Delete old vault and create new" : "Create new vault"} icon="pi pi-exclamation-triangle" loading={busy} onClick={confirmVaultReset} /><Button text label="Cancel" disabled={busy} onClick={() => setResetCandidate(null)} /></div></Dialog>
    <Dialog visible={Boolean(createdRecovery)} modal closable={false} dismissableMask={false} header="Record your recovery key" className="recovery-dialog" onHide={() => setShowAbandon(true)}><p className="danger-copy">This recovery key is the only backup if you lose your passkey. If you do not record it, you WILL permanently lose access to all your budget data. After this screen is closed, it is never accessible or recoverable by anyone again.</p><code className="recovery-code">{createdRecovery}</code><div className="button-row"><Button text label="Copy" icon="pi pi-copy" onClick={() => navigator.clipboard.writeText(createdRecovery)} /><Button text label="Print" icon="pi pi-print" onClick={() => window.print()} /><Button text label="Download" icon="pi pi-download" onClick={() => { const blob = new Blob(["Cipher Budget recovery key\n\n" + createdRecovery + "\n"], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "cipher-budget-recovery-key.txt"; link.click(); URL.revokeObjectURL(link.href); }} /></div><p>Store it in a password manager or another secure offline location. Do not share it or keep it in unsecured notes.</p><label htmlFor="confirm-recovery">Enter the complete recovery key to verify you recorded it.</label><InputText id="confirm-recovery" value={confirmRecovery} onChange={(event) => setConfirmRecovery(event.target.value)} autoComplete="off" className="full-width" />{notice && <p className="error">{notice}</p>}<Button label="I recorded it — secure my vault" icon="pi pi-check" loading={busy} disabled={busy} onClick={confirmCeremony} /><Button text severity="secondary" label="I need more time" disabled={busy} onClick={() => setShowAbandon(true)} /><Dialog visible={showAbandon} modal header="Leave vault setup?" onHide={() => setShowAbandon(false)}><p>If you leave without recording and verifying this key, all newly created encrypted vault data will be discarded. You will need to set up a new vault later.</p><Button severity="danger" label="Discard unverified vault" onClick={() => { setCreatedRecovery(""); setConfirmRecovery(""); setVault(null); setKey(null); setEnvelope(null); setShowAbandon(false); setNotice("Vault setup was abandoned. No financial data was saved."); }} /></Dialog></Dialog>
  </main>;
}

function BudgetBoard({ vault, onChange }: { vault: BudgetVault; onChange: (vault: BudgetVault) => void }) {
  const [activeId, setActiveId] = useState(vault.periods.at(-1)?.id ?? "");
  const [firstStart, setFirstStart] = useState(todayISO());
  const [editStart, setEditStart] = useState("");
  const [dialog, setDialog] = useState<"edit" | null>(null);
  const period = vault.periods.find((item) => item.id === activeId) ?? vault.periods.at(-1);
  useEffect(() => { if (!vault.periods.some((item) => item.id === activeId)) setActiveId(vault.periods.at(-1)?.id ?? ""); }, [activeId, vault.periods]);
  const updatePeriod = (next: BudgetPeriod) => onChange({ ...vault, periods: vault.periods.map((item) => item.id === next.id ? next : item) });
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
  return <section className="budget-board">
    <div className="period-toolbar"><div><p className="eyebrow">PAY PERIOD</p><h1>{periodLabel(period)}</h1></div><div className="period-actions"><select aria-label="Choose pay period" value={period.id} onChange={(event) => setActiveId(event.target.value)}>{vault.periods.map((item) => <option key={item.id} value={item.id}>{periodLabel(item)}</option>)}</select><Button label="New period" icon="pi pi-plus" onClick={addPeriod} /><Button className="manage-period" text rounded aria-label="Edit pay period" tooltip="Edit pay period" tooltipOptions={{ position: "top" }} icon="pi pi-pencil" onClick={() => { setEditStart(period.startDate); setDialog("edit"); }} /></div></div>
    <div className="summary-grid"><Summary label="Total income" value={money(values.income)} icon="pi pi-wallet" /><Summary label="Total expenses" value={money(values.expenses)} icon="pi pi-credit-card" /><Summary label="Remaining balance" value={money(values.remaining)} icon="pi pi-chart-line" tone={values.remaining < 0 ? "negative" : "positive"} /></div>
    <IncomePanel period={period} onChange={updatePeriod} />
    <div className="bucket-grid">{(Object.keys(bucketMeta) as Bucket[]).map((bucket) => <BucketPanel key={bucket} bucket={bucket} period={period} income={values.income} spent={values.byBucket(bucket)} onChange={updatePeriod} />)}</div>
    <section className="security-settings"><div><i className="pi pi-shield" /><span><strong>Encrypted vault is unlocked</strong><small>Financial data is decrypted only in this browser until it locks.</small></span></div></section>
    <Dialog visible={dialog === "edit"} modal header="Edit pay period" className="compact-dialog" onHide={() => setDialog(null)}><p>Changing the start date automatically keeps this pay period 14 days long.</p><label className="field-label" htmlFor="edit-period-start">Start date</label><input className="native-input" id="edit-period-start" type="date" value={editStart} onChange={(event) => setEditStart(event.target.value)} /><div className="dialog-actions"><Button label="Save period" icon="pi pi-check" onClick={() => { if (editStart) updatePeriod({ ...period, startDate: editStart, endDate: addDays(editStart, 13) }); setDialog(null); }} /><Button text label="Cancel" onClick={() => setDialog(null)} /><Button outlined severity="danger" label="Delete period" icon="pi pi-trash" onClick={deletePeriod} /></div></Dialog>
  </section>;
}
function Summary({ label, value, icon, tone }: { label: string; value: string; icon: string; tone?: string }) { return <Card className={"summary-card " + (tone ?? "")}><i className={icon} /><span>{label}</span><strong>{value}</strong></Card>; }

function IncomePanel({ period, onChange }: { period: BudgetPeriod; onChange: (period: BudgetPeriod) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [editing, setEditing] = useState<IncomeEntry | null>(null); const [error, setError] = useState("");
  const clear = () => { setName(""); setAmount(null); setEditing(null); setError(""); };
  const submit = () => {
    if (!name.trim() || !amount || amount <= 0) { setError(!name.trim() && (!amount || amount <= 0) ? "Enter an income source and a positive amount." : !name.trim() ? "Enter an income source." : "Enter an amount greater than $0.00."); return; }
    const entry: IncomeEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100) };
    onChange({ ...period, incomes: editing ? period.incomes.map((item) => item.id === editing.id ? entry : item) : [...period.incomes, entry] }); clear();
  };
  return <Card className="income-panel" title="Income"><p className="form-help">Add each source of income for this pay period.</p><div className="entry-form income-form"><div className="field"><label htmlFor="income-name">Income source</label><InputText id="income-name" value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="e.g. Paycheck" /></div><div className="field"><label htmlFor="income-amount">Amount</label><InputNumber inputId="income-amount" value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="form-buttons"><Button label={editing ? "Save income" : "Add income"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete income" icon="pi pi-trash" onClick={() => { if (!window.confirm("Delete this income entry? This cannot be undone.")) return; onChange({ ...period, incomes: period.incomes.filter((item) => item.id !== editing.id) }); clear(); }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<EntryList entries={period.incomes} onEdit={(item) => { setEditing(item as IncomeEntry); setName(item.name); setAmount(item.amountCents / 100); setError(""); }} /></Card>;
}

function BucketPanel({ bucket, period, income, spent, onChange }: { bucket: Bucket; period: BudgetPeriod; income: number; spent: number; onChange: (period: BudgetPeriod) => void }) {
  const [name, setName] = useState(""); const [amount, setAmount] = useState<number | null>(null); const [date, setDate] = useState(todayISO()); const [editing, setEditing] = useState<ExpenseEntry | null>(null); const [error, setError] = useState("");
  const target = Math.round(income * period.targetPercentages[bucket] / 100); const remaining = target - spent; const expenses = period.expenses.filter((item) => item.bucket === bucket);
  const clear = () => { setName(""); setAmount(null); setDate(todayISO()); setEditing(null); setError(""); };
  const submit = () => {
    if (!name.trim() || !amount || amount <= 0) { setError("Enter an expense name and a positive amount before saving."); return; }
    const entry: ExpenseEntry = { id: editing?.id ?? newId(), name: name.trim(), amountCents: Math.round(amount * 100), date: date || undefined, bucket, recurring: editing?.recurring ?? false };
    onChange({ ...period, expenses: editing ? period.expenses.map((item) => item.id === editing.id ? entry : item) : [...period.expenses, entry] }); clear();
  };
  const nameId = bucket + "-expense-name"; const amountId = bucket + "-expense-amount"; const dateId = bucket + "-expense-date";
  return <Card className={"bucket-card " + bucket}><div className="bucket-header"><div><p>{bucketMeta[bucket].label}</p><strong>{money(remaining)} <small>remaining</small></strong></div><label>{period.targetPercentages[bucket]}% target<input type="range" min="0" max="100" value={period.targetPercentages[bucket]} onChange={(event) => onChange({ ...period, targetPercentages: { ...period.targetPercentages, [bucket]: Number(event.target.value) } })} /></label></div><ProgressBar value={target ? Math.min(100, Math.round(spent / target * 100)) : 0} showValue={false} /><p className={remaining < 0 ? "over" : "muted"}>{money(spent)} spent of {money(target)}</p><div className="entry-form expense-form"><div className="field"><label htmlFor={nameId}>Expense name</label><InputText id={nameId} value={name} invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder={expenseHints[bucket]} /></div><div className="expense-details"><div className="field"><label htmlFor={amountId}>Amount</label><InputNumber inputId={amountId} value={amount} invalid={Boolean(error && (!amount || amount <= 0))} onValueChange={(event) => { setAmount(event.value ?? null); setError(""); }} mode="currency" currency="USD" locale="en-US" placeholder="$0.00" /></div><div className="field"><label htmlFor={dateId}>Date <span className="optional-label">(optional)</span></label><input className="native-input" id={dateId} type="date" value={date} onChange={(event) => { setDate(event.target.value); setError(""); }} /></div></div><div className="form-buttons"><Button label={editing ? "Save expense" : "Add expense"} icon={editing ? "pi pi-check" : "pi pi-plus"} onClick={submit} />{editing && <><Button outlined label="Cancel" onClick={clear} /><Button outlined severity="danger" label="Delete expense" icon="pi pi-trash" onClick={() => { if (!window.confirm("Delete this expense? This cannot be undone.")) return; onChange({ ...period, expenses: period.expenses.filter((item) => item.id !== editing.id) }); clear(); }} /></>}</div></div>{error && <p className="form-error" role="alert">{error}</p>}<EntryList entries={expenses} onEdit={(item) => { const expense = item as ExpenseEntry; setEditing(expense); setName(expense.name); setAmount(expense.amountCents / 100); setDate(expense.date ?? ""); setError(""); }} onToggle={(id) => onChange({ ...period, expenses: period.expenses.map((item) => item.id === id ? { ...item, recurring: !item.recurring } : item) })} /></Card>;
}

function EntryList({ entries, onEdit, onToggle }: { entries: ListEntry[]; onEdit: (item: ListEntry) => void; onToggle?: (id: string) => void }) {
  if (!entries.length) return <p className="empty-list">No entries yet.</p>;
  return <ul className="entry-list">{entries.map((item) => <li key={item.id}><div className="entry-details"><span>{item.name}</span>{(item.date || onToggle) && <small>{item.date && displayDate(item.date)}{item.date && onToggle && " · "}{onToggle && <button type="button" className={item.recurring ? "recurring active" : "recurring"} onClick={() => onToggle(item.id)}><i className="pi pi-sync" /> {item.recurring ? "Recurring" : "One time"}</button>}</small>}</div><strong>{money(item.amountCents)}</strong><button type="button" className="manage-entry" aria-label={"Edit " + item.name} title={"Edit " + item.name} onClick={() => onEdit(item)}><i className="pi pi-pencil" /></button></li>)}</ul>;
}
