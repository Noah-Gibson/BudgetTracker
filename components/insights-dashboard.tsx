"use client";

import { useMemo, useState } from "react";
import { Button } from "primereact/button";
import { Card } from "primereact/card";
import { Checkbox } from "primereact/checkbox";
import {
  calculateInsights,
  insightBuckets,
  selectInsightPayMonths,
  type InsightRange,
} from "@/lib/budget/insights";
import {
  bucketMeta,
  money,
  todayISO,
  type BudgetVault,
  type Bucket,
} from "@/lib/budget/types";

const shortDate = (value: string) =>
  new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
const rangeLabel = (start: string, end: string) =>
  `${shortDate(start)} – ${shortDate(end)}`;
const compactMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
const categoryClass: Record<Bucket, string> = {
  needs: "needs",
  goals: "goals",
  wants: "wants",
};

function ChartLegend() {
  return (
    <div className="insight-legend" aria-label="Category legend">
      {insightBuckets.map((bucket) => (
        <span key={bucket}>
          <i className={`insight-swatch ${categoryClass[bucket]}`} />
          {bucketMeta[bucket].label}
        </span>
      ))}
    </div>
  );
}

function CashFlowChart({ periods }: ReturnType<typeof calculateInsights>) {
  const maximum = Math.max(
    ...periods.flatMap((period) => [period.incomeCents, period.expenseCents]),
    0,
  );
  if (!maximum)
    return (
      <p className="insight-chart-empty">
        Add income or expenses to see your cash-flow trend.
      </p>
    );
  const chartHeight = 176;
  const chartBottom = 205;
  const chartWidth = 640;
  const left = 44;
  const available = chartWidth - left - 16;
  const group = available / periods.length;
  const bar = Math.min(22, group * 0.3);
  const heightFor = (value: number) => (value / maximum) * chartHeight;
  return (
    <div className="insight-chart-wrap">
      <div className="insight-chart-key">
        <span>
          <i className="insight-swatch income" />
          Income
        </span>
        <span>
          <i className="insight-swatch expenses" />
          Expenses
        </span>
      </div>
      <svg
        className="insight-chart"
        viewBox={`0 0 ${chartWidth} 235`}
        role="img"
        aria-label={`Cash-flow chart for ${periods.length} pay-months. Highest value is ${money(maximum)}.`}
      >
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={chartWidth - 16}
              y1={chartBottom - chartHeight * tick}
              y2={chartBottom - chartHeight * tick}
              className="insight-grid-line"
            />
            <text
              x={left - 7}
              y={chartBottom - chartHeight * tick + 4}
              textAnchor="end"
              className="insight-axis-label"
            >
              {compactMoney(maximum * tick)}
            </text>
          </g>
        ))}
        {periods.map((period, index) => {
          const x = left + group * index + group / 2;
          const incomeHeight = heightFor(period.incomeCents);
          const expenseHeight = heightFor(period.expenseCents);
          return (
            <g key={period.id}>
              <title>{`${rangeLabel(period.startDate, period.endDate)}: income ${money(period.incomeCents)}, expenses ${money(period.expenseCents)}`}</title>
              <rect
                className="insight-income-bar"
                x={x - bar - 2}
                y={chartBottom - incomeHeight}
                width={bar}
                height={incomeHeight}
                rx="3"
              />
              <rect
                className="insight-expense-bar"
                x={x + 2}
                y={chartBottom - expenseHeight}
                width={bar}
                height={expenseHeight}
                rx="3"
              />
              <text
                x={x}
                y="224"
                textAnchor="middle"
                className="insight-axis-label"
              >
                {shortDate(period.startDate)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CategoryTrendChart({ periods }: ReturnType<typeof calculateInsights>) {
  const totalSpent = (period: (typeof periods)[number]) =>
    insightBuckets.reduce(
      (sum, bucket) => sum + period.categoryCents[bucket],
      0,
    );
  const maximum = Math.max(
    ...periods.flatMap((period) => [totalSpent(period), period.budgetCents]),
    0,
  );
  if (!maximum)
    return (
      <p className="insight-chart-empty">
        Add categorized expenses or income to compare your spending with each
        pay-month’s budget.
      </p>
    );
  return (
    <div className="insight-chart-wrap">
      <ChartLegend />
      <p className="insight-scale-note">
        Shared scale: up to {money(maximum)}. The dashed marker is that
        pay-month’s budget.
      </p>
      <div
        className="insight-stack-list"
        role="img"
        aria-label="Stacked category spending by pay-month, with a budget marker for each pay-month"
      >
        {periods.map((period) => {
          const spent = totalSpent(period);
          return (
            <div className="insight-stack-row" key={period.id}>
              <span>{shortDate(period.startDate)}</span>
              <div
                className="insight-stack-track"
                title={`${rangeLabel(period.startDate, period.endDate)}: ${money(spent)} spent against a ${money(period.budgetCents)} budget`}
              >
                <span
                  className="insight-spend-budget"
                  style={{ left: `${(period.budgetCents / maximum) * 100}%` }}
                  aria-hidden="true"
                />
                {insightBuckets.map((bucket) =>
                  period.categoryCents[bucket] ? (
                    <i
                      key={bucket}
                      className={categoryClass[bucket]}
                      style={{
                        width: `${(period.categoryCents[bucket] / maximum) * 100}%`,
                      }}
                    />
                  ) : null,
                )}
              </div>
              <strong className={spent > period.budgetCents ? "over" : ""}>
                {money(spent)}
              </strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanComparison({
  categories,
  targetPercentages,
}: ReturnType<typeof calculateInsights> & {
  targetPercentages: Record<Bucket, number>;
}) {
  const maximum = Math.max(...categories.flatMap((category) => [category.allocatedCents, category.plannedCents]), 0);
  return (
    <div className="insight-plan-list">
      {categories.map((category) => {
        const goalPercent = targetPercentages[category.bucket];
        const savingsCents = category.savingsCents;
        const isOverBudget = category.allocatedCents > category.plannedCents;
        return (
          <div className="insight-plan-row" key={category.bucket}>
            <div className="insight-plan-heading">
              <span>
                <i
                  className={`insight-swatch ${categoryClass[category.bucket]}`}
                />
                {bucketMeta[category.bucket].label}
              </span>
              <strong className={isOverBudget ? "over" : ""}>
                {money(savingsCents ? category.allocatedCents : category.actualCents)} {savingsCents ? "expenses + savings" : "expenses"}
                <small>{category.sharePercent.toFixed(0)}% {savingsCents ? "expenses + savings" : "expenses"} · Goal {goalPercent.toFixed(0)}%</small>
              </strong>
            </div>
            <div
              className="insight-plan-bars"
              aria-label={`${bucketMeta[category.bucket].label}: ${money(category.actualCents)} expenses against a ${money(category.plannedCents)} budget${savingsCents ? `, with ${money(savingsCents)} allocated as savings` : ""}`}
            >
              <span
                className={`actual ${categoryClass[category.bucket]}`}
                style={{
                  width: `${maximum ? category.actualCents / maximum * 100 : 0}%`,
                }}
              />
              <span
                className={`planned ${categoryClass[category.bucket]}`}
                style={{
                  width: `${maximum ? category.plannedCents / maximum * 100 : 0}%`,
                }}
              />
              {savingsCents > 0 && <span className="assumed-savings" style={{ left: `${maximum ? category.actualCents / maximum * 100 : 0}%`, width: `${maximum ? savingsCents / maximum * 100 : 0}%` }} />}
              <span className="planned-marker" style={{ left: `${maximum ? category.plannedCents / maximum * 100 : 0}%` }} aria-hidden="true" />
            </div>
            <small>
              <b>Expenses {money(category.actualCents)}</b>
              {category.bucket === "goals" && <span>Savings {money(savingsCents)}</span>}
              <span>Budget {money(category.plannedCents)}</span>
            </small>
          </div>
        );
      })}
    </div>
  );
}

export function InsightsDashboard({ vault }: { vault: BudgetVault }) {
  const [range, setRange] = useState<InsightRange>("all");
  const [includeInProgress, setIncludeInProgress] = useState(false);
  const sortedMonths = useMemo(
    () => selectInsightPayMonths(vault.payMonths, "all"),
    [vault.payMonths],
  );
  const rangeMonths = useMemo(
    () => selectInsightPayMonths(vault.payMonths, range),
    [vault.payMonths, range],
  );
  const currentPayMonth = sortedMonths.at(-1);
  const rangeIncludesInProgress = Boolean(
    currentPayMonth &&
      currentPayMonth.endDate > todayISO() &&
      rangeMonths.some((month) => month.id === currentPayMonth.id),
  );
  const selectedMonths = useMemo(
    () =>
      includeInProgress || !rangeIncludesInProgress || !currentPayMonth
        ? rangeMonths
        : rangeMonths.filter((month) => month.id !== currentPayMonth.id),
    [currentPayMonth, includeInProgress, rangeIncludesInProgress, rangeMonths],
  );
  const data = useMemo(
    () => calculateInsights(selectedMonths),
    [selectedMonths],
  );
  const selectRange = (
    next: Exclude<InsightRange, { startId: string; endId: string }>,
  ) => setRange(next);
  const setCustom = (field: "startId" | "endId", value: string) =>
    setRange((current) => {
      const base =
        typeof current === "object"
          ? current
          : {
              startId: sortedMonths[0]?.id ?? "",
              endId: sortedMonths.at(-1)?.id ?? "",
            };
      return { ...base, [field]: value };
    });

  if (!sortedMonths.length)
    return (
      <section className="empty-state">
        <i className="pi pi-chart-bar insight-empty-icon" />
        <h1>Insights grow with your budget</h1>
        <p>
          Create your first pay-month, then return here for spending patterns
          and plan comparisons.
        </p>
        <Button
          label="Go to budget"
          icon="pi pi-arrow-left"
          onClick={() => {
            window.location.href = "/";
          }}
        />
      </section>
    );
  const customRange =
    typeof range === "object"
      ? range
      : { startId: sortedMonths[0].id, endId: sortedMonths.at(-1)!.id };
  const label = selectedMonths.length
    ? rangeLabel(selectedMonths[0].startDate, selectedMonths.at(-1)!.endDate)
    : "No pay-months selected";
  return (
    <section className="budget-board insights-board">
      <div className="insights-heading">
        <div>
          <p className="eyebrow">BUDGET INSIGHTS</p>
          <h1>See the shape of your spending.</h1>
          <p>
            Based on the income and expenses you&apos;ve entered for {label}.
          </p>
        </div>
        <div className="insight-range-control" aria-label="Insights date range">
          <div className="insight-range-buttons">
            {(["all", "last-3", "last-6"] as const).map((option) => (
              <Button
                key={option}
                outlined={range !== option}
                className={range === option ? "active" : ""}
                label={
                  option === "all"
                    ? "All history"
                    : option.replace("last-", "Last ")
                }
                onClick={() => selectRange(option)}
              />
            ))}
            <Button
              outlined={typeof range !== "object"}
              className={typeof range === "object" ? "active" : ""}
              label="Custom"
              onClick={() => setRange(customRange)}
            />
          </div>
          {typeof range === "object" && (
            <div className="insight-custom-range">
              <label>
                From
                <select
                  value={customRange.startId}
                  onChange={(event) => setCustom("startId", event.target.value)}
                >
                  {sortedMonths.map((month) => (
                    <option value={month.id} key={month.id}>
                      {rangeLabel(month.startDate, month.endDate)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                To
                <select
                  value={customRange.endId}
                  onChange={(event) => setCustom("endId", event.target.value)}
                >
                  {sortedMonths.map((month) => (
                    <option value={month.id} key={month.id}>
                      {rangeLabel(month.startDate, month.endDate)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {rangeIncludesInProgress && (
            <div className="remember-choice insight-in-progress-choice">
              <Checkbox
                inputId="include-in-progress-pay-month"
                checked={includeInProgress}
                onChange={(event) =>
                  setIncludeInProgress(Boolean(event.checked))
                }
              />
              <label htmlFor="include-in-progress-pay-month">
                Include current in-progress pay-month
              </label>
            </div>
          )}
        </div>
      </div>
      {!selectedMonths.length ? (
        <div className="insight-no-results">
          <h2>No pay-months in this range</h2>
          <p>Choose a different start or end pay-month to see insights.</p>
        </div>
      ) : (
        <>
          <div className="summary-grid insights-summary">
            <Metric
              label="Income"
              value={money(data.incomeCents)}
              icon="pi pi-wallet"
            />
            <Metric
              label="Spending"
              value={money(data.expenseCents)}
              icon="pi pi-credit-card"
            />
            <Metric
              label="Savings"
              value={money(data.savingsCents)}
              icon="pi pi-chart-line"
              tone={data.savingsCents < 0 ? "negative" : "positive"}
            />
            <Metric
              label="Avg. spending"
              value={money(data.averageExpenseCents)}
              icon="pi pi-calendar"
            />
          </div>
          <Card
            className="insight-card insight-plan-card"
            title="Plan versus actual"
          >
            <p className="insight-card-copy">Your spending makeup compared with your latest category goals.</p>
            <PlanComparison
              {...data}
              targetPercentages={sortedMonths.at(-1)!.targetPercentages}
            />
          </Card>
          <section className="insight-callouts" aria-label="Spending takeaways">
            <Callout
              icon="pi pi-tag"
              title="Biggest category"
              body={
                data.expenseCents
                  ? `${bucketMeta[data.highestSpend.bucket].label} accounts for ${money(data.highestSpend.allocatedCents)} of your allocation.`
                  : "Add categorized expenses to identify your largest spending category."
              }
            />
            <Callout
              icon="pi pi-arrows-v"
              title="Spending change"
              body={
                data.largestChange
                  ? `${data.largestChange.changeCents >= 0 ? "Up" : "Down"} ${money(Math.abs(data.largestChange.changeCents))} from ${shortDate(data.largestChange.from.startDate)} to ${shortDate(data.largestChange.to.startDate)}.`
                  : "Add another pay-month to compare spending over time."
              }
            />
          </section>
          <div className="insight-chart-grid">
            <Card className="insight-card" title="Cash flow over time">
              <p className="insight-card-copy">
                Income and total spending in each pay-month.
              </p>
              {data.periods.length > 1 ? (
                <CashFlowChart {...data} />
              ) : (
                <p className="insight-chart-empty">
                  Add another pay-month to see your trend over time.
                </p>
              )}
            </Card>
            <Card className="insight-card" title="Spending mix">
              <p className="insight-card-copy">
                Where your categorized spending went each pay-month.
              </p>
              <CategoryTrendChart {...data} />
            </Card>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: string;
  tone?: "positive" | "negative";
}) {
  return (
    <Card className={`summary-card ${tone ?? ""}`}>
      <i className={icon} />
      <span>{label}</span>
      <strong>{value}</strong>
    </Card>
  );
}
function Callout({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <article>
      <i className={icon} />
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </article>
  );
}
