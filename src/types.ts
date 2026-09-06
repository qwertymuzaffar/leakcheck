/** One record of a dataset: a plain object keyed by column name. */
export type Row = Record<string, unknown>;

/** Column types a contract can require. `any` accepts every non-missing value. */
export type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'any';

export interface NumericStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  /** Sample standard deviation (n - 1). */
  std: number;
  quantiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
}

export interface CategoryCount {
  value: string;
  count: number;
}

export interface Histogram {
  /** Bin edges, `bins + 1` values; the first and last are the observed minimum and maximum. */
  edges: number[];
  counts: number[];
}

export interface ColumnProfile {
  name: string;
  /** Type inferred from the non-missing values. */
  type: ColumnType;
  count: number;
  missing: number;
  distinct: number;
  numeric?: NumericStats;
  histogram?: Histogram;
  /** Most frequent values, largest first. Present for non-numeric columns. */
  categories?: CategoryCount[];
}

export interface DatasetProfile {
  rows: number;
  columns: Record<string, ColumnProfile>;
}
