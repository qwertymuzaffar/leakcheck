/** Linear-interpolation quantile (type 7) of an ascending array. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n - 1); 0 for a single value. */
export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return values.length === 1 ? 0 : NaN;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) * (v - m);
  return Math.sqrt(sum / (values.length - 1));
}

/**
 * Inner bin edges from the quantiles of `values` (ascending), deduplicated so constant regions
 * collapse. With `bins` requested you get at most `bins - 1` edges; outer bins are open-ended.
 */
export function quantileEdges(sorted: readonly number[], bins: number): number[] {
  const edges: number[] = [];
  for (let i = 1; i < bins; i += 1) {
    const edge = quantile(sorted, i / bins);
    if (edges.length === 0 || edge > edges[edges.length - 1]!) edges.push(edge);
  }
  return edges;
}

/** Inner bin edges of equal width between the minimum and maximum of `values`. */
export function widthEdges(min: number, max: number, bins: number): number[] {
  if (!(max > min) || bins < 2) return [];
  const edges: number[] = [];
  for (let i = 1; i < bins; i += 1) edges.push(min + ((max - min) * i) / bins);
  return edges;
}

/** Index of the bin for `value` given ascending inner edges: values above the last edge go to the last bin. */
export function binIndex(value: number, edges: readonly number[]): number {
  let low = 0;
  let high = edges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (value <= edges[mid]!) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** Counts of `values` per bin for the given inner edges (`edges.length + 1` bins). */
export function binCounts(values: readonly number[], edges: readonly number[]): number[] {
  const counts = new Array<number>(edges.length + 1).fill(0);
  for (const v of values) counts[binIndex(v, edges)]! += 1;
  return counts;
}

/** Shares that sum to one; an empty or all-zero input gives zeros. */
export function toShares(counts: readonly number[]): number[] {
  let total = 0;
  for (const c of counts) total += c;
  return counts.map((c) => (total > 0 ? c / total : 0));
}

/**
 * Population Stability Index between two share vectors over the same bins. Shares of zero are
 * floored at `epsilon` so a bin that empties out still counts, without an infinite result.
 * Rules of thumb: below 0.1 stable, 0.1 to 0.25 moderate shift, above 0.25 major shift.
 */
export function psi(reference: readonly number[], current: readonly number[], epsilon = 1e-4): number {
  if (reference.length !== current.length) throw new Error('psi needs share vectors of the same length');
  let total = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const r = Math.max(reference[i]!, epsilon);
    const c = Math.max(current[i]!, epsilon);
    total += (c - r) * Math.log(c / r);
  }
  return total;
}

/** Jensen-Shannon divergence in bits between two share vectors: 0 for identical, 1 for disjoint. */
export function jensenShannon(p: readonly number[], q: readonly number[]): number {
  if (p.length !== q.length) throw new Error('jensenShannon needs share vectors of the same length');
  let total = 0;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i]!;
    const b = q[i]!;
    const m = (a + b) / 2;
    if (a > 0) total += 0.5 * a * Math.log2(a / m);
    if (b > 0) total += 0.5 * b * Math.log2(b / m);
  }
  return Math.max(0, total);
}

/**
 * Two-sample Kolmogorov-Smirnov test on ascending samples. The p-value uses the asymptotic
 * Kolmogorov distribution with the Stephens small-sample correction, which is accurate to a few
 * percent for samples of a few dozen or more.
 */
export function ksTest(a: readonly number[], b: readonly number[]): { statistic: number; pValue: number } {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return { statistic: NaN, pValue: NaN };
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < n && j < m) {
    const x = a[i]!;
    const y = b[j]!;
    const t = Math.min(x, y);
    while (i < n && a[i]! <= t) i += 1;
    while (j < m && b[j]! <= t) j += 1;
    d = Math.max(d, Math.abs(i / n - j / m));
  }
  const en = Math.sqrt((n * m) / (n + m));
  const lambda = (en + 0.12 + 0.11 / en) * d;
  return { statistic: d, pValue: kolmogorovSurvival(lambda) };
}

/** P(K > lambda) for the Kolmogorov distribution, by the alternating series. */
export function kolmogorovSurvival(lambda: number): number {
  if (lambda <= 0) return 1;
  let sum = 0;
  let term = 2;
  for (let k = 1; k <= 100; k += 1) {
    const value = term * Math.exp(-2 * k * k * lambda * lambda);
    sum += value;
    if (Math.abs(value) <= 1e-12 * sum) break;
    term = -term;
  }
  return Math.min(1, Math.max(0, sum));
}

/** Natural log of the gamma function (Lanczos approximation). */
export function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const c of coefficients) {
    y += 1;
    series += c / y;
  }
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    // Series representation.
    let term = 1 / a;
    let sum = term;
    let ap = a;
    for (let n = 0; n < 500; n += 1) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  return 1 - gammaQContinuedFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaP(a, x);
  return gammaQContinuedFraction(a, x);
}

function gammaQContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** P(X > x) for a chi-square variable with `df` degrees of freedom. */
export function chiSquareSurvival(x: number, df: number): number {
  if (df <= 0) return NaN;
  if (x <= 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, x / 2)));
}

/**
 * Chi-square test of homogeneity between two count vectors over the same categories (a 2 x k
 * table). Categories empty in both samples are dropped; the result has `k - 1` degrees of freedom.
 */
export function chiSquareTest(
  reference: readonly number[],
  current: readonly number[],
): { statistic: number; pValue: number; df: number } {
  if (reference.length !== current.length) throw new Error('chiSquareTest needs count vectors of the same length');
  let refTotal = 0;
  let curTotal = 0;
  const columns: number[] = [];
  for (let i = 0; i < reference.length; i += 1) {
    const total = reference[i]! + current[i]!;
    if (total > 0) {
      columns.push(i);
      refTotal += reference[i]!;
      curTotal += current[i]!;
    }
  }
  const grand = refTotal + curTotal;
  const df = columns.length - 1;
  if (df < 1 || refTotal === 0 || curTotal === 0) return { statistic: 0, pValue: 1, df: Math.max(0, df) };
  let statistic = 0;
  for (const i of columns) {
    const columnTotal = reference[i]! + current[i]!;
    const expectedRef = (refTotal * columnTotal) / grand;
    const expectedCur = (curTotal * columnTotal) / grand;
    statistic += (reference[i]! - expectedRef) ** 2 / expectedRef + (current[i]! - expectedCur) ** 2 / expectedCur;
  }
  return { statistic, pValue: chiSquareSurvival(statistic, df), df };
}
