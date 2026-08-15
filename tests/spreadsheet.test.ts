import { describe, expect, it } from "vitest";
import { importBudgetWorkbook, budgetWorkbook } from "@/lib/budget/spreadsheet";
import { clonePayMonth, createEmptyVault, type BudgetVault } from "@/lib/budget/types";

describe("budget spreadsheet transfer", () => {
  it("round-trips v3 pay-months, one income list, and recurring monthly expenses", async () => {
    const vault: BudgetVault = createEmptyVault(); vault.settings.defaultTargets = { needs: 55, goals: 25, wants: 20 };
    const month = clonePayMonth(undefined, "2026-08-14", { needs: 60, goals: 20, wants: 20 }, []);
    month.incomes.push({ id: "income-one", name: "Paycheck one", amountCents: 175000 }, { id: "income-two", name: "Paycheck two", amountCents: 175000 });
    month.expenses.push({ id: "expense", name: "Rent", amountCents: 120000, date: "2026-09-01", bucket: "needs", templateId: "rent" });
    vault.payMonths.push(month); vault.recurringExpenses.push({ id: "rent", name: "Rent", amountCents: 120000, bucket: "needs", dueDay: 1, active: true });
    const bytes = await budgetWorkbook(vault);
    const file = { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as File;
    const imported = await importBudgetWorkbook(file);
    expect(imported.settings).toEqual(vault.settings); expect(imported.payMonths).toHaveLength(1); expect(imported.payMonths[0]).toMatchObject({ startDate: "2026-08-14", endDate: "2026-09-10", targetPercentages: month.targetPercentages });
    expect(imported.payMonths[0].incomes.map((entry) => entry.name)).toEqual(["Paycheck one", "Paycheck two"]); expect(imported.payMonths[0].expenses[0]).toMatchObject({ name: "Rent", amountCents: 120000, date: "2026-09-01", bucket: "needs" }); expect(imported.recurringExpenses[0]).toMatchObject({ name: "Rent", dueDay: 1, active: true }); expect(imported.payMonths[0].expenses[0].templateId).toBe(imported.recurringExpenses[0].id);
  });
});
