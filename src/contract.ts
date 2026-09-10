import { formatDuration, parseDuration } from './duration';
import { profile } from './profile';
import type { ColumnType, Row } from './types';
import { columnNames, isMissing, matchesType, toDate, toKey, toNumber } from './values';

export interface ColumnSpec {
  /** Default `any`. Numeric strings satisfy `number`, ISO strings satisfy `date`, `'true'` satisfies `boolean`. */
  type?: ColumnType;
  /** Reject missing values (null, undefined, NaN, blank strings). Default false. */
  required?: boolean;
  /** Lower bound for numbers and dates. */
  min?: number | Date | string;
  /** Upper bound for numbers and dates. */
  max?: number | Date | string;
  /** Allowed values, compared by their text form. */
  enum?: readonly unknown[];
  /** Regular expression the text form must match. */
  pattern?: RegExp | string;
  minLength?: number;
  maxLength?: number;
  /** No value may repeat within the dataset. */
  unique?: boolean;
  /** Custom rule: return a message (or `false`) to flag the value, anything else to accept it. */
  check?: (value: unknown, row: Row) => string | boolean | null | undefined | void;
  description?: string;
}

export interface Freshness {
  /** A date column. */
  column: string;
  /** Longest acceptable age of the newest row, in milliseconds or `'2d'`-style text. */
  maxAge: number | string;
}

export interface Contract {
  name: string;
  columns: Record<string, ColumnSpec>;
  /** Columns that identify one record; the combination must be present and unique. */
  grain?: string[];
  freshness?: Freshness;
  /** What to do with columns the contract does not mention. Default `allow`. */
  extraColumns?: 'allow' | 'warn' | 'error';
  minRows?: number;
  description?: string;
}

export type IssueCode =
  | 'missing-column'
  | 'extra-column'
  | 'type'
  | 'required'
  | 'min'
  | 'max'
  | 'enum'
  | 'pattern'
  | 'length'
  | 'unique'
  | 'check'
  | 'grain'
  | 'freshness'
  | 'min-rows';

export interface Issue {
  code: IssueCode;
  severity: 'error' | 'warning';
  column?: string;
  /** Zero-based row index, for row-level issues. */
  row?: number;
  message: string;
  value?: unknown;
}

export interface ColumnSummary {
  present: boolean;
  /** Non-missing values. */
  count: number;
  missing: number;
  /** Rows with at least one issue in this column. */
  invalid: number;
}

export interface FreshnessResult {
  column: string;
  latest: Date | null;
  ageMs: number | null;
  maxAgeMs: number;
  ok: boolean;
}

export interface ValidationReport {
  /** True when no error-severity issue was found. */
  ok: boolean;
  contract: string;
  rows: number;
  /** At most `maxIssues` issues; `issueCounts` has the full totals. */
  issues: Issue[];
  issueCounts: Partial<Record<IssueCode, number>>;
  /** Issues not listed because of `maxIssues`. */
  truncated: number;
  columns: Record<string, ColumnSummary>;
  extraColumns: string[];
  duplicateKeys: number;
  freshness?: FreshnessResult;
}

export interface ValidateOptions {
  /** Reference time for freshness. Default now. */
  now?: Date;
  /** Cap on listed issues. Default 1000. */
  maxIssues?: number;
  /** Accept numeric strings, textual booleans and date strings for typed columns. Default true. */
  coerce?: boolean;
}

/** Checks a contract for internal consistency and returns it, for type inference and early errors. */
export function defineContract(contract: Contract): Contract {
  if (!contract.name) throw new Error('a contract needs a name');
  if (!contract.columns || typeof contract.columns !== 'object') throw new Error('a contract needs columns');
  for (const column of contract.grain ?? []) {
    if (!(column in contract.columns)) throw new Error(`grain column "${column}" is not in the contract`);
  }
  if (contract.freshness) {
    if (!(contract.freshness.column in contract.columns)) {
      throw new Error(`freshness column "${contract.freshness.column}" is not in the contract`);
    }
    parseDuration(contract.freshness.maxAge);
  }
  for (const [name, spec] of Object.entries(contract.columns)) {
    if (spec.pattern !== undefined) toRegExp(spec.pattern, name);
    const min = bound(spec.min);
    const max = bound(spec.max);
    if (min !== null && max !== null && min > max) throw new Error(`column "${name}" has min above max`);
  }
  return contract;
}

function toRegExp(pattern: RegExp | string, column: string): RegExp {
  if (pattern instanceof RegExp) return pattern;
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(`column "${column}" has an invalid pattern`);
  }
}

function bound(value: number | Date | string | undefined): number | null {
  if (value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const date = toDate(value);
  if (date) return date.getTime();
  const n = toNumber(value);
  if (n !== null) return n;
  throw new Error(`invalid bound "${value}"`);
}

function strictType(value: unknown, type: ColumnType): boolean {
  switch (type) {
    case 'any':
      return true;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return value instanceof Date && !Number.isNaN(value.getTime());
  }
}

function comparable(value: unknown, type: ColumnType): number | null {
  if (type === 'date') return toDate(value)?.getTime() ?? null;
  if (type === 'number' || type === 'integer' || type === 'any') return toNumber(value);
  return null;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Validates rows against a contract: types, required values, bounds, enums, patterns, lengths,
 * uniqueness, custom checks, record grain, extra and missing columns, row count and freshness.
 * @example
 * ```ts
 * const claims = defineContract({
 *   name: 'claims',
 *   grain: ['claim_id'],
 *   freshness: { column: 'reported_at', maxAge: '2d' },
 *   columns: {
 *     claim_id: { type: 'string', required: true, pattern: /^CLM-\d+$/ },
 *     amount: { type: 'number', required: true, min: 0, max: 5_000_000 },
 *     status: { enum: ['open', 'closed', 'denied'] },
 *     reported_at: { type: 'date', required: true },
 *   },
 * });
 * const report = validate(claims, rows);
 * if (!report.ok) console.log(validationToMarkdown(report));
 * ```
 */
export function validate(contract: Contract, rows: readonly Row[], options: ValidateOptions = {}): ValidationReport {
  const maxIssues = options.maxIssues ?? 1000;
  const coerce = options.coerce ?? true;
  const issues: Issue[] = [];
  const issueCounts: Partial<Record<IssueCode, number>> = {};
  let truncated = 0;
  const invalidRows = new Map<string, Set<number>>();
  const push = (issue: Issue) => {
    issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    if (issue.column !== undefined && issue.row !== undefined) {
      let rowsForColumn = invalidRows.get(issue.column);
      if (!rowsForColumn) {
        rowsForColumn = new Set();
        invalidRows.set(issue.column, rowsForColumn);
      }
      rowsForColumn.add(issue.row);
    }
    if (issues.length < maxIssues) issues.push(issue);
    else truncated += 1;
  };

  const present = new Set(columnNames(rows));
  const columns: Record<string, ColumnSummary> = {};
  const extraColumns = Array.from(present).filter((name) => !(name in contract.columns));
  const extraPolicy = contract.extraColumns ?? 'allow';
  if (extraPolicy !== 'allow') {
    for (const name of extraColumns) {
      push({
        code: 'extra-column',
        severity: extraPolicy === 'error' ? 'error' : 'warning',
        column: name,
        message: `column "${name}" is not in the contract`,
      });
    }
  }
  if (contract.minRows !== undefined && rows.length < contract.minRows) {
    push({ code: 'min-rows', severity: 'error', message: `${rows.length} rows, contract requires at least ${contract.minRows}` });
  }

  for (const [name, spec] of Object.entries(contract.columns)) {
    const summary: ColumnSummary = { present: present.has(name), count: 0, missing: 0, invalid: 0 };
    columns[name] = summary;
    if (!summary.present) {
      if (rows.length > 0) push({ code: 'missing-column', severity: 'error', column: name, message: `column "${name}" is missing` });
      continue;
    }
    const type = spec.type ?? 'any';
    const min = bound(spec.min);
    const max = bound(spec.max);
    const allowed = spec.enum ? new Set(spec.enum.map(toKey)) : null;
    const pattern = spec.pattern !== undefined ? toRegExp(spec.pattern, name) : null;
    const seen = spec.unique ? new Set<string>() : null;
    /** One invalid value in this column: every such issue is an error carrying the row and the value. */
    const invalid = (row: number, value: unknown, code: IssueCode, message: string) => push({ code, severity: 'error', column: name, row, value, message });
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const value = row[name];
      if (isMissing(value)) {
        summary.missing += 1;
        if (spec.required) push({ code: 'required', severity: 'error', column: name, row: i, message: `"${name}" is required` });
        continue;
      }
      summary.count += 1;
      if (!(coerce ? matchesType(value, type) : strictType(value, type))) {
        invalid(i, value, 'type', `"${name}" should be ${type}, got ${describe(value)}`);
        continue;
      }
      const comparableValue = min !== null || max !== null ? comparable(value, type) : null;
      if (comparableValue !== null && min !== null && comparableValue < min) invalid(i, value, 'min', `"${name}" ${describe(value)} is below ${describe(spec.min)}`);
      if (comparableValue !== null && max !== null && comparableValue > max) invalid(i, value, 'max', `"${name}" ${describe(value)} is above ${describe(spec.max)}`);
      const key = toKey(value);
      if (allowed && !allowed.has(key)) invalid(i, value, 'enum', `"${name}" ${describe(value)} is not one of the allowed values`);
      if (pattern && !pattern.test(key)) invalid(i, value, 'pattern', `"${name}" ${describe(value)} does not match ${pattern}`);
      if (typeof value === 'string' && spec.minLength !== undefined && value.length < spec.minLength) invalid(i, value, 'length', `"${name}" is shorter than ${spec.minLength}`);
      if (typeof value === 'string' && spec.maxLength !== undefined && value.length > spec.maxLength) invalid(i, value, 'length', `"${name}" is longer than ${spec.maxLength}`);
      if (seen) {
        if (seen.has(key)) invalid(i, value, 'unique', `"${name}" ${describe(value)} repeats`);
        else seen.add(key);
      }
      if (spec.check) {
        const verdict = spec.check(value, row);
        if (verdict === false || typeof verdict === 'string') invalid(i, value, 'check', verdict || `"${name}" failed its check`);
      }
    }
  }

  let duplicateKeys = 0;
  if (contract.grain && contract.grain.length && contract.grain.every((column) => present.has(column))) {
    const keys = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      const parts: string[] = [];
      let incomplete = false;
      for (const column of contract.grain) {
        const value = rows[i]![column];
        if (isMissing(value)) {
          incomplete = true;
          break;
        }
        parts.push(toKey(value));
      }
      if (incomplete) {
        push({ code: 'grain', severity: 'error', row: i, message: `row ${i} has an incomplete key (${contract.grain.join(', ')})` });
        continue;
      }
      const key = parts.join(' ');
      if (keys.has(key)) {
        duplicateKeys += 1;
        push({ code: 'grain', severity: 'error', row: i, message: `row ${i} repeats key ${parts.map(describe).join(', ')}` });
      } else {
        keys.add(key);
      }
    }
  }

  let freshness: FreshnessResult | undefined;
  if (contract.freshness) {
    const maxAgeMs = parseDuration(contract.freshness.maxAge);
    let latest: Date | null = null;
    for (const row of rows) {
      const date = toDate(row[contract.freshness.column]);
      if (date && (!latest || date > latest)) latest = date;
    }
    const now = options.now ?? new Date();
    const ageMs = latest ? now.getTime() - latest.getTime() : null;
    const ok = ageMs !== null && ageMs <= maxAgeMs;
    freshness = { column: contract.freshness.column, latest, ageMs, maxAgeMs, ok };
    if (!ok) {
      push({
        code: 'freshness',
        severity: 'error',
        column: contract.freshness.column,
        message:
          ageMs === null
            ? `"${contract.freshness.column}" has no valid dates`
            : `newest "${contract.freshness.column}" is ${formatDuration(ageMs)} old, limit ${formatDuration(maxAgeMs)}`,
      });
    }
  }

  for (const [name, rowsForColumn] of invalidRows) if (columns[name]) columns[name].invalid = rowsForColumn.size;
  return {
    ok: !issues.some((issue) => issue.severity === 'error') && truncated === 0,
    contract: contract.name,
    rows: rows.length,
    issues,
    issueCounts,
    truncated,
    columns,
    extraColumns,
    duplicateKeys,
    ...(freshness ? { freshness } : {}),
  };
}

export interface InferContractOptions {
  name: string;
  /** Turn string columns with up to this many distinct values into enums. Default 10. */
  enumMaxDistinct?: number;
  /** Widen numeric bounds by this share of the observed range. Default 0.1. */
  margin?: number;
  /** Mark columns without missing values as required. Default true. */
  requireComplete?: boolean;
}

/**
 * Drafts a contract from sample rows: inferred types, required flags for complete columns,
 * padded numeric bounds and enums for low-cardinality strings. Review it before relying on it;
 * the grain and freshness cannot be inferred.
 */
export function inferContract(rows: readonly Row[], options: InferContractOptions): Contract {
  const enumMaxDistinct = options.enumMaxDistinct ?? 10;
  const margin = options.margin ?? 0.1;
  const requireComplete = options.requireComplete ?? true;
  const columns: Record<string, ColumnSpec> = {};
  for (const [name, column] of Object.entries(profile(rows, { topCategories: enumMaxDistinct }).columns)) {
    const spec: ColumnSpec = {};
    if (column.type !== 'any') spec.type = column.type;
    if (requireComplete && column.missing === 0 && column.count > 0) spec.required = true;
    if (column.numeric && column.type !== 'date' && column.numeric.count > 0) {
      const { min, max } = column.numeric;
      const pad = max > min ? (max - min) * margin : Math.abs(min) * margin || 1;
      spec.min = column.type === 'integer' ? Math.floor(min - pad) : min - pad;
      spec.max = column.type === 'integer' ? Math.ceil(max + pad) : max + pad;
    }
    if (column.type === 'string' && column.count > 0 && column.distinct <= enumMaxDistinct) {
      spec.enum = column.categories!.map((c) => c.value);
    }
    columns[name] = spec;
  }
  return defineContract({ name: options.name, columns, extraColumns: 'warn' });
}
