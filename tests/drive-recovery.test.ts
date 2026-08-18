import { afterEach, describe, expect, it, vi } from "vitest";

const scope = "https://www.googleapis.com/auth/drive.appdata";

describe("Google Drive recovery authorization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("silently reuses an existing grant without a second Google request", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
    const prompts: (string | undefined)[] = [];
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (options: { callback: (response: { access_token: string; expires_in: number; scope: string }) => void }) => ({
              requestAccessToken: (request?: { prompt?: string }) => {
                prompts.push(request?.prompt);
                options.callback({ access_token: "memory-only-token", expires_in: 300, scope });
              }
            })
          }
        }
      }
    });
    const responses = [
      { files: [{ id: "backup-id", modifiedTime: "2026-08-15T00:00:00Z" }] },
      { format: 1, vaultId: "vault-1", recoveryKey: "recovery-secret", createdAt: "2026-08-15T00:00:00Z" },
      { files: [{ id: "backup-id", modifiedTime: "2026-08-15T00:00:00Z" }] },
      { format: 1, vaultId: "vault-1", recoveryKey: "recovery-secret", createdAt: "2026-08-15T00:00:00Z" }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "Content-Type": "application/json" } })));

    const { checkDriveRecoveryBackup, loadDriveRecoveryBackup } = await import("@/lib/drive/recovery");
    const result = await checkDriveRecoveryBackup("person@example.com");
    const followUp = await loadDriveRecoveryBackup({ prompt: "", loginHint: "person@example.com" });

    expect(result).toMatchObject({ status: "connected", backup: { vaultId: "vault-1" } });
    expect(followUp.vaultId).toBe("vault-1");
    expect(prompts).toEqual(["none"]);
  });

  it("uploads a dated spreadsheet using the separate visible-file scope and retains 30 backups", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
    const requestedScopes: string[] = [];
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (options: { scope: string; callback: (response: { access_token: string; expires_in: number; scope: string }) => void }) => ({
              requestAccessToken: () => {
                requestedScopes.push(options.scope);
                options.callback({ access_token: "visible-file-token", expires_in: 300, scope: options.scope });
              }
            })
          }
        }
      }
    });
    const files = Array.from({ length: 31 }, (_, index) => ({ id: `file-${index}`, name: `Cipher Budget backup — 2026-08-${String(31 - index).padStart(2, "0")}.xlsx`, createdTime: `2026-08-${String(31 - index).padStart(2, "0")}T00:00:00Z`, modifiedTime: "2026-08-01T00:00:00Z" }));
    const responses = [
      { id: "folder-id" },
      { files: [] },
      { id: "today-file" },
      { files }
    ];
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const { beginDriveSpreadsheetAuthorization, saveDriveSpreadsheetBackup } = await import("@/lib/drive/recovery");
    const result = await saveDriveSpreadsheetBackup({ bytes: new Uint8Array([1, 2, 3]), backupDate: "2026-08-31", authorization: beginDriveSpreadsheetAuthorization("person@example.com") });

    expect(requestedScopes).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    expect(result).toMatchObject({ folderId: "folder-id", fileId: "today-file", backupDate: "2026-08-31" });
    expect(calls.some((call) => call.input.includes("upload/drive/v3/files"))).toBe(true);
    expect(calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);
    expect(calls.find((call) => call.init?.method === "DELETE")?.input).toContain("file-30");
  });
});
