import { describe, expect, it } from "vitest";
import { isDailyBackupDue } from "@/lib/drive/backup-reminder";

describe("daily Drive backup reminder", () => {
  it("is due until the current local day has a successful upload", () => {
    expect(isDailyBackupDue(undefined, "2026-08-23")).toBe(true);
    expect(isDailyBackupDue("2026-08-22", "2026-08-23")).toBe(true);
    expect(isDailyBackupDue("2026-08-23", "2026-08-23")).toBe(false);
  });
});
