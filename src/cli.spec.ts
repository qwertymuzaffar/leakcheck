import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type CliIO } from './cli';
import { toCsv } from './csv';
import { readRows } from './node';
import type { Row } from './types';

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function claims(seed: number, count: number, shift = 0): Row[] {
  const random = rng(seed);
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const paid = random() < 0.6;
    const amount = Math.round(random() * 5000) + shift;
    rows.push({
      claim_id: `CLM-${seed}-${i}`,
      customer_id: `C${Math.floor(random() * 100)}`,
      amount,
      region: random() < 0.5 ? 'north' : 'south',
      paid: paid ? 'yes' : 'no',
      payout: paid ? Math.round(amount * 0.9) : 0,
      reported_at: new Date(Date.UTC(2024, 5, 1 + Math.floor(random() * 20))).toISOString(),
    });
  }
  return rows;
}

let dir = '';
const files: Record<string, string> = {};
const out: string[] = [];
const err: string[] = [];
const io: CliIO = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
const stdout = () => out.join('\n');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leakcheck-'));
  files.train = join(dir, 'train.csv');
  files.test = join(dir, 'test.csv');
  files.current = join(dir, 'current.csv');
  files.contract = join(dir, 'contract.json');
  files.baseline = join(dir, 'baseline.json');
  files.ndjson = join(dir, 'rows.ndjson');
  files.json = join(dir, 'rows.json');
  files.tsv = join(dir, 'rows.tsv');
  const train = claims(1, 400);
  await writeFile(files.train, toCsv(train));
  await writeFile(files.test, toCsv([...claims(2, 100), ...train.slice(0, 5)]));
  await writeFile(files.current, toCsv(claims(3, 300, 1500)));
  await writeFile(files.ndjson, train.slice(0, 50).map((r) => JSON.stringify(r)).join('\n'));
  await writeFile(files.json, JSON.stringify({ rows: train.slice(0, 30) }));
  await writeFile(files.tsv, toCsv(train.slice(0, 30), undefined, '\t'));
  await writeFile(
    files.contract,
    JSON.stringify({
      name: 'claims',
      grain: ['claim_id'],
      freshness: { column: 'reported_at', maxAge: '30d' },
      columns: {
        claim_id: { type: 'string', required: true, pattern: '^CLM-' },
        amount: { type: 'number', min: 0, max: 5000 },
        paid: { enum: ['yes', 'no'] },
        reported_at: { type: 'date', required: true },
      },
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  out.length = 0;
  err.length = 0;
});

describe('leakcheck CLI', () => {
  it('prints usage and the version', async () => {
    expect(await run([], io)).toBe(2);
    expect(stdout()).toContain('Usage:');
    expect(await run(['help'], io)).toBe(0);
    expect(await run(['--version'], io)).toBe(0);
    expect(stdout()).toMatch(/\d+\.\d+\.\d+/);
    expect(await run(['nonsense'], io)).toBe(2);
    expect(err.join('\n')).toContain('unknown command "nonsense"');
  });

  it('leak: finds the payout proxy, exits 1, and can be told not to', async () => {
    expect(await run(['leak', files.train!, '--label', 'paid', '--exclude', 'claim_id,customer_id'], io)).toBe(1);
    expect(stdout()).toMatch(/^## Leakage: \d+ features? flagged/);
    expect(stdout()).toContain('| payout |');
    out.length = 0;
    expect(await run(['leak', files.train!, '--label', 'paid', '--exclude', 'claim_id,customer_id', '--json', '--no-fail'], io)).toBe(0);
    const report = JSON.parse(stdout()) as { flagged: string[] };
    expect(report.flagged).toEqual(['payout']);
    expect(await run(['leak', files.train!], io)).toBe(2);
    expect(err.join('\n')).toContain('--label is required');
    expect(await run(['leak', files.train!, '--label', 'paid', '--association', 'high'], io)).toBe(2);
  });

  it('overlap: reports duplicated rows and shared customers', async () => {
    expect(await run(['overlap', files.train!, files.test!, '--keys', 'customer_id', '--json'], io)).toBe(1);
    const report = JSON.parse(stdout()) as { duplicateRows: { count: number }; keyOverlap: { count: number } };
    expect(report.duplicateRows.count).toBe(5);
    expect(report.keyOverlap.count).toBeGreaterThan(50);
  });

  it('drift: compares rows, and a saved baseline gives the same answer', async () => {
    expect(await run(['drift', files.train!, files.current!, '--exclude', 'x', '--psi', '0.1'], io)).toBe(1);
    expect(stdout()).toMatch(/^## Drift: \d+ columns? drifted/);
    expect(stdout()).toContain('### amount');
    out.length = 0;
    expect(await run(['baseline', files.train!, '--out', files.baseline!, '--bins', '5'], io)).toBe(0);
    expect(stdout()).toMatch(/baseline of 400 rows written to .*: \d+ numeric, \d+ categorical, \d+ skipped/);
    const saved = JSON.parse(await readFile(files.baseline!, 'utf8')) as { version: number; columns: Record<string, { kind: string }> };
    expect(saved.version).toBe(1);
    expect(saved.columns.amount!.kind).toBe('numeric');
    out.length = 0;
    expect(await run(['drift', files.baseline!, files.current!, '--json'], io)).toBe(1);
    const fromBaseline = JSON.parse(stdout()) as { reference: { rows: number }; drifted: string[]; columns: Record<string, { psi: number }> };
    expect(fromBaseline.reference.rows).toBe(400);
    expect(fromBaseline.drifted).toContain('amount');
    out.length = 0;
    expect(await run(['drift', files.train!, files.current!, '--json', '--bins', '5'], io)).toBe(1);
    const fromRows = JSON.parse(stdout()) as { columns: Record<string, { psi: number }> };
    expect(fromBaseline.columns.amount!.psi).toBeCloseTo(fromRows.columns.amount!.psi, 10);
    out.length = 0;
    expect(await run(['drift', files.train!, files.train!, '--no-bins'], io)).toBe(0);
    expect(stdout()).toContain('## Drift: stable');
    expect(await run(['drift', files.train!, files.current!, '--binning', 'sideways'], io)).toBe(2);
  });

  it('validate and infer: contracts round-trip through JSON files', async () => {
    expect(await run(['validate', files.contract!, files.train!, '--now', '2024-07-01T00:00:00Z'], io)).toBe(0);
    expect(stdout()).toContain('## claims: valid');
    out.length = 0;
    expect(await run(['validate', files.contract!, files.current!, '--now', '2024-07-01T00:00:00Z', '--json'], io)).toBe(1);
    const report = JSON.parse(stdout()) as { issueCounts: Record<string, number> };
    expect(report.issueCounts.max).toBeGreaterThan(0);
    out.length = 0;
    expect(await run(['validate', files.contract!, files.train!, '--strict', '--no-fail'], io)).toBe(0);
    expect(stdout()).toContain('## claims: invalid'); // CSV values are strings, which --strict rejects for typed columns
    out.length = 0;
    const inferred = join(dir, 'inferred.json');
    expect(await run(['infer', files.train!, '--name', 'claims-draft', '--out', inferred], io)).toBe(0);
    expect(stdout()).toContain('written to');
    out.length = 0;
    expect(await run(['validate', inferred, files.train!], io)).toBe(0);
    out.length = 0;
    expect(await run(['infer', files.train!, '--name', 'x', '--json'], io)).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ name: 'x' });
    out.length = 0;
    expect(await run(['infer', files.train!, '--name', 'x'], io)).toBe(0);
    expect(stdout()).toContain('## Contract: x');
    expect(await run(['infer', files.train!], io)).toBe(2);
  });

  it('profile and data readers: every supported file type loads', async () => {
    expect(await run(['profile', files.train!, '--columns', 'amount,region'], io)).toBe(0);
    expect(stdout()).toContain('## Profile: 400 rows, 2 columns');
    out.length = 0;
    expect(await run(['profile', files.ndjson!, '--json'], io)).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ rows: 50 });
    expect((await readRows(files.json!)).length).toBe(30);
    expect((await readRows(files.tsv!)).length).toBe(30);
    expect((await readRows(files.tsv!))[0]).toMatchObject({ region: expect.any(String) });
    await expect(readRows(join(dir, 'nope.xml'))).rejects.toThrow(/unsupported data file/);
    await writeFile(join(dir, 'bad.json'), '{"x":1}');
    await expect(readRows(join(dir, 'bad.json'))).rejects.toThrow(/expected a JSON array/);
    expect(await run(['profile', join(dir, 'missing.csv')], io)).toBe(2);
    expect(err.join('\n')).toMatch(/ENOENT|no such file/);
  });
});
