export type Bucket = "needs" | "goals" | "wants";

export type IncomeEntry = { id: string; name: string; amountCents: number; date?: string };
export type CreditCardPayment = { id: string; name: string; dueDay: number };
export type ExpenseEntry = { id: string; name: string; amountCents: number; date?: string; bucket: Bucket; templateId?: string; amountConfirmed?: boolean; creditCardId?: string };
/** Stored in the encrypted vault; it intentionally has no dedicated UI panel. */
export type RecurringExpense = { id: string; name: string; amountCents: number; bucket: Bucket; dueDay: number; active: boolean };
export type PayMonth = { id: string; startDate: string; endDate: string; targetPercentages: Record<Bucket, number>; incomes: IncomeEntry[]; expenses: ExpenseEntry[] };
export type SpreadsheetBackupSettings = { enabled: boolean; folderId?: string; lastSuccessfulDate?: string; lastBackupFileId?: string; lastBackupAt?: string };
// This is encrypted alongside the budget. It is a recovery-method label only;
// it never contains a Drive token, recovery secret, or any financial data.
export type BudgetVault = { version: 3; settings: { defaultTargets: Record<Bucket, number> }; payMonths: PayMonth[]; recurringExpenses: RecurringExpense[]; creditCards?: CreditCardPayment[]; recoveryProvider?: "google-drive"; spreadsheetBackup?: SpreadsheetBackupSettings };

// Decrypt-only formats. Every conversion below runs in the browser before re-encryption.
export type LegacyExpenseEntry = { id: string; name: string; amountCents: number; date?: string; bucket: Bucket; recurring: boolean };
export type LegacyBudgetPeriod = { id: string; startDate: string; endDate: string; targetPercentages: Record<Bucket, number>; incomes: IncomeEntry[]; expenses: LegacyExpenseEntry[] };
export type LegacyBudgetVault = { version: 1; settings: { defaultTargets: Record<Bucket, number> }; periods: LegacyBudgetPeriod[] };
export type V2PayPeriod = { id: string; startDate: string; endDate: string; incomes: IncomeEntry[] };
export type V2RecurringBill = { id: string; name: string; amountCents: number; bucket: Bucket; dueDay: number; active: boolean; notes?: string };
export type V2BudgetCycle = { id: string; startDate: string; endDate: string; targetPercentages: Record<Bucket, number>; payPeriods: [V2PayPeriod, V2PayPeriod]; expenses: ExpenseEntry[] };
export type V2BudgetVault = { version: 2; settings: { defaultTargets: Record<Bucket, number> }; cycles: V2BudgetCycle[]; recurringBills: V2RecurringBill[] };
export type VaultDocument = BudgetVault | V2BudgetVault | LegacyBudgetVault;
// Retired v2 names are retained solely so an unused compatibility view can be
// removed independently of existing encrypted-vault migrations.
export type PayPeriod = V2PayPeriod;
export type RecurringBill = V2RecurringBill;
export type BudgetCycle = V2BudgetCycle;
export type RecurringBillCandidate = { id: string; name: string; amountCents: number; bucket: Bucket; suggestedDueDay?: number };

export const bucketMeta: Record<Bucket, { label: string; tone: string }> = {
  needs: { label: "Needs", tone: "needs" }, goals: { label: "Loans, savings & investing", tone: "goals" }, wants: { label: "Disposable", tone: "wants" }
};
export const defaultTargets: Record<Bucket, number> = { needs: 50, goals: 30, wants: 20 };
export const newId = () => crypto.randomUUID();
/**
 * Format a calendar date in the browser's current local time zone. Dates in a
 * budget are calendar days, not UTC instants, so `toISOString()` would make
 * "today" become tomorrow for people west of UTC late in the evening.
 */
export function localDateISO(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
export const todayISO = (now = new Date()) => localDateISO(now);

export function expenseListGroups<T extends { date?: string }>(entries: T[], today = todayISO()) {
  const datedCurrent = entries.filter((entry) => entry.date && entry.date <= today).sort((left, right) => right.date!.localeCompare(left.date!));
  const undated = entries.filter((entry) => !entry.date);
  const future = entries.filter((entry) => entry.date && entry.date > today).sort((left, right) => left.date!.localeCompare(right.date!));
  return { current: [...datedCurrent, ...undated], future };
}

export function futureExpenseTotal(entries: Array<{ amountCents: number; date?: string }>, today = todayISO()) {
  return entries.reduce((total, entry) => total + (entry.date && entry.date > today ? entry.amountCents : 0), 0);
}

export function addDays(start: string, days: number) { const d = new Date(`${start}T12:00:00`); d.setDate(d.getDate() + days); return localDateISO(d); }
export function createEmptyVault(): BudgetVault { return { version: 3, settings: { defaultTargets: { ...defaultTargets } }, payMonths: [], recurringExpenses: [], creditCards: [] }; }
export function dueDateForMonth(year: number, month: number, dueDay: number) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return localDateISO(new Date(year, month, Math.min(Math.max(1, dueDay), lastDay), 12));
}
export function dueDatesWithin(startDate: string, endDate: string, dueDay: number) {
  const start = new Date(`${startDate}T12:00:00`); const end = new Date(`${endDate}T12:00:00`); const dates: string[] = [];
  for (let year = start.getFullYear(), month = start.getMonth(); year < end.getFullYear() || (year === end.getFullYear() && month <= end.getMonth()); month += 1) {
    const date = dueDateForMonth(year, month, dueDay); if (date >= startDate && date <= endDate) dates.push(date);
    if (month === 11) { year += 1; month = -1; }
  }
  return dates;
}
export function clonePayMonth(previous: PayMonth | undefined, startDate: string, targets: Record<Bucket, number>, recurringExpenses: RecurringExpense[]): PayMonth {
  const endDate = addDays(startDate, 27);
  const incomes = previous?.incomes.map((income) => ({ ...income, id: newId(), date: undefined })) ?? [];
  const expenses = recurringExpenses.flatMap((expense) => expense.active ? dueDatesWithin(startDate, endDate, expense.dueDay).map((date) => ({ id: newId(), name: expense.name, amountCents: expense.amountCents, date, bucket: expense.bucket, templateId: expense.id, amountConfirmed: false })) : []);
  return { id: newId(), startDate, endDate, targetPercentages: { ...targets }, incomes, expenses };
}
/** Add missing occurrences to already-created pay-months after the source month. */
export function backfillRecurringExpense(payMonths: PayMonth[], sourceMonthStartDate: string, expenses: RecurringExpense[]) {
  return payMonths.map((month) => {
    if (month.startDate <= sourceMonthStartDate) return month;
    const additions = expenses.flatMap((template) => template.active ? dueDatesWithin(month.startDate, month.endDate, template.dueDay)
      .filter((date) => !month.expenses.some((entry) => entry.templateId === template.id && entry.date === date))
      .map((date) => ({ id: newId(), name: template.name, amountCents: template.amountCents, date, bucket: template.bucket, templateId: template.id, amountConfirmed: false })) : []);
    return additions.length ? { ...month, expenses: [...month.expenses, ...additions] } : month;
  });
}
export function clonePeriod(previous: LegacyBudgetPeriod | undefined, startDate: string, targets: Record<Bucket, number>): LegacyBudgetPeriod {
  return { id: newId(), startDate, endDate: addDays(startDate, 13), targetPercentages: { ...targets }, incomes: previous?.incomes.map((income) => ({ ...income, id: newId(), date: undefined })) ?? [], expenses: previous?.expenses.filter((expense) => expense.recurring).map((expense) => ({ ...expense, id: newId(), date: undefined })) ?? [] };
}
export function cloneCycle(previous: BudgetCycle | undefined, startDate: string, targets: Record<Bucket, number>, bills: RecurringBill[]): BudgetCycle {
  const endDate = addDays(startDate, 27);
  const payPeriods: [PayPeriod, PayPeriod] = [{ id: newId(), startDate, endDate: addDays(startDate, 13), incomes: previous?.payPeriods[0].incomes.map((income) => ({ ...income, id: newId(), date: undefined })) ?? [] }, { id: newId(), startDate: addDays(startDate, 14), endDate, incomes: previous?.payPeriods[1].incomes.map((income) => ({ ...income, id: newId(), date: undefined })) ?? [] }];
  const expenses = bills.flatMap((bill) => bill.active ? dueDatesWithin(startDate, endDate, bill.dueDay).map((date) => ({ id: newId(), name: bill.name, amountCents: bill.amountCents, date, bucket: bill.bucket, templateId: bill.id })) : []);
  return { id: newId(), startDate, endDate, targetPercentages: { ...targets }, payPeriods, expenses };
}
export function totals(month: PayMonth | BudgetCycle | LegacyBudgetPeriod) {
  const income = "payPeriods" in month ? month.payPeriods.flatMap((period) => period.incomes).reduce((sum, item) => sum + item.amountCents, 0) : month.incomes.reduce((sum, item) => sum + item.amountCents, 0);
  const expenses = month.expenses.reduce((sum, item) => sum + item.amountCents, 0);
  const byBucket = (bucket: Bucket) => month.expenses.filter((item) => item.bucket === bucket).reduce((sum, item) => sum + item.amountCents, 0);
  const targets = (Object.keys(bucketMeta) as Bucket[]).reduce((sum, bucket) => sum + Math.round(income * month.targetPercentages[bucket] / 100), 0);
  // Category targets are rounded independently to whole cents. When their
  // percentages add to 100%, use the rounded category total so a fully allocated pay-month does
  // not display a phantom one-cent surplus or deficit.
  const targetPercentage = (Object.keys(bucketMeta) as Bucket[]).reduce((sum, bucket) => sum + month.targetPercentages[bucket], 0);
  const remaining = Math.abs(targetPercentage - 100) < 0.000001 ? targets - expenses : income - expenses;
  return { income, expenses, remaining, byBucket };
}
export function cyclePayPeriod(cycle: BudgetCycle, date?: string) { return date ? cycle.payPeriods.findIndex((period) => date >= period.startDate && date <= period.endDate) + 1 || undefined : undefined; }

function normalizeLegacyPeriods(document: LegacyBudgetVault): PayMonth[] {
  const periods = [...document.periods].sort((left, right) => left.startDate.localeCompare(right.startDate)); const months: PayMonth[] = [];
  for (let index = 0; index < periods.length; index += 2) {
    const first = periods[index]; const second = periods[index + 1]; const contiguous = second && second.startDate === addDays(first.endDate, 1);
    const incomes = [...first.incomes, ...(contiguous && second ? second.incomes : [])].map((entry) => ({ ...entry, id: newId() }));
    const expenses = [...first.expenses, ...(contiguous && second ? second.expenses : [])].map(({ recurring: _recurring, ...entry }) => ({ ...entry, id: newId() }));
    months.push({ id: newId(), startDate: first.startDate, endDate: contiguous && second ? second.endDate : addDays(first.startDate, 27), targetPercentages: { ...first.targetPercentages }, incomes, expenses });
    if (second && !contiguous) index -= 1;
  }
  return months;
}

export function upgradeVault(document: VaultDocument): { vault: BudgetVault } {
  if (document.version === 3) return { vault: document };
  if (document.version === 2) return { vault: {
    version: 3,
    settings: document.settings,
    payMonths: document.cycles.map((cycle) => ({ id: cycle.id, startDate: cycle.startDate, endDate: cycle.endDate, targetPercentages: cycle.targetPercentages, incomes: cycle.payPeriods.flatMap((period) => period.incomes), expenses: cycle.expenses })),
    recurringExpenses: document.recurringBills.map(({ notes: _notes, ...bill }) => bill)
  } };
  const recurringExpenses = new Map<string, RecurringExpense>();
  document.periods.forEach((period) => period.expenses.filter((expense) => expense.recurring && expense.date).forEach((expense) => {
    const key = `${expense.name.trim().toLowerCase()}|${expense.amountCents}|${expense.bucket}|${expense.date!.slice(8, 10)}`;
    if (!recurringExpenses.has(key)) recurringExpenses.set(key, { id: newId(), name: expense.name, amountCents: expense.amountCents, bucket: expense.bucket, dueDay: Number(expense.date!.slice(8, 10)), active: true });
  }));
  return { vault: { version: 3, settings: document.settings, payMonths: normalizeLegacyPeriods(document), recurringExpenses: [...recurringExpenses.values()] } };
}
export function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
