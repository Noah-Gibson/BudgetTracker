export function isDailyBackupDue(lastSuccessfulDate: string | undefined, today: string) {
  return lastSuccessfulDate !== today;
}
