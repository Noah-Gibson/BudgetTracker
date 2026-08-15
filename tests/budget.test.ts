import { describe, expect, it } from "vitest";
import { clonePayMonth, createEmptyVault, dueDateForMonth, dueDatesWithin, totals, upgradeVault, type LegacyBudgetVault } from "@/lib/budget/types";

describe("pay-month budgets", () => {
  it("creates a 28-day pay-month with one income list and cycle-wide totals", () => {
    const month = clonePayMonth(undefined, "2026-08-14", createEmptyVault().settings.defaultTargets, []);
    month.incomes.push({ id: "first", name: "First pay", amountCents: 200000 }, { id: "second", name: "Second pay", amountCents: 200000 });
    month.expenses.push({ id: "rent", name: "Rent", amountCents: 120000, bucket: "needs", date: "2026-09-01" });
    expect(month.endDate).toBe("2026-09-10");
    expect(totals(month)).toMatchObject({ income: 400000, expenses: 120000, remaining: 280000 });
  });

  it("copies all income and schedules recurring monthly expenses once", () => {
    const vault = createEmptyVault(); const recurring = { id: "rent", name: "Rent", amountCents: 120000, bucket: "needs" as const, dueDay: 31, active: true };
    const first = clonePayMonth(undefined, "2026-01-15", vault.settings.defaultTargets, [recurring]);
    first.incomes.push({ id: "one", name: "Pay", amountCents: 100000 }, { id: "two", name: "Pay", amountCents: 110000 });
    const next = clonePayMonth(first, "2026-02-12", vault.settings.defaultTargets, [recurring]);
    expect(next.incomes.map((entry) => entry.amountCents)).toEqual([100000, 110000]);
    expect(next.expenses).toHaveLength(1); expect(next.expenses[0].date).toBe("2026-02-28");
    expect(dueDateForMonth(2028, 1, 31)).toBe("2028-02-29");
    expect(dueDatesWithin("2026-02-12", "2026-03-11", 1)).toEqual(["2026-03-01"]);
  });

  it("consolidates legacy entries and creates dated recurring expenses locally", () => {
    const legacy: LegacyBudgetVault = { version: 1, settings: { defaultTargets: { needs: 50, goals: 30, wants: 20 } }, periods: [
      { id: "one", startDate: "2026-01-01", endDate: "2026-01-14", targetPercentages: { needs: 50, goals: 30, wants: 20 }, incomes: [{ id: "income-one", name: "Pay", amountCents: 100000 }], expenses: [{ id: "rent-one", name: "Rent", amountCents: 80000, bucket: "needs", recurring: true, date: "2026-01-05" }] },
      { id: "two", startDate: "2026-01-15", endDate: "2026-01-28", targetPercentages: { needs: 50, goals: 30, wants: 20 }, incomes: [{ id: "income-two", name: "Pay", amountCents: 100000 }], expenses: [{ id: "food", name: "Food", amountCents: 10000, bucket: "needs", recurring: false }] }
    ] };
    const upgraded = upgradeVault(legacy).vault;
    expect(upgraded.version).toBe(3); expect(upgraded.payMonths).toHaveLength(1); expect(upgraded.payMonths[0].incomes).toHaveLength(2); expect(upgraded.payMonths[0].expenses).toHaveLength(2); expect(upgraded.recurringExpenses[0]).toMatchObject({ name: "Rent", dueDay: 5 });
  });
});
