import { describe, expect, it } from "vitest";
import { backfillRecurringExpense, clonePayMonth, createEmptyVault, creditCardExpenseTotal, creditCardExpenses, creditCardPaymentCycleEndDate, creditCardPaymentExpenses, creditCardPaymentTotal, dueDateForMonth, dueDatesWithin, expenseListGroups, futureExpenseTotal, searchExpenses, todayISO, totals, upgradeVault, type BudgetVault, type LegacyBudgetVault } from "@/lib/budget/types";

describe("pay-month budgets", () => {
  it("uses the device's local calendar date for today", () => {
    const localLateEvening = new Date(2026, 7, 23, 23, 0, 0);
    expect(todayISO(localLateEvening)).toBe("2026-08-23");
  });

  it("creates a 28-day pay-month with one income list and cycle-wide totals", () => {
    const month = clonePayMonth(undefined, "2026-08-14", createEmptyVault().settings.defaultTargets, []);
    month.incomes.push({ id: "first", name: "First pay", amountCents: 200000 }, { id: "second", name: "Second pay", amountCents: 200000 });
    month.expenses.push({ id: "rent", name: "Rent", amountCents: 120000, bucket: "needs", date: "2026-09-01" });
    expect(month.endDate).toBe("2026-09-10");
    expect(totals(month)).toMatchObject({ income: 400000, expenses: 120000, remaining: 280000 });
  });

  it("keeps a fully allocated pay-month balanced when category rounding differs by a cent", () => {
    const month = clonePayMonth(undefined, "2026-08-14", { needs: 33.33, goals: 33.33, wants: 33.34 }, []);
    month.incomes.push({ id: "pay", name: "Pay", amountCents: 10005 });
    month.expenses.push(
      { id: "needs", name: "Needs", amountCents: 3335, bucket: "needs" },
      { id: "goals", name: "Goals", amountCents: 3335, bucket: "goals" },
      { id: "wants", name: "Wants", amountCents: 3336, bucket: "wants" }
    );
    expect(totals(month)).toMatchObject({ income: 10005, expenses: 10006, remaining: 0 });
  });

  it("copies all income and schedules recurring monthly expenses once", () => {
    const vault = createEmptyVault(); const recurring = { id: "rent", name: "Rent", amountCents: 120000, bucket: "needs" as const, dueDay: 31, active: true };
    const first = clonePayMonth(undefined, "2026-01-15", vault.settings.defaultTargets, [recurring]);
    first.incomes.push({ id: "one", name: "Pay", amountCents: 100000 }, { id: "two", name: "Pay", amountCents: 110000 });
    const next = clonePayMonth(first, "2026-02-12", vault.settings.defaultTargets, [recurring]);
    expect(next.incomes.map((entry) => entry.amountCents)).toEqual([100000, 110000]);
    expect(next.expenses).toHaveLength(1); expect(next.expenses[0].date).toBe("2026-02-28");
    expect(next.expenses[0].amountConfirmed).toBe(false);
    expect(dueDateForMonth(2028, 1, 31)).toBe("2028-02-29");
    expect(dueDatesWithin("2026-02-12", "2026-03-11", 1)).toEqual(["2026-03-01"]);
  });

  it("backfills a newly recurring expense into existing future pay-months without duplicates", () => {
    const vault = createEmptyVault();
    const current = clonePayMonth(undefined, "2026-01-15", vault.settings.defaultTargets, []);
    const future = clonePayMonth(current, "2026-02-12", vault.settings.defaultTargets, []);
    const later = clonePayMonth(future, "2026-03-12", vault.settings.defaultTargets, []);
    const rent = { id: "rent", name: "Rent", amountCents: 120000, bucket: "needs" as const, dueDay: 1, active: true };
    const populated = backfillRecurringExpense([current, future, later], current.startDate, [rent]);
    const repeated = backfillRecurringExpense(populated, current.startDate, [rent]);
    expect(populated[0].expenses).toHaveLength(0);
    expect(populated.slice(1).flatMap((month) => month.expenses.map((expense) => expense.date))).toEqual(["2026-03-01", "2026-04-01"]);
    expect(repeated.slice(1).flatMap((month) => month.expenses)).toHaveLength(2);
  });

  it("keeps recurring credit card links when autofilling new and existing future pay-months", () => {
    const vault = createEmptyVault();
    const cardExpense = { id: "card-payment", name: "Travel Visa", amountCents: 12500, bucket: "needs" as const, dueDay: 15, active: true, creditCardId: "travel-visa" };
    const current = clonePayMonth(undefined, "2026-01-15", vault.settings.defaultTargets, []);
    const next = clonePayMonth(current, "2026-02-12", vault.settings.defaultTargets, [cardExpense]);
    const future = clonePayMonth(next, "2026-03-12", vault.settings.defaultTargets, []);
    const backfilled = backfillRecurringExpense([current, next, future], current.startDate, [cardExpense]);

    expect(next.expenses[0]).toMatchObject({ templateId: "card-payment", creditCardId: "travel-visa" });
    expect(backfilled.slice(1).flatMap((month) => month.expenses).every((expense) => expense.creditCardId === "travel-visa")).toBe(true);
  });

  it("repairs legacy recurring card links before autofilling the next pay-month", () => {
    const vault: BudgetVault = {
      ...createEmptyVault(),
      recurringExpenses: [{ id: "card-payment", name: "Travel Visa", amountCents: 12500, bucket: "needs", dueDay: 15, active: true }],
      payMonths: [
        { id: "first", startDate: "2026-01-15", endDate: "2026-02-11", targetPercentages: { needs: 50, goals: 30, wants: 20 }, incomes: [], expenses: [{ id: "first-payment", name: "Travel Visa", amountCents: 12500, bucket: "needs", date: "2026-01-15", templateId: "card-payment", creditCardId: "travel-visa" }] },
        { id: "second", startDate: "2026-02-12", endDate: "2026-03-11", targetPercentages: { needs: 50, goals: 30, wants: 20 }, incomes: [], expenses: [{ id: "second-payment", name: "Travel Visa", amountCents: 12500, bucket: "needs", date: "2026-02-15", templateId: "card-payment" }] },
      ],
    };

    const repaired = upgradeVault(vault).vault;
    const next = clonePayMonth(repaired.payMonths[1], "2026-03-12", repaired.settings.defaultTargets, repaired.recurringExpenses);

    expect(repaired.recurringExpenses[0].creditCardId).toBe("travel-visa");
    expect(repaired.payMonths[1].expenses[0].creditCardId).toBe("travel-visa");
    expect(next.expenses[0].creditCardId).toBe("travel-visa");
  });

  it("does not restore a card link explicitly removed from a recurring template", () => {
    const vault: BudgetVault = {
      ...createEmptyVault(),
      recurringExpenses: [{ id: "card-payment", name: "Travel Visa", amountCents: 12500, bucket: "needs", dueDay: 15, active: true, creditCardId: null }],
      payMonths: [{ id: "first", startDate: "2026-01-15", endDate: "2026-02-11", targetPercentages: { needs: 50, goals: 30, wants: 20 }, incomes: [], expenses: [{ id: "first-payment", name: "Travel Visa", amountCents: 12500, bucket: "needs", date: "2026-01-15", templateId: "card-payment", creditCardId: "travel-visa" }] }],
    };

    expect(upgradeVault(vault).vault).toBe(vault);
  });

  it("groups expenses by date with current entries first and upcoming entries in due-date order", () => {
    const entries = [
      { id: "undated", name: "Cash", amountCents: 100 },
      { id: "yesterday", name: "Groceries", amountCents: 200, date: "2026-08-22" },
      { id: "today-first", name: "Coffee", amountCents: 300, date: "2026-08-23" },
      { id: "tomorrow", name: "Gas", amountCents: 400, date: "2026-08-24" },
      { id: "today-second", name: "Lunch", amountCents: 500, date: "2026-08-23" },
      { id: "later", name: "Rent", amountCents: 600, date: "2026-08-30" }
    ];
    const groups = expenseListGroups(entries, "2026-08-23");
    expect(groups.current.map((entry) => entry.id)).toEqual(["today-first", "today-second", "yesterday", "undated"]);
    expect(groups.future.map((entry) => entry.id)).toEqual(["tomorrow", "later"]);
    expect(expenseListGroups(entries.filter((entry) => entry.date !== "2026-08-24" && entry.date !== "2026-08-30"), "2026-08-23").future).toEqual([]);
    expect(futureExpenseTotal(entries, "2026-08-23")).toBe(1000);
  });

  it("searches expense names without changing their original order", () => {
    const entries = [
      { id: "groceries", name: "Groceries", amountCents: 9800 },
      { id: "gas", name: "Gas station", amountCents: 4500 },
      { id: "meal", name: "Groceries delivery", amountCents: 6600 }
    ];

    expect(searchExpenses(entries, "  GROCERIES ").map((entry) => entry.id)).toEqual(["groceries", "meal"]);
    expect(searchExpenses(entries, "")).toEqual(entries);
  });

  it("keeps credit card payment settings in a new encrypted vault", () => {
    const vault = createEmptyVault();
    vault.creditCards?.push({ id: "visa", name: "Travel Visa", statementCloseDay: 15 });
    expect(vault.creditCards).toEqual([{ id: "visa", name: "Travel Visa", statementCloseDay: 15 }]);
    expect(dueDatesWithin("2026-08-14", "2026-09-10", vault.creditCards![0].statementCloseDay!)).toEqual(["2026-08-15"]);
  });

  it("lists only the selected card’s expenses and total for the active pay-month", () => {
    const month = clonePayMonth(undefined, "2026-08-14", createEmptyVault().settings.defaultTargets, []);
    month.expenses.push(
      { id: "flight", name: "Flight", amountCents: 45500, bucket: "wants", creditCardId: "travel" },
      { id: "hotel", name: "Hotel", amountCents: 22500, bucket: "wants", creditCardId: "travel" },
      { id: "groceries", name: "Groceries", amountCents: 9800, bucket: "needs", creditCardId: "cashback" },
      { id: "rent", name: "Rent", amountCents: 120000, bucket: "needs" }
    );
    expect(creditCardExpenses(month, "travel").map((expense) => expense.name)).toEqual(["Flight", "Hotel"]);
    expect(creditCardExpenseTotal(month, "travel")).toBe(68000);
    expect(creditCardExpenseTotal(month, "cashback")).toBe(9800);
  });

  it("keeps card purchases in their spending pay-month and forecasts their full payment for the following billing cycle", () => {
    const vault = createEmptyVault();
    vault.creditCards?.push({ id: "travel", name: "Travel Visa", statementCloseDay: 15 });
    const april = clonePayMonth(undefined, "2026-04-01", vault.settings.defaultTargets, []);
    const may = clonePayMonth(april, "2026-04-29", vault.settings.defaultTargets, []);
    const june = clonePayMonth(may, "2026-05-27", vault.settings.defaultTargets, []);
    const beforeClose = { id: "hotel", name: "Hotel", amountCents: 22500, bucket: "wants" as const, date: "2026-04-10", creditCardId: "travel", creditCardPaymentCycleEndDate: creditCardPaymentCycleEndDate("2026-04-10", 15) };
    const afterClose = { id: "flight", name: "Flight", amountCents: 45500, bucket: "wants" as const, date: "2026-04-20", creditCardId: "travel", creditCardPaymentCycleEndDate: creditCardPaymentCycleEndDate("2026-04-20", 15) };
    april.expenses.push(beforeClose, afterClose); vault.payMonths.push(april, may, june);

    expect(beforeClose.creditCardPaymentCycleEndDate).toBe("2026-05-15");
    expect(afterClose.creditCardPaymentCycleEndDate).toBe("2026-06-15");
    expect(creditCardExpenseTotal(april, "travel")).toBe(68000);
    expect(creditCardPaymentTotal(vault, may, "travel")).toBe(22500);
    expect(creditCardPaymentExpenses(vault, june, "travel").map(({ expense }) => expense.name)).toEqual(["Flight"]);
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
