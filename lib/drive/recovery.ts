"use client";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "cipher-budget-recovery-v1.json";
const MIME_TYPE = "application/vnd.cipher-budget.recovery+json";
const GIS_SRC = "https://accounts.google.com/gsi/client";

export type DriveRecoveryPackage = { format: 1; vaultId: string; recoveryKey: string; createdAt: string };
export type DriveBackupRemoval = "removed" | "not-found" | "different-vault";
export type DriveRecoveryCheck =
  | { status: "connected"; backup: DriveRecoveryPackage }
  | { status: "connect-required" | "missing-backup" | "unavailable" };

type TokenResponse = { access_token?: string; error?: string; error_description?: string; expires_in?: number; scope?: string };
type TokenRequest = { prompt?: "" | "none" | "consent" };
type TokenClient = { requestAccessToken: (options?: TokenRequest) => void };
type GoogleIdentity = { accounts: { oauth2: { initTokenClient: (options: { client_id: string; scope: string; login_hint?: string; callback: (response: TokenResponse) => void; error_callback?: (error: { type?: string; message?: string }) => void }) => TokenClient } } };
type TokenRequestOptions = { prompt?: "" | "none" | "consent"; loginHint?: string };
type MemoryToken = { value: string; expiresAt: number; loginHint?: string };

class DriveRecoveryError extends Error {
  constructor(message: string, readonly kind: "connect-required" | "missing-backup" | "unavailable" = "unavailable") { super(message); }
}

declare global { interface Window { google?: GoogleIdentity } }

function clientId() {
  const value = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID;
  if (!value) throw new Error("Google Drive backup is not configured for this deployment.");
  return value;
}

function packageError(message = "Your Google Drive backup could not be used.", kind: DriveRecoveryError["kind"] = "unavailable") { return new DriveRecoveryError(message, kind); }
let memoryToken: MemoryToken | null = null;
const pendingTokenRequests = new Map<string, Promise<string>>();

async function loadGoogleIdentity() {
  if (window.google?.accounts.oauth2) return window.google;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) { existing.addEventListener("load", () => resolve(), { once: true }); existing.addEventListener("error", () => reject(packageError("Google Drive authorization could not be loaded.")), { once: true }); return; }
    const script = document.createElement("script"); script.src = GIS_SRC; script.async = true; script.defer = true; script.onload = () => resolve(); script.onerror = () => reject(packageError("Google Drive authorization could not be loaded.")); document.head.append(script);
  });
  if (!window.google?.accounts.oauth2) throw packageError("Google Drive authorization is unavailable in this browser.");
  return window.google;
}

function requestDriveToken(options: TokenRequestOptions = {}) {
  // Safari's installed web apps only permit Google to open its authorization
  // window while the originating tap is still active. Do not await script
  // loading here: requestAccessToken must run in the same call stack.
  const google = window.google;
  if (!google?.accounts.oauth2) return Promise.reject(packageError("Google Drive is still getting ready. Wait a moment, then tap the button again."));
  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(packageError(options.prompt === "none" ? "Google Drive needs to be connected before restoring this vault." : "Google Drive access was not granted.", "connect-required")), 10_000);
    const finish = (callback: () => void) => { window.clearTimeout(timeout); callback(); };
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(), scope: DRIVE_SCOPE, ...(options.loginHint ? { login_hint: options.loginHint } : {}),
      callback: (response) => {
        const token = response.access_token;
        if (!token) { finish(() => reject(packageError(response.error_description ?? (options.prompt === "none" ? "Google Drive needs to be connected before restoring this vault." : "Google Drive access was not granted."), "connect-required"))); return; }
        // Google may return a partial grant. Do not send a token to Drive when
        // the specific private app-data permission was declined or blocked.
        if (response.scope && !response.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
          finish(() => reject(packageError("Google did not grant Cipher Budget permission to its private Drive app-data folder. Approve the requested Drive permission and try again.", "connect-required")));
          return;
        }
        memoryToken = { value: token, expiresAt: Date.now() + Math.max(30, response.expires_in ?? 300) * 1000, loginHint: options.loginHint };
        finish(() => resolve(token));
      },
      error_callback: (error) => finish(() => reject(packageError(error.type === "popup_failed_to_open" ? "Safari could not open Google’s authorization window. Open Cipher Budget in Safari instead of its Home Screen web app, then try Google Drive recovery again." : error.message ?? "Google Drive access was cancelled.", "connect-required")))
    });
    client.requestAccessToken(options.prompt === undefined ? undefined : { prompt: options.prompt });
  });
}

function driveToken(options: TokenRequestOptions = {}) {
  // Tokens are intentionally memory-only. Reusing an unexpired token avoids a
  // second Google UX during one page visit without persisting account access.
  if (memoryToken && memoryToken.expiresAt > Date.now() + 10_000 && (!options.loginHint || memoryToken.loginHint === options.loginHint)) return Promise.resolve(memoryToken.value);
  const requestKey = `${options.prompt ?? "default"}:${options.loginHint ?? ""}`;
  const pending = pendingTokenRequests.get(requestKey);
  if (pending) return pending;
  const request = requestDriveToken(options).finally(() => pendingTokenRequests.delete(requestKey));
  pendingTokenRequests.set(requestKey, request);
  return request;
}

/** Preloads GIS before a user taps a Drive action, preserving Safari activation. */
export function prepareDriveRecoveryAuthorization() { return loadGoogleIdentity(); }
/** Starts Google authorization synchronously in the calling button handler. */
export function beginDriveRecoveryAuthorization(loginHint?: string) { return driveToken({ prompt: "", loginHint }); }
/** Clears the ephemeral Drive token when the account session ends. */
export function clearDriveRecoveryAuthorization() { memoryToken = null; pendingTokenRequests.clear(); }

type DriveApiError = { error?: { message?: string; errors?: { reason?: string }[] } };
async function driveFailure(response: Response) {
  const body = await response.clone().json().catch(() => null) as DriveApiError | null;
  const message = body?.error?.message ?? "";
  const reason = body?.error?.errors?.[0]?.reason ?? "";
  if (response.status === 401) { memoryToken = null; return packageError("Google Drive needs to be connected again before restoring this vault.", "connect-required"); }
  if (response.status === 403 && (reason === "accessNotConfigured" || reason === "serviceDisabled" || /has not been used|is disabled/i.test(message))) {
    return packageError("The Google Drive API is not enabled for this Google Cloud project. Enable the Google Drive API, then try again.");
  }
  if (response.status === 403 && (reason === "insufficientPermissions" || /insufficient authentication scopes|permission/i.test(message))) {
    return packageError("Google did not grant access to Cipher Budget’s private Drive app-data folder. Add the drive.appdata scope in Google Cloud’s Data Access page, then approve the permission and try again.", "connect-required");
  }
  if (response.status === 403 && reason === "domainPolicy") {
    return packageError("This Google Workspace account is blocked by its organization from using Drive apps. Use a personal Google account or ask the Workspace administrator to allow Cipher Budget.");
  }
  if (response.status === 403) {
    // Google error details identify configuration and account-policy failures,
    // not budget data, recovery secrets, or access tokens. Showing them saves
    // users from guessing which Google Cloud setting needs attention.
    const detail = [reason, message].filter(Boolean).join(": ");
    return packageError(detail ? `Google Drive denied access (${detail}).` : "Google Drive denied access to the private app-data folder. Check that the Drive API is enabled and that this Google account is allowed to grant the Drive permission.");
  }
  return packageError("Google Drive could not complete the backup request.");
}

async function driveFetch(token: string, input: string, init: RequestInit = {}) {
  const response = await fetch(input, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, cache: "no-store" });
  if (!response.ok) throw await driveFailure(response);
  return response;
}

async function findBackup(token: string) {
  const query = new URLSearchParams({ spaces: "appDataFolder", q: `name = '${FILE_NAME}' and trashed = false`, fields: "files(id,modifiedTime)" });
  const response = await driveFetch(token, `https://www.googleapis.com/drive/v3/files?${query}`);
  const body = await response.json() as { files?: { id: string; modifiedTime: string }[] };
  return body.files?.sort((left, right) => right.modifiedTime.localeCompare(left.modifiedTime))[0];
}

function validatePackage(value: unknown): DriveRecoveryPackage {
  if (!value || typeof value !== "object") throw packageError("Google Drive returned an invalid recovery backup.");
  const item = value as Partial<DriveRecoveryPackage>;
  if (item.format !== 1 || typeof item.vaultId !== "string" || typeof item.recoveryKey !== "string" || typeof item.createdAt !== "string") throw packageError("Google Drive returned an invalid recovery backup.");
  return item as DriveRecoveryPackage;
}

async function readBackup(token: string, id: string) {
  const response = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
  return validatePackage(await response.json());
}

function multipart(metadata: object, content: string) {
  const boundary = `cipher-budget-${crypto.randomUUID()}`;
  return { boundary, body: [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify(metadata), `--${boundary}`, `Content-Type: ${MIME_TYPE}`, "", content, `--${boundary}--`, ""].join("\r\n") };
}

/** Writes and immediately reads a small, non-budget recovery package. No application API is involved. */
export async function saveDriveRecoveryBackup(vaultId: string, recoveryKey: string, authorization: Promise<string> = driveToken()) {
  const token = await authorization;
  const backup: DriveRecoveryPackage = { format: 1, vaultId, recoveryKey, createdAt: new Date().toISOString() };
  const existing = await findBackup(token);
  // A file's appDataFolder parent is assigned only when it is created. Drive
  // rejects that field on PATCH, which previously prevented replacement of an
  // already-saved recovery package.
  const metadata = existing ? { name: FILE_NAME, mimeType: MIME_TYPE } : { name: FILE_NAME, mimeType: MIME_TYPE, parents: ["appDataFolder"] };
  const upload = multipart(metadata, JSON.stringify(backup));
  const url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=multipart` : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const response = await driveFetch(token, url, { method: existing ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${upload.boundary}` }, body: upload.body });
  const saved = await response.json() as { id?: string };
  if (!saved.id) throw packageError();
  const verified = await readBackup(token, saved.id);
  if (verified.vaultId !== vaultId || verified.recoveryKey !== recoveryKey) throw packageError("Google Drive backup verification failed.");
}

export async function loadDriveRecoveryBackup(options: TokenRequestOptions = {}) {
  const token = await driveToken(options); const backup = await findBackup(token);
  if (!backup) throw packageError("No Cipher Budget recovery backup was found in this Google Drive account.", "missing-backup");
  return readBackup(token, backup.id);
}

/** Silently discovers an existing grant and recovery package; it never opens a Google popup. */
export async function checkDriveRecoveryBackup(loginHint?: string): Promise<DriveRecoveryCheck> {
  try {
    return { status: "connected", backup: await loadDriveRecoveryBackup({ prompt: "none", loginHint }) };
  } catch (error) {
    if (error instanceof DriveRecoveryError) return { status: error.kind };
    return { status: "unavailable" };
  }
}

export async function verifyDriveRecoveryBackup(vaultId: string, recoveryKey: string) {
  const backup = await loadDriveRecoveryBackup();
  if (backup.vaultId !== vaultId || backup.recoveryKey !== recoveryKey) throw packageError("This Google Drive backup does not match the current vault.");
}

export async function removeDriveRecoveryBackup(expectedVaultId?: string): Promise<DriveBackupRemoval> {
  const token = await driveToken(); const backup = await findBackup(token); if (!backup) return "not-found";
  if (expectedVaultId) {
    const packageToRemove = await readBackup(token, backup.id);
    if (packageToRemove.vaultId !== expectedVaultId) return "different-vault";
  }
  await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.id)}`, { method: "DELETE" });
  return "removed";
}
