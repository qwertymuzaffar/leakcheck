import { binCounts, mean, quantile, standardDeviation, widthEdges } from './stats';
import type { CategoryCount, ColumnProfile, DatasetProfile, Histogram, NumericStats, Row } from './types';
import { columnNames, inferType, isMissing, toDate, toKey, toNumber } from './values';

export interface ProfileOptions {
  /** Columns to profile; defaults to every column seen in the rows. */
  columns?: string[];
  /** Histogram bins for numeric columns. Default 10. */
  bins?: number;
  /** How many of the most frequent values to keep per column. Default 20. */
  topCategories?: number;
}

/** The values of one column across the rows, in row order. */
export function columnValues(rows: readonly Row[], column: string): unknown[] {
  return rows.map((row) => row[column]);
}

/** Descriptive statistics of a numeric sample. */
export function numericStats(values: readonly number[]): NumericStats {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0]! : NaN,
    max: sorted.length ? sorted[sorted.length - 1]! : NaN,
    mean: mean(sorted),
    std: standardDeviation(sorted),
    quantiles: {
      p5: quantile(sorted, 0.05),
      p25: quantile(sorted, 0.25),
      p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p95: quantile(sorted, 0.95),
    },
  };
}

/** Equal-width histogram between the sample's minimum and maximum. */
export function histogram(values: readonly number[], bins = 10): Histogram {
  if (values.length === 0) return { edges: [], counts: [] };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const inner = widthEdges(min, max, bins);
  return { edges: [min, ...inner, max], counts: binCounts(values, inner) };
}

/** Numeric view of a column's non-missing values: numbers as they are, dates as epoch milliseconds. */
export function numericValues(values: readonly unknown[], asDates = false): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (isMissing(value)) continue;
    const n = asDates ? (toDate(value)?.getTime() ?? null) : typeof value === 'boolean' ? (value ? 1 : 0) : toNumber(value);
    if (n !== null) out.push(n);
  }
  return out;
}

/** Frequency of each non-missing value by its text form, most frequent first. */
export function categoryCounts(values: readonly unknown[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (isMissing(value)) continue;
    const key = toKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

/** Profiles one column. */
export function profileColumn(name: string, values: readonly unknown[], options: ProfileOptions = {}): ColumnProfile {
  const type = inferType(values);
  let missing = 0;
  for (const value of values) if (isMissing(value)) missing += 1;
  const categories = categoryCounts(values);
  const column: ColumnProfile = { name, type, count: values.length - missing, missing, distinct: categories.length };
  if (type === 'number' || type === 'integer' || type === 'date') {
    const numbers = numericValues(values, type === 'date');
    column.numeric = numericStats(numbers);
    column.histogram = histogram(numbers, options.bins ?? 10);
  } else {
    column.categories = categories.slice(0, options.topCategories ?? 20);
  }
  return column;
}

/**
 * Types, missing counts, distinct counts, numeric statistics and histograms, or top categories,
 * for every column of a dataset.
 */
export function profile(rows: readonly Row[], options: ProfileOptions = {}): DatasetProfile {
  const names = options.columns ?? columnNames(rows);
  const columns: Record<string, ColumnProfile> = {};
  for (const name of names) columns[name] = profileColumn(name, columnValues(rows, name), options);
  return { rows: rows.length, columns };
}
