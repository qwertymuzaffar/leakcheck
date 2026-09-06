import { categoryCounts } from './profile';
import { binIndex, chiSquareSurvival, mean, quantileEdges } from './stats';
import type { Row } from './types';
import { columnNames, inferType, isMissing, toDate, toKey, toNumber } from './values';

export interface LeakageThresholds {
  /** Association with the label (|Pearson r|, eta squared or Cramer's V) at or above this flags a feature. Default 0.95. */
  association: number;
  /** Share of rows where a feature equals the label at or above this flags it as a copy. Default 0.99. */
  labelCopy: number;
  /** Share of rows whose feature timestamp is after the label timestamp above this flags it. Default 0. */
  future: number;
}

export interface LeakageOptions {
  /** The column being predicted. */
  label: string;
  /** Feature columns; defaults to every other column. */
  features?: string[];
  /** Columns to leave out (identifiers you know about, the label's own timestamp, ...). */
  exclude?: string[];
  /** Column with the time the label became known, for future-dated feature checks. */
  labelTime?: string;
  /** Columns holding the time each feature was observed, checked against `labelTime`. */
  featureTimes?: string[];
  thresholds?: Partial<LeakageThresholds>;
  /** Fewest rows with both a feature and a label value. Default 20. */
  minSamples?: number;
  /** Numeric columns with at most this many distinct values count as categorical. Default 10. */
  maxCategoricalDistinct?: number;
  /** Flag categorical features whose distinct values exceed this share of the rows as identifiers. Default 0.5. */
  identifierShare?: number;
}

export type AssociationMeasure = 'pearson' | 'eta-squared' | 'cramers-v' | 'binned-cramers-v';

export interface FeatureLeakage {
  column: string;
  kind: 'numeric' | 'categorical' | 'skipped';
  reason?: string;
  /** Rows with both a feature and a label value. */
  pairs: number;
  measure?: AssociationMeasure;
  /** Strength of association with the label, 0 to 1 (absolute value for Pearson). */
  association?: number;
  /** Share of rows where the feature's text equals the label's text. */
  labelCopyShare: number;
  /** Share of rows where the feature was observed after the label, for `featureTimes` columns. */
  futureShare?: number;
  identifier: boolean;
  signals: string[];
  flagged: boolean;
}

export interface LeakageReport {
  /** True when no feature was flagged. */
  ok: boolean;
  label: string;
  labelKind: 'numeric' | 'categorical';
  rows: number;
  thresholds: LeakageThresholds;
  features: Record<string, FeatureLeakage>;
  flagged: string[];
  skipped: string[];
}

const DEFAULT_THRESHOLDS: LeakageThresholds = { association: 0.95, labelCopy: 0.99, future: 0 };

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return Number(n.toPrecision(3)).toString();
}

/** Pearson correlation of two equally long samples; NaN when either is constant. */
export function pearson(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length) throw new Error('pearson needs samples of the same length');
  const n = x.length;
  if (n < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/** Correlation ratio (eta squared): the share of a numeric variable's variance explained by group membership. */
export function etaSquared(values: readonly number[], groups: readonly string[]): number {
  if (values.length !== groups.length) throw new Error('etaSquared needs samples of the same length');
  if (values.length < 2) return NaN;
  const grand = mean(values);
  const sums = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < values.length; i += 1) {
    const entry = sums.get(groups[i]!) ?? { sum: 0, count: 0 };
    entry.sum += values[i]!;
    entry.count += 1;
    sums.set(groups[i]!, entry);
  }
  let between = 0;
  for (const { sum, count } of sums.values()) between += count * (sum / count - grand) ** 2;
  let total = 0;
  for (const v of values) total += (v - grand) ** 2;
  if (total === 0) return NaN;
  return between / total;
}

/** Chi-square test of independence on a contingency table (rows by columns). */
export function contingencyChiSquare(table: readonly (readonly number[])[]): { statistic: number; pValue: number; df: number; n: number } {
  const rows = table.length;
  const cols = rows ? table[0]!.length : 0;
  const rowTotals = table.map((r) => r.reduce((a, b) => a + b, 0));
  const colTotals = Array.from({ length: cols }, (_, j) => table.reduce((a, r) => a + r[j]!, 0));
  const n = rowTotals.reduce((a, b) => a + b, 0);
  const liveRows = rowTotals.filter((t) => t > 0).length;
  const liveCols = colTotals.filter((t) => t > 0).length;
  const df = (liveRows - 1) * (liveCols - 1);
  if (df < 1 || n === 0) return { statistic: 0, pValue: 1, df: Math.max(0, df), n };
  let statistic = 0;
  for (let i = 0; i < rows; i += 1) {
    if (rowTotals[i] === 0) continue;
    for (let j = 0; j < cols; j += 1) {
      if (colTotals[j] === 0) continue;
      const expected = (rowTotals[i]! * colTotals[j]!) / n;
      statistic += (table[i]![j]! - expected) ** 2 / expected;
    }
  }
  return { statistic, pValue: chiSquareSurvival(statistic, df), df, n };
}

/**
 * Cramer's V between two categorical samples: 0 independent, 1 when one determines the other.
 * Bias-corrected by default (Bergsma 2013), which keeps tables with many sparse cells from
 * scoring high by chance; pass `false` for the classic value.
 */
export function cramersV(a: readonly string[], b: readonly string[], corrected = true): number {
  if (a.length !== b.length) throw new Error('cramersV needs samples of the same length');
  if (a.length === 0) return NaN;
  const rowIndex = new Map<string, number>();
  const colIndex = new Map<string, number>();
  for (const v of a) if (!rowIndex.has(v)) rowIndex.set(v, rowIndex.size);
  for (const v of b) if (!colIndex.has(v)) colIndex.set(v, colIndex.size);
  if (rowIndex.size < 2 || colIndex.size < 2) return NaN;
  const table = Array.from({ length: rowIndex.size }, () => new Array<number>(colIndex.size).fill(0));
  for (let i = 0; i < a.length; i += 1) table[rowIndex.get(a[i]!)!]![colIndex.get(b[i]!)!]! += 1;
  const { statistic, n } = contingencyChiSquare(table);
  const r = rowIndex.size;
  const c = colIndex.size;
  if (!corrected || n < 2) return Math.sqrt(statistic / (n * (Math.min(r, c) - 1)));
  const phi = Math.max(0, statistic / n - ((r - 1) * (c - 1)) / (n - 1));
  const rr = r - (r - 1) ** 2 / (n - 1);
  const cc = c - (c - 1) ** 2 / (n - 1);
  const denominator = Math.min(rr - 1, cc - 1);
  return denominator > 0 ? Math.sqrt(phi / denominator) : 0;
}

/** Keys of numeric values binned by reference quantiles, so a nonlinear rule can be tested as categories. */
function binnedKeys(values: readonly number[], bins = 10): string[] {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const edges = quantileEdges(finite, bins);
  return values.map((v) => (Number.isFinite(v) ? String(binIndex(v, edges)) : 'missing'));
}

type Kind = 'numeric' | 'categorical';

function kindOf(values: readonly unknown[], maxCategoricalDistinct: number): Kind {
  const type = inferType(values);
  if (type === 'number' || type === 'integer' || type === 'date') {
    return categoryCounts(values).length <= maxCategoricalDistinct ? 'categorical' : 'numeric';
  }
  return 'categorical';
}

function pairedNumeric(values: readonly unknown[], asDates: boolean, keep: readonly boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (!keep[i]) continue;
    const v = values[i];
    const n = asDates ? (toDate(v)?.getTime() ?? null) : typeof v === 'boolean' ? (v ? 1 : 0) : toNumber(v);
    out.push(n ?? NaN);
  }
  return out;
}

/**
 * Looks for target leakage among the features of a labelled dataset: features that are near
 * copies of the label, features almost perfectly associated with it (Pearson, eta squared or
 * Cramer's V depending on the types), identifier-like columns, and features observed after the
 * label when timestamps are given.
 * @example
 * ```ts
 * const report = detectLeakage(rows, {
 *   label: 'claim_paid',
 *   exclude: ['claim_id'],
 *   labelTime: 'settled_at',
 *   featureTimes: ['last_note_at'],
 * });
 * for (const name of report.flagged) console.log(name, report.features[name].signals);
 * ```
 */
export function detectLeakage(rows: readonly Row[], options: LeakageOptions): LeakageReport {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const minSamples = options.minSamples ?? 20;
  const maxCategoricalDistinct = options.maxCategoricalDistinct ?? 10;
  const identifierShare = options.identifierShare ?? 0.5;
  const excluded = new Set(
    [options.label, options.labelTime, ...(options.featureTimes ?? []), ...(options.exclude ?? [])].filter((c): c is string => !!c),
  );
  const names = (options.features ?? columnNames(rows)).filter((name) => !excluded.has(name));
  const labelValues = rows.map((row) => row[options.label]);
  const labelKind = kindOf(labelValues, maxCategoricalDistinct);
  const labelIsDate = inferType(labelValues) === 'date';
  const labelKeys = labelValues.map((v) => (isMissing(v) ? null : toKey(v)));
  const labelTimes = options.labelTime ? rows.map((row) => toDate(row[options.labelTime!])?.getTime() ?? null) : null;

  const features: Record<string, FeatureLeakage> = {};
  const flagged: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const values = rows.map((row) => row[name]);
    const keep = values.map((v, i) => !isMissing(v) && labelKeys[i] !== null);
    const pairs = keep.filter(Boolean).length;
    let copies = 0;
    for (let i = 0; i < values.length; i += 1) if (keep[i] && toKey(values[i]) === labelKeys[i]) copies += 1;
    const labelCopyShare = pairs ? copies / pairs : 0;
    const base: FeatureLeakage = { column: name, kind: 'skipped', pairs, labelCopyShare, identifier: false, signals: [], flagged: false };
    if (pairs < minSamples) {
      features[name] = { ...base, reason: `only ${pairs} rows with both "${name}" and the label` };
      skipped.push(name);
      continue;
    }
    const signals: string[] = [];
    if (labelCopyShare >= thresholds.labelCopy) signals.push(`equals the label in ${fmt(labelCopyShare * 100)}% of rows`);

    const kind = kindOf(values, maxCategoricalDistinct);
    const type = inferType(values);
    const distinct = categoryCounts(values).length;
    const identifier = kind === 'categorical' && type !== 'boolean' && distinct > maxCategoricalDistinct && distinct / pairs > identifierShare;
    if (identifier) signals.push(`looks like an identifier: ${distinct} distinct values in ${pairs} rows`);

    let measure: AssociationMeasure | undefined;
    let association: number | undefined;
    if (!identifier) {
      const keptLabelKeys = labelKeys.filter((_, i) => keep[i]) as string[];
      const keptFeatureKeys = () => values.filter((_, i) => keep[i]).map(toKey);
      let raw: number;
      if (kind === 'numeric' && labelKind === 'numeric') {
        measure = 'pearson';
        raw = Math.abs(pearson(pairedNumeric(values, type === 'date', keep), pairedNumeric(labelValues, labelIsDate, keep)));
      } else if (kind === 'numeric') {
        // A numeric feature can determine a categorical label without a linear pattern (zero when
        // not paid, anything else when paid), so the binned Cramer's V is tried as well.
        const numbers = pairedNumeric(values, type === 'date', keep);
        const eta = etaSquared(numbers, keptLabelKeys);
        const binned = cramersV(binnedKeys(numbers), keptLabelKeys);
        if (Number.isNaN(eta) || (!Number.isNaN(binned) && binned > eta)) {
          measure = 'binned-cramers-v';
          raw = binned;
        } else {
          measure = 'eta-squared';
          raw = eta;
        }
      } else if (labelKind === 'numeric') {
        measure = 'eta-squared';
        raw = etaSquared(pairedNumeric(labelValues, labelIsDate, keep), keptFeatureKeys());
      } else {
        measure = 'cramers-v';
        raw = cramersV(keptFeatureKeys(), keptLabelKeys);
      }
      if (!Number.isNaN(raw)) association = raw;
      if (association !== undefined && association >= thresholds.association) {
        signals.push(`${measure} ${fmt(association)} >= ${fmt(thresholds.association)}`);
      }
    }

    features[name] = {
      ...base,
      kind,
      ...(measure ? { measure } : {}),
      ...(association !== undefined ? { association } : {}),
      identifier,
      signals,
      flagged: signals.length > 0,
    };
    if (signals.length) flagged.push(name);
  }

  // Future-dated features: each listed feature time column is compared with the label time.
  if (labelTimes && options.featureTimes) {
    for (const column of options.featureTimes) {
      const times = rows.map((row) => toDate(row[column])?.getTime() ?? null);
      let compared = 0;
      let future = 0;
      for (let i = 0; i < rows.length; i += 1) {
        if (times[i] === null || labelTimes[i] === null) continue;
        compared += 1;
        if (times[i]! > labelTimes[i]!) future += 1;
      }
      const share = compared ? future / compared : 0;
      const entry: FeatureLeakage = {
        column,
        kind: compared >= minSamples ? 'numeric' : 'skipped',
        pairs: compared,
        labelCopyShare: 0,
        futureShare: share,
        identifier: false,
        signals: [],
        flagged: false,
      };
      if (compared < minSamples) {
        entry.reason = `only ${compared} rows with both "${column}" and "${options.labelTime}"`;
        skipped.push(column);
      } else if (share > thresholds.future) {
        entry.signals.push(`observed after "${options.labelTime}" in ${fmt(share * 100)}% of rows (${future})`);
        entry.flagged = true;
        flagged.push(column);
      }
      features[column] = entry;
    }
  }

  return { ok: flagged.length === 0, label: options.label, labelKind, rows: rows.length, thresholds, features, flagged, skipped };
}

export interface OverlapOptions {
  /** Columns that identify an entity (customer, policy, patient); test rows whose key appears in train are overlap. */
  keys?: string[];
  /** Columns compared for exact duplicate rows; defaults to every column of the train rows. */
  columns?: string[];
  /** How many overlapping keys to list. Default 20. */
  examples?: number;
}

export interface OverlapReport {
  /** True when no key overlap and no duplicate rows were found. */
  ok: boolean;
  train: { rows: number };
  test: { rows: number };
  /** Test rows whose entity key also appears in train. */
  keyOverlap?: { count: number; share: number; keys: string[] };
  /** Test rows identical to a train row over the compared columns. */
  duplicateRows: { count: number; share: number };
}

/**
 * Checks a train/test split for leakage across the boundary: test rows that share an entity key
 * with a train row, and test rows that duplicate a train row outright.
 * @example
 * ```ts
 * const overlap = detectOverlap(train, test, { keys: ['customer_id'] });
 * if (!overlap.ok) console.log(overlapToMarkdown(overlap));
 * ```
 */
export function detectOverlap(train: readonly Row[], test: readonly Row[], options: OverlapOptions = {}): OverlapReport {
  const columns = options.columns ?? columnNames(train);
  const rowKey = (row: Row) => columns.map((c) => (isMissing(row[c]) ? '' : toKey(row[c]))).join(' ');
  const trainRows = new Set(train.map(rowKey));
  let duplicates = 0;
  for (const row of test) if (trainRows.has(rowKey(row))) duplicates += 1;
  const report: OverlapReport = {
    ok: duplicates === 0,
    train: { rows: train.length },
    test: { rows: test.length },
    duplicateRows: { count: duplicates, share: test.length ? duplicates / test.length : 0 },
  };
  if (options.keys && options.keys.length) {
    const keys = options.keys;
    const entityKey = (row: Row) => {
      const parts = keys.map((c) => (isMissing(row[c]) ? null : toKey(row[c])));
      return parts.includes(null) ? null : parts.join(' ');
    };
    const trainKeys = new Set<string>();
    for (const row of train) {
      const key = entityKey(row);
      if (key !== null) trainKeys.add(key);
    }
    let count = 0;
    const examples: string[] = [];
    const seen = new Set<string>();
    for (const row of test) {
      const key = entityKey(row);
      if (key === null || !trainKeys.has(key)) continue;
      count += 1;
      if (!seen.has(key) && examples.length < (options.examples ?? 20)) {
        seen.add(key);
        examples.push(key);
      }
    }
    report.keyOverlap = { count, share: test.length ? count / test.length : 0, keys: examples };
    if (count > 0) report.ok = false;
  }
  return report;
}
