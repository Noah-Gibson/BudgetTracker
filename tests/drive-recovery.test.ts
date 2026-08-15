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
});
