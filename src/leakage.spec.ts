import { contingencyChiSquare, cramersV, detectLeakage, detectOverlap, etaSquared, pearson } from './leakage';
import { leakageToMarkdown, overlapToMarkdown } from './report';
import type { Row } from './types';

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Insurance-like claims: the label is whether the claim was paid; some columns leak it. */
function claims(seed: number, count: number): Row[] {
  const random = rng(seed);
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const amount = Math.round(random() * 10_000);
    const region = ['north', 'south', 'east', 'west'][Math.floor(random() * 4)]!;
    const paid = random() < 0.6;
    const reported = Date.UTC(2024, 0, 1 + Math.floor(random() * 300));
    rows.push({
      claim_id: `CLM-${seed}-${i}`,
      customer_id: `C${Math.floor(random() * 5000)}`,
      amount,
      region,
      age: 18 + Math.floor(random() * 60),
      paid,
      // Leaks: a renamed copy, a numeric proxy, a category proxy, and a post-outcome timestamp.
      paid_flag: paid ? 'yes' : 'no',
      payout: paid ? amount * (0.8 + random() * 0.2) : 0,
      settlement_code: paid ? (random() < 0.5 ? 'PAID-FULL' : 'PAID-PART') : 'REJECTED',
      reported_at: new Date(reported).toISOString(),
      settled_at: new Date(reported + 3 * 86_400_000).toISOString(),
      last_note_at: new Date(reported + (random() < 0.3 ? 5 : 1) * 86_400_000).toISOString(),
      first_note_at: new Date(reported + 86_400_000).toISOString(),
    });
  }
  return rows;
}

describe('association measures', () => {
  it('pearson', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(Math.abs(pearson([1, 2, 3, 4, 5, 6], [2, 1, 4, 3, 6, 5]))).toBeLessThan(0.95);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(pearson([1], [1])).toBeNaN();
    expect(() => pearson([1, 2], [1])).toThrow();
  });

  it('eta squared', () => {
    expect(etaSquared([1, 1, 5, 5], ['a', 'a', 'b', 'b'])).toBeCloseTo(1, 12);
    expect(etaSquared([1, 5, 1, 5], ['a', 'a', 'b', 'b'])).toBe(0);
    expect(etaSquared([2, 2, 2], ['a', 'b', 'c'])).toBeNaN();
    expect(etaSquared([1], ['a'])).toBeNaN();
    expect(() => etaSquared([1, 2], ['a'])).toThrow();
  });

  it('contingency chi-square and Cramer V', () => {
    const independent = contingencyChiSquare([
      [20, 20],
      [20, 20],
    ]);
    expect(independent).toMatchObject({ statistic: 0, pValue: 1, df: 1, n: 80 });
    const dependent = contingencyChiSquare([
      [40, 0],
      [0, 40],
    ]);
    expect(dependent.statistic).toBeCloseTo(80, 8);
    expect(dependent.pValue).toBeLessThan(1e-10);
    expect(contingencyChiSquare([[5, 5]]).df).toBe(0);
    expect(contingencyChiSquare([]).n).toBe(0);
    expect(
      contingencyChiSquare([
        [10, 0, 5],
        [0, 0, 5],
      ]).df,
    ).toBe(1);

    expect(cramersV(['a', 'a', 'b', 'b'], ['x', 'x', 'y', 'y'], false)).toBeCloseTo(1, 12);
    expect(cramersV(['a', 'b', 'a', 'b'], ['x', 'x', 'y', 'y'], false)).toBeCloseTo(0, 12);
    // 80 categories in 200 rows against labels drawn independently: the classic value is inflated by sparsity.
    const random = rng(9);
    const many = Array.from({ length: 200 }, (_, i) => `k${i % 80}`);
    const labels = Array.from({ length: 200 }, () => (random() < 0.5 ? 'y' : 'n'));
    expect(cramersV(many, labels, false)).toBeGreaterThan(0.4);
    expect(cramersV(many, labels)).toBeLessThan(0.3);
    // The same categories determining the label: high even after the correction, though below 1 with so many categories.
    const byKey = many.map((k) => (Number(k.slice(1)) % 2 ? 'y' : 'n'));
    expect(cramersV(many, byKey, false)).toBeCloseTo(1, 8);
    expect(cramersV(many, byKey)).toBeGreaterThan(0.7);
    expect(cramersV(['a', 'a'], ['x', 'y'])).toBeNaN();
    expect(cramersV([], [])).toBeNaN();
    expect(() => cramersV(['a'], [])).toThrow();
  });
});

describe('detectLeakage', () => {
  it('flags copies, proxies, identifiers and future-dated features, and clears honest features', () => {
    const rows = claims(1, 600);
    const report = detectLeakage(rows, {
      label: 'paid',
      exclude: ['claim_id'],
      labelTime: 'settled_at',
      featureTimes: ['last_note_at', 'first_note_at'],
    });
    expect(report.ok).toBe(false);
    expect(report.labelKind).toBe('categorical');
    expect(report.flagged.sort()).toEqual(['customer_id', 'last_note_at', 'paid_flag', 'payout', 'settlement_code'].sort());

    const flag = report.features.paid_flag!;
    expect(flag.kind).toBe('categorical');
    expect(flag.measure).toBe('cramers-v');
    expect(flag.association).toBeCloseTo(1, 6);
    expect(flag.signals.join(' ')).toContain('cramers-v 1 >= 0.95');

    const payout = report.features.payout!;
    expect(payout.kind).toBe('numeric');
    expect(payout.measure).toBe('binned-cramers-v');
    expect(payout.association).toBeGreaterThan(0.95);
    // Eta squared alone would miss it: paid amounts vary widely, so the group means explain little.
    expect(etaSquared(rows.map((r) => r.payout as number), rows.map((r) => String(r.paid)))).toBeLessThan(0.8);

    expect(report.features.settlement_code!.association).toBeGreaterThan(0.99);
    expect(report.features.customer_id!.identifier).toBe(true);
    expect(report.features.customer_id!.signals[0]).toMatch(/looks like an identifier/);
    expect(report.features.customer_id!.association).toBeUndefined();

    const note = report.features.last_note_at!;
    expect(note.futureShare).toBeGreaterThan(0.2);
    expect(note.signals[0]).toMatch(/observed after "settled_at"/);
    expect(report.features.first_note_at).toMatchObject({ futureShare: 0, flagged: false });

    for (const honest of ['amount', 'region', 'age', 'reported_at']) {
      expect(report.features[honest]!.flagged).toBe(false);
      expect(report.features[honest]!.association).toBeLessThan(0.5);
    }
    expect(['eta-squared', 'binned-cramers-v']).toContain(report.features.amount!.measure);
    expect(report.features.region!.measure).toBe('cramers-v');
    expect(report.features.reported_at!.kind).toBe('numeric');
    expect(report.features.paid).toBeUndefined();
    expect(report.features.settled_at).toBeUndefined();
    expect(report.features.claim_id).toBeUndefined();
  });

  it('uses Pearson for numeric labels and reports exact label copies', () => {
    const rows = claims(2, 300).map((row) => ({ ...row, amount_copy: row.amount, amount_text: String(row.amount) }));
    const report = detectLeakage(rows, { label: 'amount', features: ['amount_copy', 'amount_text', 'payout', 'age', 'region', 'paid'] });
    expect(report.labelKind).toBe('numeric');
    expect(report.features.amount_copy).toMatchObject({ measure: 'pearson', labelCopyShare: 1, flagged: true });
    expect(report.features.amount_copy!.association).toBeCloseTo(1, 10);
    expect(report.features.amount_copy!.signals).toHaveLength(2);
    expect(report.features.amount_text!.labelCopyShare).toBe(1);
    expect(report.features.age!.measure).toBe('pearson');
    expect(report.features.age!.flagged).toBe(false);
    expect(report.features.region!.measure).toBe('eta-squared');
    expect(report.features.paid!.kind).toBe('categorical');
  });

  it('skips thin columns, honours thresholds, and treats low-cardinality numbers as categories', () => {
    const rows = claims(3, 100).map((row, i) => ({ ...row, sparse: i < 5 ? 1 : null, tier: (i % 3) + 1 }));
    const report = detectLeakage(rows, { label: 'paid', thresholds: { association: 0.5, labelCopy: 0.5, future: 0.5 }, labelTime: 'settled_at', featureTimes: ['last_note_at'], minSamples: 30 });
    expect(report.skipped).toEqual(['sparse']);
    expect(report.features.sparse!.reason).toMatch(/only 5 rows/);
    expect(report.features.tier!.kind).toBe('categorical');
    expect(report.features.tier!.measure).toBe('cramers-v');
    expect(report.features.last_note_at!.flagged).toBe(false);
    expect(report.features.payout!.flagged).toBe(true);
    expect(report.thresholds).toEqual({ association: 0.5, labelCopy: 0.5, future: 0.5 });

    const thin = detectLeakage(rows.slice(0, 10), { label: 'paid', labelTime: 'settled_at', featureTimes: ['last_note_at'] });
    expect(thin.skipped).toContain('last_note_at');
    expect(thin.features.last_note_at!.reason).toMatch(/only 10 rows/);
    expect(thin.ok).toBe(true);
  });

  it('renders markdown', () => {
    const rows = claims(4, 200);
    const md = leakageToMarkdown(detectLeakage(rows, { label: 'paid', exclude: ['claim_id', 'customer_id'], labelTime: 'settled_at', featureTimes: ['last_note_at'] }));
    expect(md).toMatch(/^## Leakage: \d+ features flagged/);
    expect(md).toContain('| paid_flag | categorical | cramers-v 1 | 0.0% |');
    expect(md).toContain('| last_note_at | numeric |');
    expect(md).toMatch(/\| amount \| numeric \| (eta-squared|binned-cramers-v) [\d.]+ \| 0\.0% \|  \| ok \|/);
    expect(leakageToMarkdown(detectLeakage(rows, { label: 'paid', features: ['age', 'region'] }))).toContain('## Leakage: none found');
  });
});

describe('detectOverlap', () => {
  it('finds shared entities and duplicated rows across a split', () => {
    const train = claims(5, 300);
    const clean = claims(6, 100).map((row) => ({ ...row, customer_id: `X${row.customer_id}` }));
    expect(detectOverlap(train, clean, { keys: ['customer_id'] })).toMatchObject({ ok: true, keyOverlap: { count: 0, share: 0, keys: [] }, duplicateRows: { count: 0 } });

    const test = [...claims(6, 100), ...train.slice(0, 10)];
    const report = detectOverlap(train, test, { keys: ['customer_id'], examples: 3 });
    expect(report.ok).toBe(false);
    expect(report.duplicateRows).toEqual({ count: 10, share: 10 / 110 });
    expect(report.keyOverlap!.count).toBeGreaterThanOrEqual(10);
    expect(report.keyOverlap!.keys).toHaveLength(3);

    const partial = detectOverlap(train, test, { columns: ['amount', 'region'] });
    expect(partial.keyOverlap).toBeUndefined();
    expect(partial.duplicateRows.count).toBeGreaterThanOrEqual(10);
    expect(detectOverlap([], [], { keys: ['a'] })).toMatchObject({ ok: true, duplicateRows: { count: 0, share: 0 } });
    expect(detectOverlap([{ a: null }], [{ a: null }], { keys: ['a'] }).keyOverlap!.count).toBe(0);

    const md = overlapToMarkdown(report);
    expect(md).toContain('## Train/test overlap: found');
    expect(md).toContain('Duplicate rows in test: 10 (9.1%)');
    expect(md).toMatch(/First keys: C\d+, C\d+, C\d+/);
    expect(overlapToMarkdown(detectOverlap(train, clean))).toContain('none found');
  });
});
