import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseCsv, parseNdjson, type CsvOptions } from './csv';
import type { Row } from './types';

/** Reads a CSV file into rows (see `parseCsv`). `.tsv` files default to a tab delimiter. */
export async function readCsv(path: string, options: CsvOptions = {}): Promise<Row[]> {
  const text = await readFile(path, 'utf8');
  return parseCsv(text, extname(path).toLowerCase() === '.tsv' ? { delimiter: '\t', ...options } : options);
}

/** Reads a newline-delimited JSON file into rows. */
export async function readNdjson(path: string): Promise<Row[]> {
  return parseNdjson(await readFile(path, 'utf8'));
}

/** Reads and parses a JSON file. */
export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * Reads rows from a data file by extension: `.csv`, `.tsv`, `.ndjson`, `.jsonl`, or `.json`
 * holding an array of objects (or an object with a `rows` array).
 */
export async function readRows(path: string, options: CsvOptions = {}): Promise<Row[]> {
  const extension = extname(path).toLowerCase();
  if (extension === '.csv' || extension === '.tsv') return readCsv(path, options);
  if (extension === '.ndjson' || extension === '.jsonl') return readNdjson(path);
  if (extension === '.json') {
    const parsed = await readJson<unknown>(path);
    const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : null;
    if (!rows) throw new Error(`${path}: expected a JSON array of objects or an object with a "rows" array`);
    return rows as Row[];
  }
  throw new Error(`${path}: unsupported data file (use .csv, .tsv, .ndjson, .jsonl or .json)`);
}

/** Writes a value as JSON. */
export async function writeJson(path: string, value: unknown, pretty = true): Promise<void> {
  await writeFile(path, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), 'utf8');
}
