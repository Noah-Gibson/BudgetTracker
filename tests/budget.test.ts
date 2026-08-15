import { describe, expect, it } from "vitest";
import { clonePeriod, createEmptyVault, defaultTargets, totals } from "@/lib/budget/types";

describe("budget calculations", () => {
  it("calculates income, expenses, and balances in integer cents", () => {
    const period = clonePeriod(undefined, "2026-08-14", defaultTargets);
    period.incomes.push({ id: "income", name: "Pay", amountCents: 200000 });
    period.expenses.push({ id: "rent", name: "Rent", amountCents: 80000, bucket: "needs", recurring: true });
    period.expenses.push({ id: "fund", name: "Fund", amountCents: 20000, bucket: "goals", recurring: true });
    const result = totals(period);
    expect(result).toMatchObject({ income: 200000, expenses: 100000, remaining: 100000 });
    expect(result.byBucket("needs")).toBe(80000);
  });

  it("copies income and only recurring expenses into a fresh period", () => {
    const prior = clonePeriod(undefined, "2026-08-14", defaultTargets);
    prior.incomes.push({ id: "i", name: "Pay", amountCents: 200000 });
    prior.expenses.push({ id: "a", name: "Rent", amountCents: 80000, bucket: "needs", recurring: true }, { id: "b", name: "Dinner", amountCents: 5000, bucket: "wants", recurring: false });
    const next = clonePeriod(prior, "2026-08-28", createEmptyVault().settings.defaultTargets);
    expect(next.endDate).toBe("2026-09-10"); expect(next.incomes).toHaveLength(1); expect(next.expenses).toHaveLength(1); expect(next.expenses[0].name).toBe("Rent");
  });
});
