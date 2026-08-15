import { describe, expect, it } from "vitest";
import { createEmptyVault } from "@/lib/budget/types";
import { decryptVault, encryptVault, generateVaultKey, unwrapWithRecovery, wrapWithRecovery } from "@/lib/crypto/vault";

describe("encrypted vault envelope", () => {
  it("round-trips only with the recovery key and rejects tampering", async () => {
    const key = await generateVaultKey();
    const recovery = "private-recovery-key-that-never-leaves-the-browser";
    const wrapper = await wrapWithRecovery(key, recovery);
    const encrypted = await encryptVault(createEmptyVault(), key, "e6c6dd2d-17e2-4653-b307-8ec93d8c3e07", 1);
    const unlocked = await unwrapWithRecovery(recovery, wrapper.recoverySalt, wrapper.recoveryWrappedKey);
    await expect(decryptVault({ ...encrypted, ...wrapper, vaultId: "e6c6dd2d-17e2-4653-b307-8ec93d8c3e07", revision: 1 }, unlocked)).resolves.toMatchObject({ version: 3 });
    const altered = `${encrypted.ciphertext[0] === "A" ? "B" : "A"}${encrypted.ciphertext.slice(1)}`;
    await expect(decryptVault({ ...encrypted, ...wrapper, ciphertext: altered, vaultId: "e6c6dd2d-17e2-4653-b307-8ec93d8c3e07", revision: 1 }, unlocked)).rejects.toThrow();
  });
});
