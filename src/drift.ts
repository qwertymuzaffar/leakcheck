import { categoryCounts, numericStats, numericValues } from './profile';
import { binCounts, chiSquareTest, jensenShannon, ksTest, psi, quantileEdges, toShares, widthEdges } from './stats';
import type { NumericStats, Row } from './types';
import { columnNames, columnNamesOf, inferType, isMissing, toKey } from './values';

export interface DriftThresholds {
  /** PSI above this flags a column. Default 0.2. */
  psi: number;
  /** A KS or chi-square p-value below this flags a column. Default 0.05. */
  pValue: number;
  /** A change in the missing-value rate above this flags a column. Default 0.1. */
  missingRate: number;
}

export interface DriftOptions {
  /** Columns to compare; defaults to every column of the reference rows. */
  columns?: string[];
  /** Bins for numeric columns. Default 10. */
  bins?: number;
  /** `quantile` bins (equal reference mass, the default) or equal `width` bins over the reference range. */
  binning?: 'quantile' | 'width';
  thresholds?: Partial<DriftThresholds>;
  /** Fewest non-missing values a column needs in each window. Default 20. */
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
}

export type DriftKind = 'numeric' | 'categorical' | 'skipped';

export interface DriftBin {
  label: string;
  /** Share of the reference window. */
  reference: number;
  /** Share of the current window. */
  current: number;
}

export interface WindowSummary {
  count: number;
  missing: number;
  missingRate: number;
}

export interface ColumnDrift {
  column: string;
  kind: DriftKind;
  /** Why the column was skipped. */
  reason?: string;
  reference: WindowSummary;
  current: WindowSummary;
  psi: number;
  jsDivergence: number;
  ks?: { statistic: number; pValue: number };
  chiSquare?: { statistic: number; pValue: number; df: number };
  bins: DriftBin[];
  /** Current missing rate minus reference missing rate. */
  missingRateDelta: number;
  referenceStats?: NumericStats;
  currentStats?: NumericStats;
  /** Human-readable reasons the column counts as drifted. */
  signals: string[];
  drifted: boolean;
}

export interface DriftReport {
  /** True when no column drifted. */
  ok: boolean;
  reference: { rows: number };
  current: { rows: number };
  thresholds: DriftThresholds;
  columns: Record<string, ColumnDrift>;
  drifted: string[];
  skipped: string[];
}

const DEFAULT_THRESHOLDS: DriftThresholds = { psi: 0.2, pValue: 0.05, missingRate: 0.1 };

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return Number(n.toPrecision(4)).toString();
}

function summary(values: readonly unknown[]): WindowSummary {
  let missing = 0;
  for (const value of values) if (isMissing(value)) missing += 1;
  const count = values.length - missing;
  return { count, missing, missingRate: values.length ? missing / values.length : 0 };
}

/** Compares one column between two windows. */
export function driftColumn(
  column: string,
  referenceValues: readonly unknown[],
  currentValues: readonly unknown[],
  options: DriftOptions = {},
): ColumnDrift {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const minSamples = options.minSamples ?? 20;
  const reference = summary(referenceValues);
  const current = summary(currentValues);
  const missingRateDelta = current.missingRate - reference.missingRate;
  const base: ColumnDrift = {
    column,
    kind: 'skipped',
    reference,
    current,
    psi: 0,
    jsDivergence: 0,
    bins: [],
    missingRateDelta,
    signals: [],
    drifted: false,
  };
  const skip = (reason: string): ColumnDrift => ({ ...base, reason });
  if (reference.count < minSamples) return skip(`only ${reference.count} reference values (minimum ${minSamples})`);
  if (current.count < minSamples) return skip(`only ${current.count} current values (minimum ${minSamples})`);

  const type = inferType(referenceValues);
  const forcedCategorical = options.categorical?.includes(column) ?? false;
  const forcedNumeric = options.numeric?.includes(column) ?? false;
  const numeric = forcedNumeric || (!forcedCategorical && (type === 'number' || type === 'integer' || type === 'date'));
  const signals: string[] = [];
  if (Math.abs(missingRateDelta) > thresholds.missingRate) {
    signals.push(`missing rate ${fmt(reference.missingRate)} -> ${fmt(current.missingRate)}`);
  }

  let result: ColumnDrift;
  if (numeric) {
    const asDates = type === 'date' && !forcedNumeric;
    const ref = numericValues(referenceValues, asDates).sort((a, b) => a - b);
    const cur = numericValues(currentValues, asDates).sort((a, b) => a - b);
    if (ref.length < minSamples || cur.length < minSamples) return skip('too few numeric values');
    const bins = options.bins ?? 10;
    const edges = options.binning === 'width' ? widthEdges(ref[0]!, ref[ref.length - 1]!, bins) : quantileEdges(ref, bins);
    const referenceShares = toShares(binCounts(ref, edges));
    const currentShares = toShares(binCounts(cur, edges));
    const ks = ksTest(ref, cur);
    const value = psi(referenceShares, currentShares);
    if (value > thresholds.psi) signals.push(`psi ${fmt(value)} > ${fmt(thresholds.psi)}`);
    if (ks.pValue < thresholds.pValue) signals.push(`ks p=${fmt(ks.pValue)} < ${fmt(thresholds.pValue)}`);
    const labels = edges.map((edge, i) => (i === 0 ? `<= ${fmt(edge)}` : `(${fmt(edges[i - 1]!)}, ${fmt(edge)}]`));
    labels.push(edges.length ? `> ${fmt(edges[edges.length - 1]!)}` : 'all');
    result = {
      ...base,
      kind: 'numeric',
      psi: value,
      jsDivergence: jensenShannon(referenceShares, currentShares),
      ks,
      bins: labels.map((label, i) => ({ label, reference: referenceShares[i]!, current: currentShares[i]! })),
      referenceStats: numericStats(ref),
      currentStats: numericStats(cur),
      signals,
    };
  } else {
    const maxCategories = options.maxCategories ?? 50;
    const refCounts = categoryCounts(referenceValues);
    if (refCounts.length > maxCategories && refCounts.length / reference.count > (options.maxDistinctShare ?? 0.5)) {
      return skip(`high cardinality: ${refCounts.length} distinct values in ${reference.count} rows`);
    }
    const curCounts = new Map(categoryCounts(currentValues).map((c) => [c.value, c.count]));
    const kept = refCounts.slice(0, maxCategories).map((c) => c.value);
    const keptSet = new Set(kept);
    const refVector = kept.map((value) => refCounts.find((c) => c.value === value)!.count);
    const curVector = kept.map((value) => curCounts.get(value) ?? 0);
    let refOther = 0;
    let curOther = 0;
    for (const c of refCounts) if (!keptSet.has(c.value)) refOther += c.count;
    for (const [value, count] of curCounts) if (!keptSet.has(value)) curOther += count;
    const labels = kept.slice();
    if (refOther > 0 || curOther > 0) {
      labels.push('other');
      refVector.push(refOther);
      curVector.push(curOther);
    }
    const referenceShares = toShares(refVector);
    const currentShares = toShares(curVector);
    const chiSquare = chiSquareTest(refVector, curVector);
    const value = psi(referenceShares, currentShares);
    if (value > thresholds.psi) signals.push(`psi ${fmt(value)} > ${fmt(thresholds.psi)}`);
    if (chiSquare.pValue < thresholds.pValue) signals.push(`chi-square p=${fmt(chiSquare.pValue)} < ${fmt(thresholds.pValue)}`);
    result = {
      ...base,
      kind: 'categorical',
      psi: value,
      jsDivergence: jensenShannon(referenceShares, currentShares),
      chiSquare,
      bins: labels.map((label, i) => ({ label, reference: referenceShares[i]!, current: currentShares[i]! })),
      signals,
    };
  }
  result.drifted = signals.length > 0;
  return result;
}

/**
 * Compares a current window of rows with a reference window column by column: PSI and a KS test
 * over reference-quantile bins for numeric columns (dates included), PSI and a chi-square test
 * over categories for the rest, plus the change in missing rate.
 * @example
 * ```ts
 * const report = detectDrift(lastMonth, today, { thresholds: { psi: 0.1 } });
 * for (const column of report.drifted) console.log(column, report.columns[column].signals);
 * ```
 */
export function detectDrift(reference: readonly Row[], current: readonly Row[], options: DriftOptions = {}): DriftReport {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const names = options.columns ?? columnNames(reference);
  const currentNames = new Set(columnNamesOf(current));
  const columns: Record<string, ColumnDrift> = {};
  const drifted: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const referenceValues = reference.map((row) => row[name]);
    const currentValues = current.map((row) => row[name]);
    const result = currentNames.has(name)
      ? driftColumn(name, referenceValues, currentValues, { ...options, thresholds })
      : { ...driftColumn(name, referenceValues, [], { ...options, thresholds, minSamples: Infinity }), reason: 'missing in the current window' };
    columns[name] = result;
    if (result.kind === 'skipped') skipped.push(name);
    else if (result.drifted) drifted.push(name);
  }
  return { ok: drifted.length === 0, reference: { rows: reference.length }, current: { rows: current.length }, thresholds, columns, drifted, skipped };
}
