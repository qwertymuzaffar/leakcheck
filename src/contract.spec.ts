import { defineContract, inferContract, validate, type Contract } from './contract';
import { contractToMarkdown, validationToMarkdown } from './report';
import type { Row } from './types';

const claims = defineContract({
  name: 'claims',
  grain: ['claim_id'],
  freshness: { column: 'reported_at', maxAge: '2d' },
  minRows: 2,
  columns: {
    claim_id: { type: 'string', required: true, pattern: /^CLM-\d+$/ },
    amount: { type: 'number', required: true, min: 0, max: 1_000_000 },
    status: { type: 'string', enum: ['open', 'closed', 'denied'] },
    reported_at: { type: 'date', required: true, min: '2020-01-01' },
    policy: { type: 'string', minLength: 3, maxLength: 12, unique: true },
    fraud: { type: 'boolean' },
    notes: { check: (value) => (typeof value === 'string' && value.includes('TODO') ? 'notes still contain TODO' : true) },
  },
});

const now = new Date('2024-06-10T00:00:00Z');
const good: Row[] = [
  { claim_id: 'CLM-1', amount: 120.5, status: 'open', reported_at: '2024-06-09T12:00:00Z', policy: 'POL-A', fraud: false, notes: 'ok' },
  { claim_id: 'CLM-2', amount: '80', status: 'closed', reported_at: new Date('2024-06-08T00:00:00Z'), policy: 'POL-B', fraud: 'no', notes: null },
];

describe('defineContract', () => {
  it('rejects inconsistent definitions', () => {
    expect(() => defineContract({ name: '', columns: {} })).toThrow(/needs a name/);
    expect(() => defineContract({ name: 'x', columns: {}, grain: ['id'] })).toThrow(/grain column "id"/);
    expect(() => defineContract({ name: 'x', columns: { a: {} }, freshness: { column: 'b', maxAge: '1d' } })).toThrow(/freshness column/);
    expect(() => defineContract({ name: 'x', columns: { a: {} }, freshness: { column: 'a', maxAge: 'later' } })).toThrow(/invalid duration/);
    expect(() => defineContract({ name: 'x', columns: { a: { pattern: '(' } } })).toThrow(/invalid pattern/);
    expect(() => defineContract({ name: 'x', columns: { a: { min: 5, max: 1 } } })).toThrow(/min above max/);
    expect(() => defineContract({ name: 'x', columns: { a: { min: 'soon' } } })).toThrow(/invalid bound/);
    expect(defineContract({ name: 'x', columns: { a: { min: new Date(0), max: '2020-01-01' } } }).name).toBe('x');
  });
});

describe('validate', () => {
  it('accepts a clean dataset and summarises it', () => {
    const report = validate(claims, good, { now });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.rows).toBe(2);
    expect(report.columns.notes).toEqual({ present: true, count: 1, missing: 1, invalid: 0 });
    expect(report.freshness).toMatchObject({ column: 'reported_at', ok: true, ageMs: 12 * 3_600_000 });
    expect(report.duplicateKeys).toBe(0);
    expect(report.extraColumns).toEqual([]);
  });

  it('reports every rule with row numbers and counts', () => {
    const bad: Row[] = [
      { claim_id: 'X1', amount: -5, status: 'lost', reported_at: '2019-12-31', policy: 'AB', fraud: 'maybe', notes: 'TODO check', extra: 1 },
      { claim_id: 'CLM-2', amount: 'lots', status: 'open', reported_at: '2024-06-01', policy: 'POL-B', notes: 'fine' },
      { claim_id: 'CLM-2', amount: 2_000_000, reported_at: null, policy: 'POL-B', notes: 'fine' },
      { amount: 1, policy: 'POLICY-NUMBER-TOO-LONG', reported_at: '2024-06-01' },
    ];
    const report = validate(claims, bad, { now: new Date('2024-06-10T00:00:00Z') });
    expect(report.ok).toBe(false);
    const codes = (code: string) => report.issues.filter((issue) => issue.code === code);
    expect(codes('pattern')).toHaveLength(1);
    expect(codes('pattern')[0]).toMatchObject({ column: 'claim_id', row: 0 });
    expect(codes('min').map((i) => i.column)).toEqual(['amount', 'reported_at']);
    expect(codes('max')).toHaveLength(1);
    expect(codes('enum')[0]).toMatchObject({ row: 0, value: 'lost' });
    expect(codes('type').map((i) => [i.column, i.row])).toEqual([
      ['amount', 1],
      ['fraud', 0],
    ]);
    expect(codes('length').map((i) => i.row)).toEqual([0, 3]);
    expect(codes('unique')[0]).toMatchObject({ column: 'policy', row: 2 });
    expect(codes('check')[0]!.message).toBe('notes still contain TODO');
    expect(codes('required').map((i) => [i.column, i.row])).toEqual([
      ['claim_id', 3],
      ['reported_at', 2],
    ]);
    expect(codes('grain').map((i) => i.row)).toEqual([2, 3]);
    expect(report.duplicateKeys).toBe(1);
    expect(codes('freshness')[0]!.message).toContain('9d');
    expect(report.extraColumns).toEqual(['extra']);
    expect(codes('extra-column')).toHaveLength(0);
    expect(report.columns.amount!.invalid).toBe(3);
    expect(report.issueCounts.type).toBe(2);
    expect(report.truncated).toBe(0);
  });

  it('handles missing columns, extra column policies, minRows and empty datasets', () => {
    const report = validate(claims, [{ claim_id: 'CLM-1' }], { now });
    expect(report.issueCounts['missing-column']).toBe(6);
    expect(report.columns.amount).toMatchObject({ present: false });
    expect(report.issueCounts['min-rows']).toBe(1);
    expect(report.freshness?.ok).toBe(false);

    const strict: Contract = { ...claims, extraColumns: 'error', freshness: undefined, minRows: undefined };
    expect(validate(strict, [{ ...good[0]!, extra: 1 }]).issueCounts['extra-column']).toBe(1);
    const warned = validate({ ...strict, extraColumns: 'warn' }, [{ ...good[0]!, extra: 1 }]);
    expect(warned.ok).toBe(true);
    expect(warned.issues[0]).toMatchObject({ code: 'extra-column', severity: 'warning' });

    const empty = validate({ name: 'e', columns: { a: { required: true } } }, []);
    expect(empty.ok).toBe(true);
    expect(empty.columns.a).toMatchObject({ present: false, count: 0 });
  });

  it('caps listed issues and keeps the totals', () => {
    const rows = Array.from({ length: 50 }, () => ({ claim_id: 'bad', amount: 1, reported_at: '2024-06-09' }));
    const report = validate(claims, rows, { now, maxIssues: 5 });
    expect(report.issues).toHaveLength(5);
    expect(report.issueCounts.pattern).toBe(50);
    expect(report.truncated).toBeGreaterThan(40);
    expect(report.ok).toBe(false);
  });

  it('can refuse coerced values', () => {
    const rows = [{ claim_id: 'CLM-1', amount: '80', reported_at: '2024-06-09', fraud: 'no' }];
    expect(validate(claims, rows, { now }).issueCounts.type).toBeUndefined();
    const strict = validate(claims, rows, { now, coerce: false });
    expect(strict.issues.filter((i) => i.code === 'type').map((i) => i.column)).toEqual(['amount', 'reported_at', 'fraud']);
    expect(validate({ name: 's', columns: { n: { type: 'integer' }, d: { type: 'date' }, s: { type: 'string' } } }, [{ n: 2.5, d: new Date(), s: 'x' }], { coerce: false }).issueCounts.type).toBe(1);
  });
});

describe('inferContract', () => {
  const sample: Row[] = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    amount: 100 + i * 2.5,
    status: i % 3 === 0 ? 'open' : 'closed',
    reported_at: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
    note: i % 5 === 0 ? null : `n${i}`,
    ok: i % 2 === 0,
  }));

  it('drafts a contract the sample satisfies, with padded bounds and enums', () => {
    const contract = inferContract(sample, { name: 'claims-draft' });
    expect(contract.columns.id).toEqual({ type: 'integer', required: true, min: -3, max: 44 });
    expect(contract.columns.amount).toMatchObject({ type: 'number', required: true });
    expect(contract.columns.amount!.min).toBeCloseTo(100 - 9.75);
    expect(contract.columns.status).toEqual({ type: 'string', required: true, enum: ['closed', 'open'] });
    expect(contract.columns.reported_at).toEqual({ type: 'date', required: true });
    expect(contract.columns.note).toEqual({ type: 'string' });
    expect(contract.columns.ok).toEqual({ type: 'boolean', required: true });
    expect(contract.extraColumns).toBe('warn');
    expect(validate(contract, sample).ok).toBe(true);
    expect(validate(contract, [{ ...sample[0]!, amount: 5 }]).issueCounts.min).toBe(1);
  });

  it('honours its options', () => {
    const contract = inferContract(sample, { name: 'x', enumMaxDistinct: 1, margin: 0, requireComplete: false });
    expect(contract.columns.status!.enum).toBeUndefined();
    expect(contract.columns.id).toEqual({ type: 'integer', min: 1, max: 40 });
    expect(inferContract([{ c: 5 }], { name: 'one' }).columns.c).toMatchObject({ min: 4, max: 6 });
    expect(inferContract([{ c: 5.5 }], { name: 'one' }).columns.c).toMatchObject({ min: 4.95, max: 6.05 });
    expect(inferContract([{ c: 0 }], { name: 'zero' }).columns.c).toMatchObject({ min: -1, max: 1 });
    expect(inferContract([{ c: null }], { name: 'empty' }).columns.c).toEqual({});
  });
});

describe('markdown', () => {
  it('renders validation reports and contracts', () => {
    const report = validate(claims, [{ claim_id: 'X', amount: -1, reported_at: '2024-06-09', policy: 'POL-A' }], { now });
    const md = validationToMarkdown(report, { maxIssues: 1 });
    expect(md).toContain('## claims: invalid');
    expect(md).toContain('| pattern | 1 |');
    expect(md).toContain('### First issues');
    expect(md).toMatch(/\.\.\. and \d+ more/);
    expect(validationToMarkdown(validate(claims, good, { now }))).toContain('## claims: valid');
    const doc = contractToMarkdown({ ...claims, description: 'Daily claims feed' });
    expect(doc).toContain('Grain: claim_id');
    expect(doc).toContain('Freshness: reported_at within 2d');
    expect(doc).toContain('| amount | number | yes | min 0; max 1000000 |');
    expect(doc).toContain('one of open, closed, denied');
    expect(doc).toContain('custom check');
  });
});
