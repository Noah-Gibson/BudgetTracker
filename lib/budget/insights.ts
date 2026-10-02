import { bucketMeta, type Bucket, type PayMonth } from "@/lib/budget/types";

export const insightBuckets = Object.keys(bucketMeta) as Bucket[];

export type InsightRange = "all" | "last-3" | "last-6" | { startId: string; endId: string };

export type InsightCategory = {
  bucket: Bucket;
  actualCents: number;
  plannedCents: number;
  varianceCents: number;
  sharePercent: number;
};

export type InsightPeriod = {
  id: string;
  startDate: string;
  endDate: string;
  incomeCents: number;
  expenseCents: number;
  categoryCents: Record<Bucket, number>;
};

const centsByBucket = (month: PayMonth) => insightBuckets.reduce((result, bucket) => {
  result[bucket] = month.expenses.filter((expense) => expense.bucket === bucket).reduce((sum, expense) => sum + expense.amountCents, 0);
  return result;
}, {} as Record<Bucket, number>);

export function sortPayMonths(payMonths: PayMonth[]) {
  return [...payMonths].sort((left, right) => left.startDate.localeCompare(right.startDate));
}

export function selectInsightPayMonths(payMonths: PayMonth[], range: InsightRange) {
  const sorted = sortPayMonths(payMonths);
  if (range === "all") return sorted;
  if (range === "last-3") return sorted.slice(-3);
  if (range === "last-6") return sorted.slice(-6);
  const firstIndex = sorted.findIndex((month) => month.id === range.startId);
  const lastIndex = sorted.findIndex((month) => month.id === range.endId);
  if (firstIndex < 0 || lastIndex < 0) return [];
  return sorted.slice(Math.min(firstIndex, lastIndex), Math.max(firstIndex, lastIndex) + 1);
}

export function calculateInsights(payMonths: PayMonth[]) {
  const periods: InsightPeriod[] = sortPayMonths(payMonths).map((month) => {
    const categoryCents = centsByBucket(month);
    return {
      id: month.id,
      startDate: month.startDate,
      endDate: month.endDate,
      incomeCents: month.incomes.reduce((sum, income) => sum + income.amountCents, 0),
      expenseCents: month.expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
      categoryCents
    };
  });
  const incomeCents = periods.reduce((sum, period) => sum + period.incomeCents, 0);
  const expenseCents = periods.reduce((sum, period) => sum + period.expenseCents, 0);
  const categories: InsightCategory[] = insightBuckets.map((bucket) => {
    const actualCents = periods.reduce((sum, period) => sum + period.categoryCents[bucket], 0);
    const plannedCents = sortPayMonths(payMonths).reduce((sum, month) => sum + Math.round(month.incomes.reduce((income, entry) => income + entry.amountCents, 0) * month.targetPercentages[bucket] / 100), 0);
    return { bucket, actualCents, plannedCents, varianceCents: actualCents - plannedCents, sharePercent: expenseCents ? actualCents / expenseCents * 100 : 0 };
  });
  const changes = periods.slice(1).map((period, index) => ({ from: periods[index], to: period, changeCents: period.expenseCents - periods[index].expenseCents }));
  const largestChange = changes.length ? changes.reduce((largest, change) => Math.abs(change.changeCents) > Math.abs(largest.changeCents) ? change : largest) : undefined;
  const highestSpend = [...categories].sort((left, right) => right.actualCents - left.actualCents)[0];
  const furthestFromPlan = [...categories].sort((left, right) => Math.abs(right.varianceCents) - Math.abs(left.varianceCents))[0];

  return {
    periods,
    categories,
    incomeCents,
    expenseCents,
    leftCents: incomeCents - expenseCents,
    averageExpenseCents: periods.length ? Math.round(expenseCents / periods.length) : 0,
    highestSpend,
    largestChange,
    furthestFromPlan
  };
}
