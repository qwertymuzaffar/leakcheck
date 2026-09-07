import { isBaseline, summarizeColumn, type Baseline, type BaselineColumn, type BaselineOptions } from './baseline';
import { categoryCounts, numericStats, numericValues } from './profile';
import { binCounts, chiSquareTest, jensenShannon, ksTest, psi, toShares } from './stats';
import type { NumericStats, Row } from './types';
import { columnNames, isMissing, withDefaults } from './values';

export interface DriftThresholds {
  /** PSI above this flags a column. Default 0.2. */
  psi: number;
  /** A KS or chi-square p-value below this flags a column. Default 0.05. */
  pValue: number;
  /** A change in the missing-value rate above this flags a column. Default 0.1. */
  missingRate: number;
}

export interface DriftOptions extends BaselineOptions {
  thresholds?: Partial<DriftThresholds>;
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

/** Compares a current window's values with a reference column summary. */
export function compareColumn(
  column: string,
  reference: BaselineColumn,
  currentValues: readonly unknown[],
  options: DriftOptions = {},
): ColumnDrift {
  const thresholds = withDefaults(DEFAULT_THRESHOLDS, options.thresholds);
  const minSamples = options.minSamples ?? 20;
  const referenceSummary: WindowSummary = {
    count: reference.count,
    missing: reference.missing,
    missingRate: reference.count + reference.missing ? reference.missing / (reference.count + reference.missing) : 0,
  };
  const current = summary(currentValues);
  const missingRateDelta = current.missingRate - referenceSummary.missingRate;
  const base: ColumnDrift = {
    column,
    kind: 'skipped',
    reference: referenceSummary,
    current,
    psi: 0,
    jsDivergence: 0,
    bins: [],
    missingRateDelta,
    signals: [],
    drifted: false,
  };
  const skip = (reason: string): ColumnDrift => ({ ...base, reason });
  if (reference.kind === 'skipped') return skip(reference.reason ?? 'skipped in the reference');
  if (current.count < minSamples) return skip(`only ${current.count} current values (minimum ${minSamples})`);

  const signals: string[] = [];
  if (Math.abs(missingRateDelta) > thresholds.missingRate) {
    signals.push(`missing rate ${fmt(referenceSummary.missingRate)} -> ${fmt(current.missingRate)}`);
  }

  let result: ColumnDrift;
  if (reference.kind === 'numeric') {
    const edges = reference.edges ?? [];
    const cur = numericValues(currentValues, reference.isDate ?? false).sort((a, b) => a - b);
    if (cur.length < minSamples) return skip('too few numeric values');
    const referenceShares = toShares(reference.counts ?? []);
    const currentShares = toShares(binCounts(cur, edges));
    const ks = ksTest(reference.sample ?? [], cur);
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
      ...(reference.stats ? { referenceStats: reference.stats } : {}),
      currentStats: numericStats(cur),
      signals,
    };
  } else {
    const kept = reference.categories ?? [];
    const keptSet = new Set(kept.map((c) => c.value));
    const curCounts = new Map(categoryCounts(currentValues).map((c) => [c.value, c.count]));
    const refVector = kept.map((c) => c.count);
    const curVector = kept.map((c) => curCounts.get(c.value) ?? 0);
    const refOther = reference.other ?? 0;
    let curOther = 0;
    for (const [value, count] of curCounts) if (!keptSet.has(value)) curOther += count;
    const labels = kept.map((c) => c.value);
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

/** Compares one column between two windows of raw values. */
export function driftColumn(
  column: string,
  referenceValues: readonly unknown[],
  currentValues: readonly unknown[],
  options: DriftOptions = {},
): ColumnDrift {
  return compareColumn(column, summarizeColumn(column, referenceValues, { ...options, sampleSize: options.sampleSize ?? Infinity }), currentValues, options);
}

/**
 * Compares a current window of rows with a reference, column by column: PSI and a KS test over
 * reference-quantile bins for numeric columns (dates included), PSI and a chi-square test over
 * categories for the rest, plus the change in missing rate. The reference is either the rows of
 * the reference window or a {@link Baseline} saved earlier.
 * @example
 * ```ts
 * const report = detectDrift(lastMonth, today, { thresholds: { psi: 0.1 } });
 * for (const column of report.drifted) console.log(column, report.columns[column].signals);
 * ```
 */
export function detectDrift(reference: readonly Row[] | Baseline, current: readonly Row[], options: DriftOptions = {}): DriftReport {
  const thresholds = withDefaults(DEFAULT_THRESHOLDS, options.thresholds);
  const currentNames = new Set(columnNames(current));
  const columns: Record<string, ColumnDrift> = {};
  const drifted: string[] = [];
  const skipped: string[] = [];
  const baseline = isBaseline(reference) ? reference : null;
  const names = options.columns ?? (baseline ? Object.keys(baseline.columns) : columnNames(reference as readonly Row[]));
  for (const name of names) {
    const summarized = baseline
      ? baseline.columns[name]
      : summarizeColumn(
          name,
          (reference as readonly Row[]).map((row) => row[name]),
          { ...options, sampleSize: options.sampleSize ?? Infinity },
        );
    const currentValues = current.map((row) => row[name]);
    let result: ColumnDrift;
    if (!summarized) {
      result = compareColumn(name, { kind: 'skipped', type: 'any', count: 0, missing: 0, reason: 'not in the baseline' }, currentValues, { ...options, thresholds });
    } else if (!currentNames.has(name)) {
      result = { ...compareColumn(name, summarized, [], { ...options, thresholds, minSamples: Infinity }), reason: 'missing in the current window' };
    } else {
      result = compareColumn(name, summarized, currentValues, { ...options, thresholds });
    }
    columns[name] = result;
    if (result.kind === 'skipped') skipped.push(name);
    else if (result.drifted) drifted.push(name);
  }
  return {
    ok: drifted.length === 0,
    reference: { rows: baseline ? baseline.rows : (reference as readonly Row[]).length },
    current: { rows: current.length },
    thresholds,
    columns,
    drifted,
    skipped,
  };
}
