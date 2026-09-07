import type { ColumnType, Row } from './types';

/** Null, undefined, NaN and empty or blank strings count as missing. */
export function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The value as a finite number, accepting numeric strings, else null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const text = value.trim();
    if (!NUMERIC.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The value as a Date, accepting Date objects, ISO-like strings and epoch milliseconds, else null. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === 'string') {
    const text = value.trim();
    // Reject plain numbers: "2024" is a year to Date.parse but almost never a date in a dataset.
    if (NUMERIC.test(text)) return null;
    const time = Date.parse(text);
    return Number.isNaN(time) ? null : new Date(time);
  }
  return null;
}

const TRUE = new Set(['true', 'yes', 'y', '1', 't']);
const FALSE = new Set(['false', 'no', 'n', '0', 'f']);

/** The value as a boolean, accepting common textual forms, else null. */
export function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (TRUE.has(text)) return true;
    if (FALSE.has(text)) return false;
  }
  return null;
}

/** Stable text form of a value, used for categories and keys. */
export function toKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Whether a value satisfies a column type (missing values are not checked here). */
export function matchesType(value: unknown, type: ColumnType): boolean {
  switch (type) {
    case 'any':
      return true;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return toNumber(value) !== null;
    case 'integer': {
      const n = toNumber(value);
      return n !== null && Number.isInteger(n);
    }
    case 'boolean':
      return toBoolean(value) !== null;
    case 'date':
      return toDate(value) !== null;
  }
}

/** The names of every column seen across the rows, in first-seen order. */
export function columnNames(rows: readonly Row[]): string[] {
  const names = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) names.add(key);
  return Array.from(names);
}

/** Alias of {@link columnNames}, for readability when two windows are involved. */
export const columnNamesOf = columnNames;

/** Merges options over defaults, ignoring keys whose value is undefined (as adapters and CLIs pass unset options). */
export function withDefaults<T extends object>(defaults: T, given: Partial<T> | undefined): T {
  const merged: T = { ...defaults };
  if (given) for (const [key, value] of Object.entries(given)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  return merged;
}

/** Infers the narrowest type that fits every non-missing value of a column. */
export function inferType(values: readonly unknown[]): ColumnType {
  let any = false;
  let allNumber = true;
  let allInteger = true;
  let allBoolean = true;
  let allDate = true;
  let allString = true;
  for (const value of values) {
    if (isMissing(value)) continue;
    any = true;
    if (typeof value === 'boolean') {
      allNumber = allInteger = allDate = allString = false;
      continue;
    }
    const n = toNumber(value);
    if (n === null) {
      allNumber = allInteger = false;
    } else if (!Number.isInteger(n)) {
      allInteger = false;
    }
    if (toBoolean(value) === null || (typeof value !== 'boolean' && typeof value !== 'string')) allBoolean = false;
    if (value instanceof Date) {
      allString = false;
    } else if (typeof value !== 'string' || toDate(value) === null) {
      allDate = false;
    }
    if (typeof value !== 'string') allString = false;
  }
  if (!any) return 'any';
  if (allBoolean) return 'boolean';
  if (allInteger) return 'integer';
  if (allNumber) return 'number';
  if (allDate) return 'date';
  if (allString) return 'string';
  return 'any';
}
