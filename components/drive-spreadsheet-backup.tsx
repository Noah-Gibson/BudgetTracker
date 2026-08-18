"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "primereact/button";
import { Checkbox } from "primereact/checkbox";
import type { BudgetVault } from "@/lib/budget/types";
import { budgetWorkbook } from "@/lib/budget/spreadsheet";
import { beginDriveSpreadsheetAuthorization, cachedDriveSpreadsheetAuthorization, removeDriveSpreadsheetBackups, saveDriveSpreadsheetBackup, type SpreadsheetBackupResult } from "@/lib/drive/recovery";

type Props = {
  vault: BudgetVault;
  email: string;
  driveReady: boolean;
  saveGeneration: number;
  onChange: (vault: BudgetVault) => void;
  onBackupSuccess: (result: SpreadsheetBackupResult) => void;
};

function localDate() {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function displayDate(value?: string) { return value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Not backed up yet"; }

export function DriveSpreadsheetBackup({ vault, email, driveReady, saveGeneration, onChange, onBackupSuccess }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const automaticTimer = useRef<number | null>(null);
  const settings = vault.spreadsheetBackup;
  const today = localDate();

  const upload = useCallback(async (snapshot: BudgetVault, authorization: Promise<string>) => {
    const activeSettings = snapshot.spreadsheetBackup;
    if (!activeSettings?.enabled) return;
    setBusy(true); setNotice("");
    try {
      const bytes = await budgetWorkbook(snapshot);
      const result = await saveDriveSpreadsheetBackup({ bytes, backupDate: localDate(), folderId: activeSettings.folderId, authorization });
      onBackupSuccess(result);
      setNotice(`Spreadsheet backup saved to Google Drive on ${displayDate(result.backupDate)}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Google Drive could not save the spreadsheet backup.");
    } finally { setBusy(false); }
  }, [onBackupSuccess]);

  useEffect(() => {
    if (automaticTimer.current) window.clearTimeout(automaticTimer.current);
    if (!saveGeneration || !settings?.enabled || settings.lastSuccessfulDate === today || busy) return;
    const token = cachedDriveSpreadsheetAuthorization(email);
    if (!token) return;
    automaticTimer.current = window.setTimeout(() => { void upload(vault, Promise.resolve(token)); }, 1_500);
    return () => { if (automaticTimer.current) window.clearTimeout(automaticTimer.current); };
  }, [busy, email, saveGeneration, settings?.enabled, settings?.lastSuccessfulDate, today, upload, vault]);

  const enable = () => {
    if (!driveReady || busy) return;
    // Start Google's popup in the direct click handler so Safari/iOS retains
    // the user activation required to grant the visible Drive-file scope.
    const authorization = beginDriveSpreadsheetAuthorization(email);
    const enabledVault: BudgetVault = { ...vault, spreadsheetBackup: { ...settings, enabled: true } };
    onChange(enabledVault);
    void upload(enabledVault, authorization);
  };
  const backupNow = () => {
    if (!settings?.enabled || !driveReady || busy) return;
    const authorization = beginDriveSpreadsheetAuthorization(email);
    void upload(vault, authorization);
  };
  const disable = () => {
    if (!settings || busy) return;
    onChange({ ...vault, spreadsheetBackup: { ...settings, enabled: false } });
    setNotice("Automatic Google Drive spreadsheet backups are off. Existing Drive files were kept.");
  };
  const remove = async () => {
    if (!settings?.folderId || busy) return;
    if (!window.confirm("Permanently delete the Cipher Budget folder and every spreadsheet backup inside it from Google Drive? This cannot be undone.")) return;
    // This is also initiated synchronously from the confirmation action.
    const authorization = beginDriveSpreadsheetAuthorization(email);
    setBusy(true); setNotice("");
    try {
      await removeDriveSpreadsheetBackups({ folderId: settings.folderId, authorization });
      onChange({ ...vault, spreadsheetBackup: undefined });
      setNotice("The Cipher Budget spreadsheet backup folder was removed from Google Drive.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Google Drive could not remove the spreadsheet backups."); } finally { setBusy(false); }
  };

  const needsTap = settings?.enabled && settings.lastSuccessfulDate !== today && !cachedDriveSpreadsheetAuthorization(email);
  return <section className="drive-backup-settings spreadsheet-backup-settings"><div><i className="pi pi-file-excel" /><span><strong>Automatic spreadsheet backup</strong><small>Creates a readable, unencrypted .xlsx copy in your visible Google Drive. It stays private from Cipher Budget, but Google and anyone with access to your Drive can read it.</small>{settings?.enabled && <small>Last backup: {displayDate(settings.lastSuccessfulDate)}. {needsTap ? "Tap Back up now to refresh Google Drive access for today." : "The app will back up at most once per day while it is open and authorized."}</small>}</span></div><div className="data-tool-actions">{settings?.enabled ? <><Button outlined label="Back up now" icon="pi pi-cloud-upload" loading={busy} disabled={!driveReady} onClick={backupNow} />{settings.folderId && <Button text label="Open folder" icon="pi pi-external-link" disabled={busy} onClick={() => window.open(`https://drive.google.com/drive/folders/${encodeURIComponent(settings.folderId!)}`, "_blank", "noopener,noreferrer")} />}<Button text severity="secondary" label="Disable" icon="pi pi-pause" disabled={busy} onClick={disable} />{settings.folderId && <Button text severity="danger" label="Remove backups" icon="pi pi-trash" disabled={busy} onClick={() => void remove()} />}</> : <><div className="remember-choice"><Checkbox inputId="automatic-drive-spreadsheet" checked={false} onChange={enable} disabled={!driveReady || busy} /><label htmlFor="automatic-drive-spreadsheet">Back up a readable spreadsheet to Google Drive daily</label></div><Button label="Enable Google Drive backups" icon="pi pi-google" loading={busy} disabled={!driveReady} onClick={enable} /></>}</div>{!driveReady && <p className="transfer-status" role="status">Preparing Google Drive access…</p>}{notice && <p className="transfer-status" role="status">{notice}</p>}</section>;
}
