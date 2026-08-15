"use client";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "cipher-budget-recovery-v1.json";
const MIME_TYPE = "application/vnd.cipher-budget.recovery+json";
const GIS_SRC = "https://accounts.google.com/gsi/client";

export type DriveRecoveryPackage = { format: 1; vaultId: string; recoveryKey: string; createdAt: string };
export type DriveBackupRemoval = "removed" | "not-found" | "different-vault";

type TokenResponse = { access_token?: string; error?: string; error_description?: string; scope?: string };
type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };
type GoogleIdentity = { accounts: { oauth2: { initTokenClient: (options: { client_id: string; scope: string; callback: (response: TokenResponse) => void; error_callback?: (error: { type?: string; message?: string }) => void }) => TokenClient } } };

declare global { interface Window { google?: GoogleIdentity } }

function clientId() {
  const value = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID;
  if (!value) throw new Error("Google Drive backup is not configured for this deployment.");
  return value;
}

function packageError(message = "Your Google Drive backup could not be used.") { return new Error(message); }
let pendingTokenRequest: Promise<string> | null = null;

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

async function requestDriveToken() {
  const google = await loadGoogleIdentity();
  return await new Promise<string>((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(), scope: DRIVE_SCOPE,
      callback: (response) => {
        if (!response.access_token) { reject(packageError(response.error_description ?? "Google Drive access was not granted.")); return; }
        // Google may return a partial grant. Do not send a token to Drive when
        // the specific private app-data permission was declined or blocked.
        if (response.scope && !response.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
          reject(packageError("Google did not grant Cipher Budget permission to its private Drive app-data folder. Approve the requested Drive permission and try again."));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: (error) => reject(packageError(error.message ?? "Google Drive access was cancelled."))
    });
    client.requestAccessToken({ prompt: "consent" });
  });
}

async function driveToken() {
  // Google permits the token chooser only from a direct user action. Reuse a
  // pending request so a double-click or overlapping backup operation cannot
  // open a second popup and leave one of the requests without a token.
  if (!pendingTokenRequest) pendingTokenRequest = requestDriveToken().finally(() => { pendingTokenRequest = null; });
  return pendingTokenRequest;
}

type DriveApiError = { error?: { message?: string; errors?: { reason?: string }[] } };
async function driveFailure(response: Response) {
  const body = await response.clone().json().catch(() => null) as DriveApiError | null;
  const message = body?.error?.message ?? "";
  const reason = body?.error?.errors?.[0]?.reason ?? "";
  if (response.status === 401) return packageError("Google Drive did not accept this authorization. Click the backup button again and approve the private Drive permission.");
  if (response.status === 403 && (reason === "accessNotConfigured" || reason === "serviceDisabled" || /has not been used|is disabled/i.test(message))) {
    return packageError("The Google Drive API is not enabled for this Google Cloud project. Enable the Google Drive API, then try again.");
  }
  if (response.status === 403 && (reason === "insufficientPermissions" || /insufficient authentication scopes|permission/i.test(message))) {
    return packageError("Google did not grant access to Cipher Budget’s private Drive app-data folder. Add the drive.appdata scope in Google Cloud’s Data Access page, then approve the permission and try again.");
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
export async function saveDriveRecoveryBackup(vaultId: string, recoveryKey: string) {
  const token = await driveToken();
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

export async function loadDriveRecoveryBackup() {
  const token = await driveToken(); const backup = await findBackup(token);
  if (!backup) throw packageError("No Cipher Budget recovery backup was found in this Google Drive account.");
  return readBackup(token, backup.id);
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
