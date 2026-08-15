export type Bucket = "needs" | "goals" | "wants";

export type IncomeEntry = { id: string; name: string; amountCents: number; date?: string };
export type ExpenseEntry = { id: string; name: string; amountCents: number; date?: string; bucket: Bucket; recurring: boolean };
export type BudgetPeriod = {
  id: string; startDate: string; endDate: string; targetPercentages: Record<Bucket, number>;
  incomes: IncomeEntry[]; expenses: ExpenseEntry[];
};
export type BudgetVault = {
  version: 1; settings: { defaultTargets: Record<Bucket, number> };
  periods: BudgetPeriod[];
};

export const bucketMeta: Record<Bucket, { label: string; tone: string }> = {
  needs: { label: "Needs", tone: "needs" },
  goals: { label: "Loans, savings & investing", tone: "goals" },
  wants: { label: "Disposable", tone: "wants" }
};

export const defaultTargets: Record<Bucket, number> = { needs: 50, goals: 30, wants: 20 };
export const newId = () => crypto.randomUUID();
export const todayISO = () => new Date().toISOString().slice(0, 10);

export function addDays(start: string, days: number) {
  const d = new Date(`${start}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10);
}

export function createEmptyVault(): BudgetVault {
  return { version: 1, settings: { defaultTargets }, periods: [] };
}

export function clonePeriod(previous: BudgetPeriod | undefined, startDate: string, targets: Record<Bucket, number>): BudgetPeriod {
  const endDate = addDays(startDate, 13);
  return {
    id: newId(), startDate, endDate, targetPercentages: { ...targets },
    incomes: previous?.incomes.map((income) => ({ ...income, id: newId(), date: undefined })) ?? [],
    expenses: previous?.expenses.filter((expense) => expense.recurring).map((expense) => ({ ...expense, id: newId(), date: undefined })) ?? []
  };
}

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function parseMoney(value: string) {
  const n = Number(value.replace(/[$,\s]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function totals(period: BudgetPeriod) {
  const income = period.incomes.reduce((sum, item) => sum + item.amountCents, 0);
  const expenses = period.expenses.reduce((sum, item) => sum + item.amountCents, 0);
  const byBucket = (bucket: Bucket) => period.expenses.filter((item) => item.bucket === bucket).reduce((sum, item) => sum + item.amountCents, 0);
  return { income, expenses, remaining: income - expenses, byBucket };
}
