import { addDays, bucketMeta, newId, totals, type Bucket, type BudgetPeriod, type BudgetVault, type ExpenseEntry, type IncomeEntry } from "./types";

const FORMAT_TITLE = "Cipher Budget Export";
const FORMAT_VERSION = 1;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10_000;
const buckets: Bucket[] = ["needs", "goals", "wants"];

function safeText(value: string) {
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function valueText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return /^'(?=[=+\-@])/.test(text) ? text.slice(1) : text;
}

function requiredText(value: unknown, label: string) {
  const text = valueText(value);
  if (!text) throw new Error(`${label} is required in the imported workbook.`);
  return text;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
}

function amountCents(value: unknown, label: string) {
  const amount = typeof value === "number" ? value : Number(valueText(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) > Number.MAX_SAFE_INTEGER) throw new Error(`${label} must be a positive dollar amount.`);
  return Math.round(amount * 100);
}

function target(value: unknown, label: string) {
  const percentage = typeof value === "number" ? value : Number(valueText(value));
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error(`${label} must be between 0 and 100.`);
  return percentage;
}

function columnLabel(bucket: Bucket) {
  return bucket === "needs" ? "Needs target (%)" : bucket === "goals" ? "Loans, savings & investing target (%)" : "Disposable target (%)";
}

function formatWorksheet(sheet: { getRow(index: number): { font: unknown; fill: unknown; alignment: unknown }; columns: Array<{ width?: number }> }, widths: number[]) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF006A6A" } };
  header.alignment = { vertical: "middle" };
  widths.forEach((width, index) => { sheet.columns[index].width = width; });
}

/** Creates a user-readable, portable snapshot. It is intentionally plaintext. */
export async function budgetWorkbook(vault: BudgetVault) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Cipher Budget";
  workbook.created = new Date();

  const readme = workbook.addWorksheet("Read me");
  readme.addRows([
    [FORMAT_TITLE, "Format version", FORMAT_VERSION],
    ["Important", "This export contains readable financial data. Store it only in a location you trust."],
    ["Import", "Use the Import spreadsheet button in Cipher Budget. Importing replaces the current vault with this workbook's periods and entries."],
    ["Sheets", "Settings controls default targets. Pay Periods, Income, and Expenses contain the editable budget data."],
  ]);
  readme.columns = [{ width: 18 }, { width: 105 }, { width: 16 }];
  readme.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  readme.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF006A6A" } };
  readme.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const settings = workbook.addWorksheet("Settings");
  settings.addRow(["Needs target (%)", "Loans, savings & investing target (%)", "Disposable target (%)"]);
  settings.addRow([vault.settings.defaultTargets.needs, vault.settings.defaultTargets.goals, vault.settings.defaultTargets.wants]);
  formatWorksheet(settings, [18, 42, 24]);

  const periods = workbook.addWorksheet("Pay Periods");
  periods.addRow(["Pay period start", "Pay period end", ...buckets.map(columnLabel), "Total income", "Total expenses", "Remaining balance"]);
  vault.periods.forEach((period) => {
    const summary = totals(period);
    periods.addRow([period.startDate, period.endDate, period.targetPercentages.needs, period.targetPercentages.goals, period.targetPercentages.wants, summary.income / 100, summary.expenses / 100, summary.remaining / 100]);
  });
  formatWorksheet(periods, [18, 18, 18, 42, 24, 16, 17, 19]);
  periods.getColumn(6).numFmt = '"$"#,##0.00';
  periods.getColumn(7).numFmt = '"$"#,##0.00';
  periods.getColumn(8).numFmt = '"$"#,##0.00';

  const income = workbook.addWorksheet("Income");
  income.addRow(["Pay period start", "Income source", "Amount (USD)", "Date (optional)"]);
  vault.periods.forEach((period) => period.incomes.forEach((entry) => income.addRow([period.startDate, safeText(entry.name), entry.amountCents / 100, entry.date ?? ""])));
  formatWorksheet(income, [18, 36, 18, 18]);
  income.getColumn(3).numFmt = '"$"#,##0.00';

  const expenses = workbook.addWorksheet("Expenses");
  expenses.addRow(["Pay period start", "Expense name", "Amount (USD)", "Date (optional)", "Category", "Recurring"]);
  vault.periods.forEach((period) => period.expenses.forEach((entry) => expenses.addRow([period.startDate, safeText(entry.name), entry.amountCents / 100, entry.date ?? "", bucketMeta[entry.bucket].label, entry.recurring ? "Yes" : "No"])));
  formatWorksheet(expenses, [18, 36, 18, 18, 30, 14]);
  expenses.getColumn(3).numFmt = '"$"#,##0.00';

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function worksheetRows(sheet: { rowCount: number; getRow(index: number): { getCell(column: number): { value: unknown } } } | undefined, name: string) {
  if (!sheet) throw new Error(`The ${name} sheet is missing.`);
  if (sheet.rowCount > MAX_IMPORT_ROWS + 1) throw new Error(`The ${name} sheet has too many rows.`);
  return Array.from({ length: Math.max(0, sheet.rowCount - 1) }, (_, index) => sheet.getRow(index + 2));
}

/** Parses only the app's own format. No spreadsheet formulas are evaluated. */
export async function importBudgetWorkbook(file: File): Promise<BudgetVault> {
  if (file.size === 0 || file.size > MAX_IMPORT_BYTES) throw new Error("Choose a Cipher Budget spreadsheet smaller than 5 MB.");
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    throw new Error("This file is not a valid Cipher Budget .xlsx export.");
  }
  const readme = workbook.getWorksheet("Read me");
  if (valueText(readme?.getCell("A1").value) !== FORMAT_TITLE || Number(readme?.getCell("C1").value) !== FORMAT_VERSION) throw new Error("This spreadsheet is not a supported Cipher Budget export.");

  const settingsRows = worksheetRows(workbook.getWorksheet("Settings"), "Settings");
  if (settingsRows.length !== 1) throw new Error("The Settings sheet must contain exactly one settings row.");
  const settingsRow = settingsRows[0];
  const imported: BudgetVault = {
    version: 1,
    settings: { defaultTargets: { needs: target(settingsRow.getCell(1).value, "Needs target"), goals: target(settingsRow.getCell(2).value, "Loans, savings & investing target"), wants: target(settingsRow.getCell(3).value, "Disposable target") } },
    periods: [],
  };
  const byStart = new Map<string, BudgetPeriod>();
  worksheetRows(workbook.getWorksheet("Pay Periods"), "Pay Periods").forEach((row) => {
    const startDate = requiredText(row.getCell(1).value, "Pay period start date");
    const endDate = requiredText(row.getCell(2).value, "Pay period end date");
    if (!validDate(startDate) || !validDate(endDate) || addDays(startDate, 13) !== endDate) throw new Error(`Pay period ${startDate} must be exactly 14 days long.`);
    if (byStart.has(startDate)) throw new Error(`Pay period ${startDate} appears more than once.`);
    const period: BudgetPeriod = { id: newId(), startDate, endDate, targetPercentages: { needs: target(row.getCell(3).value, `Needs target for ${startDate}`), goals: target(row.getCell(4).value, `Loans, savings & investing target for ${startDate}`), wants: target(row.getCell(5).value, `Disposable target for ${startDate}`) }, incomes: [], expenses: [] };
    byStart.set(startDate, period);
    imported.periods.push(period);
  });
  if (!imported.periods.length) throw new Error("The workbook does not contain a pay period to import.");

  worksheetRows(workbook.getWorksheet("Income"), "Income").forEach((row) => {
    const startDate = requiredText(row.getCell(1).value, "Income pay period start date");
    const period = byStart.get(startDate);
    if (!period) throw new Error(`Income references the missing pay period ${startDate}.`);
    const date = valueText(row.getCell(4).value);
    if (date && !validDate(date)) throw new Error(`Income date for ${startDate} must use YYYY-MM-DD.`);
    const entry: IncomeEntry = { id: newId(), name: requiredText(row.getCell(2).value, "Income source"), amountCents: amountCents(row.getCell(3).value, "Income amount"), ...(date ? { date } : {}) };
    period.incomes.push(entry);
  });
  worksheetRows(workbook.getWorksheet("Expenses"), "Expenses").forEach((row) => {
    const startDate = requiredText(row.getCell(1).value, "Expense pay period start date");
    const period = byStart.get(startDate);
    if (!period) throw new Error(`Expense references the missing pay period ${startDate}.`);
    const date = valueText(row.getCell(4).value);
    if (date && !validDate(date)) throw new Error(`Expense date for ${startDate} must use YYYY-MM-DD.`);
    const category = valueText(row.getCell(5).value).toLowerCase();
    const bucket: Bucket | undefined = category === "needs" ? "needs" : category === "goals" || category === "loans, savings & investing" ? "goals" : category === "wants" || category === "disposable" ? "wants" : undefined;
    if (!bucket) throw new Error("Expense category must be Needs, Loans, savings & investing, or Disposable.");
    const recurring = valueText(row.getCell(6).value).toLowerCase();
    if (recurring !== "yes" && recurring !== "no") throw new Error("Recurring must be Yes or No.");
    const entry: ExpenseEntry = { id: newId(), name: requiredText(row.getCell(2).value, "Expense name"), amountCents: amountCents(row.getCell(3).value, "Expense amount"), bucket, recurring: recurring === "yes", ...(date ? { date } : {}) };
    period.expenses.push(entry);
  });
  imported.periods.sort((left, right) => left.startDate.localeCompare(right.startDate));
  return imported;
}
