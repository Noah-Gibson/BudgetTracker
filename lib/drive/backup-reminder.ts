export function isDailyBackupDue(lastSuccessfulDate: string | undefined, today: string) {
  return lastSuccessfulDate !== today;
}

export function dailyBackupReminderKey(email: string, date: string) {
  return `cipher-budget-drive-backup-dismissed:${email}:${date}`;
}
