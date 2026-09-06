import { detectDrift, driftColumn } from './drift';
import { profile } from './profile';
import { driftToMarkdown, profileToMarkdown } from './report';
import type { Row } from './types';

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normal(random: () => number, mu: number, sigma: number): number {
  const u = 1 - random();
  const v = random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function window(seed: number, size: number, shift = 0, regionWeights = [0.5, 0.3, 0.2], missingRate = 0): Row[] {
  const random = rng(seed);
  const regions = ['north', 'south', 'west'];
  const rows: Row[] = [];
  for (let i = 0; i < size; i += 1) {
    const r = random();
    const region = r < regionWeights[0]! ? regions[0]! : r < regionWeights[0]! + regionWeights[1]! ? regions[1]! : regions[2]!;
    rows.push({
      id: `${seed}-${i}`,
      amount: random() < missingRate ? null : Math.max(0, normal(random, 1000 + shift, 300)),
      age: 18 + Math.floor(random() * 60),
      region,
      day: new Date(Date.UTC(2024, 0, 1 + Math.floor(random() * 30))).toISOString(),
      flag: random() < 0.1,
    });
  }
  return rows;
}

describe('detectDrift', () => {
  it('sees no drift between two windows of the same distribution', () => {
    const report = detectDrift(window(1, 800), window(2, 600));
    expect(report.ok).toBe(true);
    expect(report.drifted).toEqual([]);
    expect(report.columns.amount).toMatchObject({ kind: 'numeric', drifted: false });
    expect(report.columns.amount!.psi).toBeLessThan(0.1);
    expect(report.columns.amount!.ks!.pValue).toBeGreaterThan(0.05);
    expect(report.columns.amount!.bins).toHaveLength(10);
    expect(report.columns.amount!.bins[0]!.label).toMatch(/^<= /);
    expect(report.columns.amount!.bins[9]!.label).toMatch(/^> /);
    expect(report.columns.region).toMatchObject({ kind: 'categorical', drifted: false });
    expect(report.columns.region!.chiSquare!.df).toBe(2);
    expect(report.columns.day).toMatchObject({ kind: 'numeric' });
    expect(report.columns.flag).toMatchObject({ kind: 'categorical' });
    expect(report.columns.id!.kind).toBe('skipped');
    expect(report.columns.id!.reason).toMatch(/high cardinality/);
    expect(report.skipped).toEqual(['id']);
    expect(report.thresholds).toEqual({ psi: 0.2, pValue: 0.05, missingRate: 0.1 });
  });

  it('flags a shifted numeric column, a changed category mix and a jump in missing values', () => {
    const report = detectDrift(window(1, 800), window(3, 600, 400, [0.2, 0.3, 0.5], 0.3));
    expect(report.ok).toBe(false);
    expect(report.drifted).toEqual(expect.arrayContaining(['amount', 'region']));
    const amount = report.columns.amount!;
    expect(amount.psi).toBeGreaterThan(0.2);
    expect(amount.ks!.pValue).toBeLessThan(0.001);
    expect(amount.signals.join(' ')).toMatch(/psi .* > 0.2/);
    expect(amount.signals.join(' ')).toMatch(/ks p=/);
    expect(amount.signals.join(' ')).toMatch(/missing rate 0 -> 0\.\d+/);
    expect(amount.missingRateDelta).toBeGreaterThan(0.2);
    expect(amount.currentStats!.mean).toBeGreaterThan(amount.referenceStats!.mean + 300);
    const region = report.columns.region!;
    expect(region.chiSquare!.pValue).toBeLessThan(0.001);
    expect(region.bins.map((b) => b.label)).toEqual(['north', 'south', 'west']);
    expect(region.bins[2]!.current).toBeGreaterThan(region.bins[2]!.reference);
    expect(report.columns.age!.drifted).toBe(false);
  });

  it('skips thin columns and columns missing from the current window, and honours forced kinds', () => {
    const reference = window(1, 100);
    const current = window(2, 100).map(({ day, ...rest }) => rest);
    const report = detectDrift(reference, current, { columns: ['day', 'age', 'flag', 'region'], minSamples: 50, categorical: ['age'], numeric: ['flag'], maxCategories: 100 });
    expect(report.skipped).toEqual(['day']);
    expect(report.columns.day!.reason).toBe('missing in the current window');
    expect(report.columns.age!.kind).toBe('categorical');
    expect(report.columns.flag!.kind).toBe('numeric');
    expect(report.columns.flag!.bins.length).toBeGreaterThan(0);
    expect(driftColumn('x', [1, 2, 3], [1, 2, 3]).reason).toMatch(/only 3 reference values/);
    expect(driftColumn('x', Array(30).fill(1), [1, 2]).reason).toMatch(/only 2 current values/);
    expect(driftColumn('x', Array(30).fill('a'), Array(30).fill('a'), { numeric: ['x'] }).reason).toBe('too few numeric values');
  });

  it('supports equal-width bins, custom thresholds and category caps', () => {
    const reference = window(1, 500);
    const current = window(2, 500, 120);
    const width = detectDrift(reference, current, { binning: 'width', bins: 5, columns: ['amount'], thresholds: { psi: 0.01, pValue: 0.5 } });
    expect(width.columns.amount!.bins).toHaveLength(5);
    expect(width.drifted).toEqual(['amount']);
    const ids = detectDrift(reference, current, { columns: ['id'], maxCategories: 5, maxDistinctShare: 1.5 });
    const bins = ids.columns.id!.bins;
    expect(bins).toHaveLength(6);
    expect(bins[5]!.label).toBe('other');
    expect(bins[5]!.current).toBe(1);
    expect(detectDrift(reference, current, { columns: ['id'] }).columns.id!.reason).toMatch(/high cardinality/);
  });

  it('renders drift reports and profiles as markdown', () => {
    const report = detectDrift(window(1, 400), window(3, 400, 400, [0.2, 0.3, 0.5]));
    const md = driftToMarkdown(report);
    expect(md).toMatch(/^## Drift: \d+ columns drifted/);
    expect(md).toContain('| amount | numeric |');
    expect(md).toContain('### amount');
    expect(md).toContain('| mean |');
    expect(md).toContain('### region');
    expect(driftToMarkdown(report, { bins: false })).not.toContain('### amount');
    expect(driftToMarkdown(detectDrift(window(1, 1000), window(2, 1000)))).toContain('## Drift: stable');
    const thin = driftToMarkdown(detectDrift(window(1, 10), window(2, 10)));
    expect(thin).toContain('skipped: only 10 reference values');

    const prof = profileToMarkdown(profile(window(1, 50)));
    expect(prof).toContain('## Profile: 50 rows, 6 columns');
    expect(prof).toContain('| amount | number |');
    expect(prof).toContain('| day | date |');
    expect(prof).toMatch(/north \(\d+\)/);
  });
});

describe('profile', () => {
  it('describes each column by type', () => {
    const rows = window(5, 200);
    const prof = profile(rows, { bins: 4, topCategories: 2 });
    expect(prof.rows).toBe(200);
    expect(prof.columns.amount).toMatchObject({ type: 'number', missing: 0, count: 200 });
    expect(prof.columns.amount!.histogram!.counts).toHaveLength(4);
    expect(prof.columns.amount!.histogram!.edges).toHaveLength(5);
    expect(prof.columns.amount!.numeric!.quantiles.p50).toBeGreaterThan(800);
    expect(prof.columns.age!.type).toBe('integer');
    expect(prof.columns.day!.type).toBe('date');
    expect(prof.columns.day!.numeric!.min).toBe(Date.UTC(2024, 0, 1));
    expect(prof.columns.region!.categories).toHaveLength(2);
    expect(prof.columns.region!.distinct).toBe(3);
    expect(prof.columns.flag!.type).toBe('boolean');
    expect(profile(rows, { columns: ['id'] }).columns.id!.distinct).toBe(200);
    expect(profile([]).rows).toBe(0);
    expect(profile([{ a: null }]).columns.a).toMatchObject({ type: 'any', count: 0, missing: 1, distinct: 0 });
  });
});
