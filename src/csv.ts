import type { Row } from './types';
import { toBoolean, toNumber } from './values';

export interface CsvOptions {
  /** Field delimiter; detected from the header line (`,` `;` tab `|`) when omitted. */
  delimiter?: string;
  /** Whether the first line holds the column names. Default true; otherwise columns are `c0`, `c1`, ... */
  header?: boolean;
  /** Convert numeric and `true`/`false` strings to numbers and booleans. Default false: the checks coerce on their own. */
  infer?: boolean;
  /** Trim whitespace around unquoted fields. Default true. */
  trim?: boolean;
}

const DELIMITERS = [',', ';', '\t', '|'];

function detectDelimiter(line: string): string {
  let best = ',';
  let bestCount = -1;
  let quoted = false;
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** Splits CSV text into records of fields, honouring quotes, doubled quotes and newlines inside quotes. */
export function splitCsv(text: string, delimiter: string, trim = true): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const push = () => {
    record.push(wasQuoted || !trim ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (ch === delimiter) {
      push();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      push();
      records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || wasQuoted || record.length > 0) {
    push();
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

function inferValue(text: string): unknown {
  if (text === '') return '';
  const n = toNumber(text);
  if (n !== null) return n;
  const lower = text.toLowerCase();
  if (lower === 'true' || lower === 'false') return toBoolean(lower);
  return text;
}

/**
 * Parses CSV text into rows keyed by the header. Handles quoted fields, doubled quotes, newlines
 * inside quotes, CRLF endings and a byte-order mark; the delimiter is detected when not given.
 * @example
 * ```ts
 * const rows = parseCsv(await fs.readFile('claims.csv', 'utf8'));
 * ```
 */
export function parseCsv(text: string, options: CsvOptions = {}): Row[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = options.delimiter ?? detectDelimiter(firstLine);
  const records = splitCsv(text, delimiter, options.trim ?? true);
  if (records.length === 0) return [];
  const header = options.header ?? true;
  const names = header ? records[0]!.map((name, i) => (name === '' ? `c${i}` : name)) : records[0]!.map((_, i) => `c${i}`);
  const rows: Row[] = [];
  for (const record of header ? records.slice(1) : records) {
    const row: Row = {};
    for (let i = 0; i < names.length; i += 1) {
      const value = record[i] ?? '';
      row[names[i]!] = options.infer ? inferValue(value) : value;
    }
    rows.push(row);
  }
  return rows;
}

/** Parses newline-delimited JSON (one object per line; blank lines are skipped). */
export function parseNdjson(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('each NDJSON line must be a JSON object');
    rows.push(parsed as Row);
  }
  return rows;
}

/** Serialises rows as CSV with a header, quoting fields that need it. */
export function toCsv(rows: readonly Row[], columns?: readonly string[], delimiter = ','): string {
  const names = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
    return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [names.map(escape).join(delimiter)];
  for (const row of rows) lines.push(names.map((name) => escape(row[name])).join(delimiter));
  return lines.join('\n');
}
