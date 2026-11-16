import { describe, expect, it } from "vitest";
import { calculateInsights, selectInsightPayMonths, sortPayMonths } from "@/lib/budget/insights";
import type { PayMonth } from "@/lib/budget/types";

const month = (id: string, startDate: string, income: number, expenses: PayMonth["expenses"], targets = { needs: 50, goals: 30, wants: 20 }): PayMonth => ({ id, startDate, endDate: startDate, targetPercentages: targets, incomes: income ? [{ id: `${id}-income`, name: "Pay", amountCents: income }] : [], expenses });

describe("budget insights", () => {
  const january = month("jan", "2026-01-01", 100000, [{ id: "rent", name: "Rent", amountCents: 60000, bucket: "needs" }, { id: "fun", name: "Fun", amountCents: 10000, bucket: "wants" }]);
  const february = month("feb", "2026-02-01", 200000, [{ id: "debt", name: "Debt", amountCents: 80000, bucket: "goals" }, { id: "food", name: "Food", amountCents: 40000, bucket: "needs" }], { needs: 20, goals: 60, wants: 20 });
  const march = month("mar", "2026-03-01", 0, []);

  it("sorts and selects historical pay-month ranges", () => {
    expect(sortPayMonths([february, january]).map((item) => item.id)).toEqual(["jan", "feb"]);
    expect(selectInsightPayMonths([january, february, march], "last-3").map((item) => item.id)).toEqual(["jan", "feb", "mar"]);
    expect(selectInsightPayMonths([january, february, march], { startId: "mar", endId: "feb" }).map((item) => item.id)).toEqual(["feb", "mar"]);
    expect(selectInsightPayMonths([january], { startId: "missing", endId: "jan" })).toEqual([]);
  });

  it("uses every pay-month's own targets and reports aggregate trends", () => {
    const insights = calculateInsights([february, january], "2026-03-01");
    expect(insights.incomeCents).toBe(300000);
    expect(insights.expenseCents).toBe(190000);
    expect(insights.leftCents).toBe(110000);
    expect(insights.savingsCents).toBe(110000);
    expect(insights.averageExpenseCents).toBe(95000);
    expect(insights.periods.find((period) => period.id === "jan")).toMatchObject({ budgetCents: 100000 });
    expect(insights.categories.find((item) => item.bucket === "needs")).toMatchObject({ actualCents: 100000, plannedCents: 90000, varianceCents: 10000 });
    expect(insights.categories.find((item) => item.bucket === "goals")).toMatchObject({ actualCents: 80000, savingsCents: 110000, allocatedCents: 190000, plannedCents: 150000, varianceCents: 40000 });
    expect(insights.highestSpend.bucket).toBe("goals");
    expect(insights.largestChange?.changeCents).toBe(50000);
    expect(insights.furthestFromPlan.bucket).toBe("wants");
  });

  it("keeps empty and zero-spending data safe", () => {
    const empty = calculateInsights([]);
    expect(empty.averageExpenseCents).toBe(0);
    expect(empty.largestChange).toBeUndefined();
    const zero = calculateInsights([march]);
    expect(zero.categories.every((item) => item.sharePercent === 0)).toBe(true);
    expect(zero.leftCents).toBe(0);
  });

  it("does not treat an in-progress pay-month's remainder as savings", () => {
    const current = month("current", "2026-12-01", 100000, [{ id: "groceries", name: "Groceries", amountCents: 25000, bucket: "needs" }]);
    const insights = calculateInsights([current], "2026-11-15");
    expect(insights.savingsCents).toBe(0);
    expect(insights.categories.find((item) => item.bucket === "goals")).toMatchObject({ savingsCents: 0, allocatedCents: 0 });
  });
});
