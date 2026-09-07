import { categoryCounts, numericStats, numericValues } from './profile';
import { binCounts, quantileEdges, widthEdges } from './stats';
import type { CategoryCount, ColumnType, NumericStats, Row } from './types';
import { columnNames, inferType, isMissing } from './values';

/** What {@link createBaseline} keeps about one reference column. */
export interface BaselineColumn {
  kind: 'numeric' | 'categorical' | 'skipped';
  /** Why the column will be skipped by drift checks. */
  reason?: string;
  /** Type inferred from the reference values. */
  type: ColumnType;
  /** Non-missing reference values. */
  count: number;
  missing: number;
  /** Numeric columns: whether the values were dates (compared as epoch milliseconds). */
  isDate?: boolean;
  /** Numeric columns: inner bin edges, ascending. */
  edges?: number[];
  /** Numeric columns: reference counts per bin (`edges.length + 1` bins). */
  counts?: number[];
  stats?: NumericStats;
  /** Numeric columns: sorted subsample of the reference values for the KS test, at most `sampleSize` long. */
  sample?: number[];
  /** Categorical columns: the kept categories with their reference counts, largest first. */
  categories?: CategoryCount[];
  /** Categorical columns: reference values outside the kept categories. */
  other?: number;
}

/**
 * A JSON-serialisable summary of a reference window: enough to run {@link detectDrift} against
 * later batches without keeping the reference rows.
 */
export interface Baseline {
  version: 1;
  /** ISO timestamp of creation. */
  createdAt: string;
  rows: number;
  columns: Record<string, BaselineColumn>;
}

export interface BaselineOptions {
  /** Columns to summarise; defaults to every column of the rows. */
  columns?: string[];
  /** Bins for numeric columns. Default 10. */
  bins?: number;
  /** `quantile` bins (equal reference mass, the default) or equal `width` bins over the reference range. */
  binning?: 'quantile' | 'width';
  /** Fewest non-missing values a column needs. Default 20. */
  minSamples?: number;
  /** Categories kept for categorical columns; the rest merge into `other`. Default 50. */
  maxCategories?: number;
  /**
   * Skip a categorical column when its distinct values exceed `maxCategories` and this share of
   * the reference values are unique, which marks identifiers rather than categories. Default 0.5.
   */
  maxDistinctShare?: number;
  /** Columns to treat as categorical even when their values look numeric. */
  categorical?: string[];
  /** Columns to treat as numeric even when inference would not. */
  numeric?: string[];
  /** Reference values kept per numeric column for the KS test. Default 2000 in a baseline; unlimited when comparing rows directly. */
  sampleSize?: number;
}

/** Evenly spaced subsample of a sorted array, keeping both ends; the whole array when it is short enough. */
export function subsample(sorted: readonly number[], size: number): number[] {
  if (!(size < sorted.length) || size < 2) return sorted.slice();
  const out: number[] = [];
  for (let i = 0; i < size; i += 1) out.push(sorted[Math.round((i * (sorted.length - 1)) / (size - 1))]!);
  return out;
}

/** Summarises one reference column the way a baseline stores it. */
export function summarizeColumn(column: string, values: readonly unknown[], options: BaselineOptions = {}): BaselineColumn {
  const minSamples = options.minSamples ?? 20;
  let missing = 0;
  for (const value of values) if (isMissing(value)) missing += 1;
  const count = values.length - missing;
  const type = inferType(values);
  const base: BaselineColumn = { kind: 'skipped', type, count, missing };
  if (count < minSamples) return { ...base, reason: `only ${count} reference values (minimum ${minSamples})` };

  const forcedCategorical = options.categorical?.includes(column) ?? false;
  const forcedNumeric = options.numeric?.includes(column) ?? false;
  const numeric = forcedNumeric || (!forcedCategorical && (type === 'number' || type === 'integer' || type === 'date'));
  if (numeric) {
    const isDate = type === 'date' && !forcedNumeric;
    const sorted = numericValues(values, isDate).sort((a, b) => a - b);
    if (sorted.length < minSamples) return { ...base, reason: 'too few numeric values' };
    const bins = options.bins ?? 10;
    const edges = options.binning === 'width' ? widthEdges(sorted[0]!, sorted[sorted.length - 1]!, bins) : quantileEdges(sorted, bins);
    return {
      ...base,
      kind: 'numeric',
      isDate,
      edges,
      counts: binCounts(sorted, edges),
      stats: numericStats(sorted),
      sample: subsample(sorted, options.sampleSize ?? Infinity),
    };
  }

  const maxCategories = options.maxCategories ?? 50;
  const counts = categoryCounts(values);
  if (counts.length > maxCategories && counts.length / count > (options.maxDistinctShare ?? 0.5)) {
    return { ...base, reason: `high cardinality: ${counts.length} distinct values in ${count} rows` };
  }
  const categories = counts.slice(0, maxCategories);
  let other = 0;
  for (const c of counts.slice(maxCategories)) other += c.count;
  return { ...base, kind: 'categorical', categories, other };
}

/**
 * Summarises a reference window into a JSON-serialisable {@link Baseline}: bins and counts,
 * statistics and a value sample per numeric column, kept categories per categorical column.
 * Save it with the model and pass it to {@link detectDrift} for every later batch.
 * @example
 * ```ts
 * const baseline = createBaseline(trainingRows, { bins: 10 });
 * await fs.writeFile('baseline.json', JSON.stringify(baseline));
 * // later, in the monitoring job:
 * const report = detectDrift(JSON.parse(await fs.readFile('baseline.json', 'utf8')), todaysRows);
 * ```
 */
export function createBaseline(rows: readonly Row[], options: BaselineOptions = {}): Baseline {
  const names = options.columns ?? columnNames(rows);
  const columns: Record<string, BaselineColumn> = {};
  const withSample = { ...options, sampleSize: options.sampleSize ?? 2000 };
  for (const name of names) {
    columns[name] = summarizeColumn(
      name,
      rows.map((row) => row[name]),
      withSample,
    );
  }
  return { version: 1, createdAt: new Date().toISOString(), rows: rows.length, columns };
}

/** Whether a value is a {@link Baseline} (for example one parsed from JSON). */
export function isBaseline(value: unknown): value is Baseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<Baseline>;
  return candidate.version === 1 && typeof candidate.rows === 'number' && typeof candidate.columns === 'object' && candidate.columns !== null;
}
