import { describe, expect, it } from "vitest";
import { importBudgetWorkbook, budgetWorkbook } from "@/lib/budget/spreadsheet";
import { createEmptyVault, type BudgetVault } from "@/lib/budget/types";

describe("budget spreadsheet transfer", () => {
  it("round-trips periods, targets, income, and expenses", async () => {
    const vault: BudgetVault = {
      ...createEmptyVault(),
      settings: { defaultTargets: { needs: 55, goals: 25, wants: 20 } },
      periods: [{
        id: "original-period", startDate: "2026-08-14", endDate: "2026-08-27",
        targetPercentages: { needs: 60, goals: 20, wants: 20 },
        incomes: [{ id: "income", name: "Paycheck", amountCents: 350000 }],
        expenses: [{ id: "expense", name: "Rent", amountCents: 120000, date: "2026-08-15", bucket: "needs", recurring: true }],
      }],
    };
    const bytes = await budgetWorkbook(vault);
    const file = { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as File;
    const imported = await importBudgetWorkbook(file);

    expect(imported.settings).toEqual(vault.settings);
    expect(imported.periods).toHaveLength(1);
    expect(imported.periods[0]).toMatchObject({ startDate: "2026-08-14", endDate: "2026-08-27", targetPercentages: vault.periods[0].targetPercentages });
    expect(imported.periods[0].incomes[0]).toMatchObject({ name: "Paycheck", amountCents: 350000 });
    expect(imported.periods[0].expenses[0]).toMatchObject({ name: "Rent", amountCents: 120000, date: "2026-08-15", bucket: "needs", recurring: true });
  });
});
