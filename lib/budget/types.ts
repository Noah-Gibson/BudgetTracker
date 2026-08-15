export type Bucket = "needs" | "goals" | "wants";

export type IncomeEntry = { id: string; name: string; amountCents: number; date?: string };
export type ExpenseEntry = { id: string; name: string; amountCents: number; date?: string; bucket: Bucket; templateId?: string };
/** Stored in the encrypted vault; it intentionally has no dedicated UI panel. */
export type RecurringExpense = { id: string; name: string; amountCents: number; bucket: Bucket; dueDay: number; active: boolean };
export type PayMonth = { id: string; startDate: string; endDate: string; targetPercentages: Record<Bucket, number>; incomes: IncomeEntry[]; expenses: ExpenseEntry[] };
export type BudgetVault = { version: 3; settings: { defaultTargets: Record<Bucket, number> }; payMonths: PayMonth[]; recurringExpenses: RecurringExpense[] };

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
export const todayISO = () => new Date().toISOString().slice(0, 10);

export function addDays(start: string, days: number) { const d = new Date(`${start}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
export function createEmptyVault(): BudgetVault { return { version: 3, settings: { defaultTargets: { ...defaultTargets } }, payMonths: [], recurringExpenses: [] }; }
export function dueDateForMonth(year: number, month: number, dueDay: number) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(Math.max(1, dueDay), lastDay), 12).toISOString().slice(0, 10);
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
  const expenses = recurringExpenses.flatMap((expense) => expense.active ? dueDatesWithin(startDate, endDate, expense.dueDay).map((date) => ({ id: newId(), name: expense.name, amountCents: expense.amountCents, date, bucket: expense.bucket, templateId: expense.id })) : []);
  return { id: newId(), startDate, endDate, targetPercentages: { ...targets }, incomes, expenses };
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
  return { income, expenses, remaining: income - expenses, byBucket };
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
