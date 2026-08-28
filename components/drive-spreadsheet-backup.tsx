"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "primereact/button";
import { Checkbox } from "primereact/checkbox";
import { Dialog } from "primereact/dialog";
import type { BudgetVault } from "@/lib/budget/types";
import { budgetWorkbook } from "@/lib/budget/spreadsheet";
import { beginDriveSpreadsheetAuthorization, removeDriveSpreadsheetBackups, saveDriveSpreadsheetBackup, type SpreadsheetBackupResult } from "@/lib/drive/recovery";
import { isDailyBackupDue } from "@/lib/drive/backup-reminder";

type Props = {
  vault: BudgetVault;
  email: string;
  driveReady: boolean;
  onChange: (vault: BudgetVault) => void;
  onBackupSuccess: (result: SpreadsheetBackupResult) => void;
};

function localDate() {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function displayDate(value?: string) { return value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Not backed up yet"; }

export function DriveSpreadsheetBackup({ vault, email, driveReady, onChange, onBackupSuccess }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const settings = vault.spreadsheetBackup;
  const today = localDate();
  const [reminderVisible, setReminderVisible] = useState(false);

  useEffect(() => { setReminderVisible(Boolean(settings?.enabled && isDailyBackupDue(settings.lastSuccessfulDate, today))); }, [settings?.enabled, settings?.lastSuccessfulDate, today]);

  const upload = useCallback(async (snapshot: BudgetVault, authorization: Promise<string>) => {
    const activeSettings = snapshot.spreadsheetBackup;
    if (!activeSettings?.enabled) return;
    setBusy(true); setNotice("");
    try {
      const bytes = await budgetWorkbook(snapshot);
      const result = await saveDriveSpreadsheetBackup({ bytes, backupDate: localDate(), folderId: activeSettings.folderId, authorization });
      onBackupSuccess(result);
      setReminderVisible(false);
      setNotice(`Spreadsheet backup saved to Google Drive on ${displayDate(result.backupDate)}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Google Drive could not save the spreadsheet backup.");
    } finally { setBusy(false); }
  }, [onBackupSuccess]);

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
  const dismissReminder = () => setReminderVisible(false);
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

  const due = Boolean(settings?.enabled && isDailyBackupDue(settings.lastSuccessfulDate, today));
  const dailyReminderOpen = due && reminderVisible;
  useEffect(() => {
    if (!dailyReminderOpen) return;
    const root = document.documentElement;
    const body = document.body;
    const scrollY = window.scrollY;
    const original = { rootOverflow: root.style.overflow, bodyOverflow: body.style.overflow, bodyPosition: body.style.position, bodyTop: body.style.top, bodyLeft: body.style.left, bodyRight: body.style.right, bodyWidth: body.style.width };
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return () => {
      root.style.overflow = original.rootOverflow;
      body.style.overflow = original.bodyOverflow;
      body.style.position = original.bodyPosition;
      body.style.top = original.bodyTop;
      body.style.left = original.bodyLeft;
      body.style.right = original.bodyRight;
      body.style.width = original.bodyWidth;
      window.scrollTo(0, scrollY);
    };
  }, [dailyReminderOpen]);
  return <><section className="drive-backup-settings spreadsheet-backup-settings"><div><i className="pi pi-file-excel" /><span><strong>Daily Google Drive backup</strong><small>Creates a readable, unencrypted .xlsx copy in your visible Google Drive. It stays private from Cipher Budget, but Google and anyone with access to your Drive can read it.</small>{settings?.enabled && <small>Last backup: {displayDate(settings.lastSuccessfulDate)}. When today&apos;s backup is due, tap once to authorize the upload.</small>}</span></div><div className="data-tool-actions">{settings?.enabled ? <><Button outlined label="Back up now" icon="pi pi-cloud-upload" loading={busy} disabled={!driveReady} onClick={backupNow} />{settings.folderId && <Button text label="Open folder" icon="pi pi-external-link" disabled={busy} onClick={() => window.open(`https://drive.google.com/drive/folders/${encodeURIComponent(settings.folderId!)}`, "_blank", "noopener,noreferrer")} />}<Button text severity="secondary" label="Disable" icon="pi pi-pause" disabled={busy} onClick={disable} />{settings.folderId && <Button text severity="danger" label="Remove backups" icon="pi pi-trash" disabled={busy} onClick={() => void remove()} />}</> : <><div className="remember-choice"><Checkbox inputId="automatic-drive-spreadsheet" checked={false} onChange={enable} disabled={!driveReady || busy} /><label htmlFor="automatic-drive-spreadsheet">Enable a daily Google Drive backup reminder</label></div><Button label="Enable Google Drive backups" icon="pi pi-google" loading={busy} disabled={!driveReady} onClick={enable} /></>}</div>{!driveReady && <p className="transfer-status" role="status">Preparing Google Drive access…</p>}{notice && <p className="transfer-status" role="status">{notice}</p>}</section><Dialog visible={dailyReminderOpen} modal closable={!busy} dismissableMask={!busy} className="daily-backup-dialog" header="Back up your budget" onHide={dismissReminder}><div className="daily-backup-prompt"><i className="pi pi-cloud-upload" aria-hidden="true" /><h2>Today&apos;s Google Drive backup is due</h2><p>Save a readable spreadsheet copy of your budget to your Google Drive now. Your information remains private from Cipher Budget, but anyone with access to your Drive can read this file.</p>{!driveReady && <p className="form-help">Preparing Google Drive access…</p>}{notice && <p className="transfer-status" role="status">{notice}</p>}<div className="button-row"><Button label="Back up to Google Drive" icon="pi pi-cloud-upload" loading={busy} disabled={!driveReady} onClick={backupNow} /><Button text label="Not now" disabled={busy} onClick={dismissReminder} /></div></div></Dialog></>;
}
