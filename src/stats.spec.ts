import { chiSquareSurvival, chiSquareTest, gammaP, gammaQ, jensenShannon, kolmogorovSurvival, ksTest, logGamma, psi, quantile, quantileEdges, binCounts, binIndex, toShares, widthEdges, standardDeviation, mean } from './stats';

/** Deterministic pseudo-random numbers. */
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

describe('quantiles and bins', () => {
  it('interpolates like R type 7', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(quantile(sorted, 0)).toBe(1);
    expect(quantile(sorted, 0.5)).toBe(3);
    expect(quantile(sorted, 0.25)).toBe(2);
    expect(quantile(sorted, 0.9)).toBeCloseTo(4.6);
    expect(quantile(sorted, 1)).toBe(5);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it('builds deduplicated quantile edges and equal-width edges', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i);
    expect(quantileEdges(sorted, 4)).toEqual([24.75, 49.5, 74.25]);
    expect(quantileEdges([5, 5, 5, 5, 9], 4)).toEqual([5]);
    expect(widthEdges(0, 10, 5)).toEqual([2, 4, 6, 8]);
    expect(widthEdges(3, 3, 5)).toEqual([]);
  });

  it('assigns values to bins and counts them', () => {
    const edges = [10, 20, 30];
    expect([5, 10, 15, 20, 25, 30, 35].map((v) => binIndex(v, edges))).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect(binCounts([5, 15, 15, 35], edges)).toEqual([1, 2, 0, 1]);
    expect(toShares([1, 3])).toEqual([0.25, 0.75]);
    expect(toShares([0, 0])).toEqual([0, 0]);
  });

  it('computes mean and sample standard deviation', () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(standardDeviation([3])).toBe(0);
    expect(standardDeviation([])).toBeNaN();
  });
});

describe('divergences', () => {
  it('psi is zero for identical shares, grows with shift, and tolerates empty bins', () => {
    expect(psi([0.5, 0.5], [0.5, 0.5])).toBe(0);
    expect(psi([0.5, 0.5], [0.7, 0.3])).toBeCloseTo(0.2 * Math.log(1.4) + -0.2 * Math.log(0.6), 10);
    expect(psi([0.5, 0.5], [1, 0])).toBeGreaterThan(4);
    expect(Number.isFinite(psi([0.5, 0.5], [1, 0]))).toBe(true);
    expect(() => psi([1], [0.5, 0.5])).toThrow();
  });

  it('jensen-shannon is 0 for identical and 1 for disjoint distributions', () => {
    expect(jensenShannon([0.5, 0.5], [0.5, 0.5])).toBe(0);
    expect(jensenShannon([1, 0], [0, 1])).toBeCloseTo(1, 10);
    expect(jensenShannon([0.9, 0.1], [0.1, 0.9])).toBeGreaterThan(0.3);
    expect(() => jensenShannon([1], [0.5, 0.5])).toThrow();
  });
});

describe('kolmogorov-smirnov', () => {
  it('finds no difference between samples of one distribution and a clear one after a shift', () => {
    const random = rng(1);
    const a = Array.from({ length: 500 }, () => normal(random, 0, 1)).sort((x, y) => x - y);
    const b = Array.from({ length: 400 }, () => normal(random, 0, 1)).sort((x, y) => x - y);
    const c = Array.from({ length: 400 }, () => normal(random, 0.6, 1)).sort((x, y) => x - y);
    const same = ksTest(a, b);
    expect(same.statistic).toBeLessThan(0.1);
    expect(same.pValue).toBeGreaterThan(0.05);
    const shifted = ksTest(a, c);
    expect(shifted.statistic).toBeGreaterThan(0.2);
    expect(shifted.pValue).toBeLessThan(0.001);
    expect(ksTest([1, 2, 3], [1, 2, 3])).toMatchObject({ statistic: 0, pValue: 1 });
    expect(ksTest([], [1]).pValue).toBeNaN();
  });

  it('matches the Kolmogorov distribution at known points', () => {
    // P(K > 1.36) ≈ 0.049, P(K > 1.63) ≈ 0.010, P(K > 0.5) ≈ 0.964 (standard tables).
    expect(kolmogorovSurvival(1.36)).toBeCloseTo(0.049, 2);
    expect(kolmogorovSurvival(1.63)).toBeCloseTo(0.01, 2);
    expect(kolmogorovSurvival(0.5)).toBeCloseTo(0.964, 2);
    expect(kolmogorovSurvival(0)).toBe(1);
  });
});

describe('gamma and chi-square', () => {
  it('logGamma matches factorials and the half-integer value', () => {
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 8);
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 8);
  });

  it('regularized incomplete gamma functions are complementary and match known values', () => {
    expect(gammaP(2, 1) + gammaQ(2, 1)).toBeCloseTo(1, 12);
    expect(gammaP(1, 1)).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(gammaQ(3, 10)).toBeCloseTo(0.00277, 4);
    expect(gammaP(2, 0)).toBe(0);
    expect(gammaQ(2, 0)).toBe(1);
    expect(gammaP(-1, 1)).toBeNaN();
  });

  it('chi-square survival matches the critical values of the 5% table', () => {
    expect(chiSquareSurvival(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquareSurvival(5.991, 2)).toBeCloseTo(0.05, 3);
    expect(chiSquareSurvival(18.307, 10)).toBeCloseTo(0.05, 3);
    expect(chiSquareSurvival(0, 3)).toBe(1);
    expect(chiSquareSurvival(1, 0)).toBeNaN();
  });

  it('tests homogeneity of two count vectors', () => {
    const same = chiSquareTest([50, 30, 20], [52, 29, 19]);
    expect(same.df).toBe(2);
    expect(same.pValue).toBeGreaterThan(0.5);
    const different = chiSquareTest([50, 30, 20], [20, 30, 50]);
    expect(different.pValue).toBeLessThan(0.001);
    // Empty categories are dropped; degenerate tables give p = 1.
    expect(chiSquareTest([10, 0, 10], [10, 0, 10]).df).toBe(1);
    expect(chiSquareTest([10], [10])).toMatchObject({ pValue: 1, df: 0 });
    expect(chiSquareTest([10, 10], [0, 0])).toMatchObject({ pValue: 1 });
    expect(() => chiSquareTest([1], [1, 2])).toThrow();
  });
});
