import { createBaseline, isBaseline, subsample, summarizeColumn } from './baseline';
import { detectDrift } from './drift';
import type { Row } from './types';

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function window(seed: number, size: number, shift = 0): Row[] {
  const random = rng(seed);
  const rows: Row[] = [];
  for (let i = 0; i < size; i += 1) {
    const r = random();
    rows.push({
      id: `${seed}-${i}`,
      amount: Math.round(random() * 1000) + shift,
      region: r < 0.5 ? 'north' : r < 0.8 ? 'south' : 'west',
      day: new Date(Date.UTC(2024, 0, 1 + Math.floor(random() * 30))).toISOString(),
      note: random() < 0.02 ? 'x' : null,
    });
  }
  return rows;
}

describe('createBaseline', () => {
  it('summarises every column and survives a JSON round trip', () => {
    const reference = window(1, 800);
    const baseline = createBaseline(reference, { bins: 5 });
    expect(baseline.version).toBe(1);
    expect(baseline.rows).toBe(800);
    expect(Date.parse(baseline.createdAt)).toBeGreaterThan(0);
    expect(baseline.columns.amount).toMatchObject({ kind: 'numeric', type: 'integer', count: 800, missing: 0, isDate: false });
    expect(baseline.columns.amount!.edges).toHaveLength(4);
    expect(baseline.columns.amount!.counts).toHaveLength(5);
    expect(baseline.columns.amount!.sample).toHaveLength(800);
    expect(baseline.columns.day).toMatchObject({ kind: 'numeric', isDate: true });
    expect(baseline.columns.region).toMatchObject({ kind: 'categorical', other: 0 });
    expect(baseline.columns.region!.categories!.map((c) => c.value)).toEqual(['north', 'south', 'west']);
    expect(baseline.columns.id!.kind).toBe('skipped');
    expect(baseline.columns.id!.reason).toMatch(/high cardinality/);
    expect(baseline.columns.note!.reason).toMatch(/only \d+ reference values/);

    const restored: unknown = JSON.parse(JSON.stringify(baseline));
    expect(isBaseline(restored)).toBe(true);
    expect(restored).toEqual(baseline);
    expect(isBaseline(null)).toBe(false);
    expect(isBaseline([])).toBe(false);
    expect(isBaseline({ version: 2, rows: 1, columns: {} })).toBe(false);
  });

  it('gives the same drift verdicts as comparing the rows directly', () => {
    const reference = window(1, 800);
    const current = window(2, 600, 250);
    const fromRows = detectDrift(reference, current, { bins: 5 });
    const fromBaseline = detectDrift(JSON.parse(JSON.stringify(createBaseline(reference, { bins: 5 }))), current, { bins: 5 });
    expect(fromBaseline.reference.rows).toBe(800);
    expect(fromBaseline.drifted).toEqual(fromRows.drifted);
    expect(fromBaseline.skipped).toEqual(fromRows.skipped);
    for (const name of ['amount', 'region', 'day']) {
      const a = fromRows.columns[name]!;
      const b = fromBaseline.columns[name]!;
      expect(b.kind).toBe(a.kind);
      expect(b.psi).toBeCloseTo(a.psi, 12);
      expect(b.jsDivergence).toBeCloseTo(a.jsDivergence, 12);
      expect(b.bins).toEqual(a.bins);
      expect(b.reference).toEqual(a.reference);
      if (a.ks) expect(b.ks).toEqual(a.ks);
      if (a.chiSquare) expect(b.chiSquare).toEqual(a.chiSquare);
      if (a.referenceStats) expect(b.referenceStats).toEqual(a.referenceStats);
    }
    expect(fromBaseline.columns.amount!.drifted).toBe(true);
  });

  it('keeps a bounded value sample and still runs the KS test', () => {
    const reference = window(3, 5000);
    const baseline = createBaseline(reference, { sampleSize: 200 });
    expect(baseline.columns.amount!.sample).toHaveLength(200);
    const sample = baseline.columns.amount!.sample!;
    expect(sample[0]).toBe(baseline.columns.amount!.stats!.min);
    expect(sample[199]).toBe(baseline.columns.amount!.stats!.max);
    const same = detectDrift(baseline, window(4, 1000));
    expect(same.columns.amount!.ks!.pValue).toBeGreaterThan(0.05);
    const shifted = detectDrift(baseline, window(4, 1000, 300));
    expect(shifted.columns.amount!.ks!.pValue).toBeLessThan(0.001);
    expect(subsample([1, 2, 3, 4, 5], 3)).toEqual([1, 3, 5]);
    expect(subsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(subsample([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it('reports columns the baseline or the current window lacks', () => {
    const baseline = createBaseline(window(1, 200), { columns: ['amount', 'region'] });
    const report = detectDrift(baseline, window(2, 200).map(({ region, ...rest }) => rest), { columns: ['amount', 'region', 'day'] });
    expect(report.columns.amount!.kind).toBe('numeric');
    expect(report.columns.region!.reason).toBe('missing in the current window');
    expect(report.columns.day!.reason).toBe('not in the baseline');
    expect(report.skipped).toEqual(['region', 'day']);
    expect(summarizeColumn('x', [1, 2], {}).reason).toMatch(/only 2 reference values/);
    expect(summarizeColumn('x', Array(30).fill('a'), { numeric: ['x'] }).reason).toBe('too few numeric values');
    expect(summarizeColumn('x', Array(30).fill(5), { binning: 'width', bins: 4 }).edges).toEqual([]);
  });
});
