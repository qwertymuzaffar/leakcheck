# leakcheck

[![npm version](https://img.shields.io/npm/v/leakcheck)](https://www.npmjs.com/package/leakcheck)
[![CI](https://github.com/qwertymuzaffar/leakcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertymuzaffar/leakcheck/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Leakage, drift and data contract checks for machine learning datasets, in TypeScript - **zero dependencies**, runs in Node, browsers and edge runtimes, works on plain arrays of records.

Three questions it answers about a dataset:

- **Is the label leaking into the features?** Features that copy the label, that are almost perfectly associated with it (Pearson, eta squared, Cramér's V), identifier-like columns, features observed after the label was known, and train/test splits that share entities or rows.
- **Has the data shifted since the reference window?** PSI and a Kolmogorov-Smirnov test for numeric columns, PSI and a chi-square test for categorical ones, plus changes in missing rates, with per-bin breakdowns.
- **Does a batch honour its contract?** Types, required values, ranges, enums, patterns, lengths, uniqueness, custom rules, the record grain, unexpected and missing columns, minimum row counts and freshness.

Every check returns a plain report object and can be rendered to Markdown for a CI log, a pull request comment or a notebook. A **baseline** saves what the checks need to know about the training window as JSON, so a monitoring job can compare each new batch without the training rows. A **CLI** runs all of it on CSV, TSV, NDJSON and JSON files.

## Install

```bash
npm i leakcheck
```

Or run it without installing:

```bash
npx leakcheck leak claims.csv --label claim_paid --exclude claim_id
npx leakcheck baseline train.csv --out baseline.json
npx leakcheck drift baseline.json this_week.csv --psi 0.1
```

## Quick start

```ts
import { detectLeakage, detectOverlap, detectDrift, defineContract, validate, leakageToMarkdown } from 'leakcheck';

// 1. Leakage: does anything give the label away?
const leakage = detectLeakage(trainingRows, {
  label: 'claim_paid',
  exclude: ['claim_id'],
  labelTime: 'settled_at',           // when the label became known
  featureTimes: ['last_note_at'],    // when these features were observed
});
if (!leakage.ok) console.log(leakageToMarkdown(leakage));

// 2. Split hygiene: do train and test share customers or rows?
const overlap = detectOverlap(trainingRows, testRows, { keys: ['customer_id'] });

// 3. Drift: has this week's batch moved away from the training window?
const drift = detectDrift(trainingRows, thisWeekRows, { thresholds: { psi: 0.1 } });
for (const column of drift.drifted) console.log(column, drift.columns[column].signals);

// 4. Contract: is the batch what the pipeline expects?
const claims = defineContract({
  name: 'claims',
  grain: ['claim_id'],
  freshness: { column: 'reported_at', maxAge: '2d' },
  columns: {
    claim_id: { type: 'string', required: true, pattern: /^CLM-\d+$/ },
    amount: { type: 'number', required: true, min: 0, max: 5_000_000 },
    status: { enum: ['open', 'closed', 'denied'] },
    reported_at: { type: 'date', required: true },
  },
});
const report = validate(claims, thisWeekRows);
if (!report.ok) throw new Error(`${report.issueCounts.type ?? 0} type issues, ${report.duplicateKeys} duplicate keys`);
```

Rows are `Record<string, unknown>[]`: whatever your CSV parser, database driver or feature store hands you. Missing means `null`, `undefined`, `NaN` or a blank string. Numeric strings count as numbers and ISO strings as dates unless you turn coercion off. `parseCsv`, `parseNdjson` and `toCsv` are included for the common case, and `leakcheck/node` adds `readRows(path)` for files.

## Baselines for monitoring

A monitoring job should not carry the training set around. `createBaseline` keeps what drift detection needs per column: the bin edges and counts, the statistics and a bounded value sample for numeric columns, and the kept categories for categorical ones. It is plain JSON.

```ts
import { createBaseline, detectDrift } from 'leakcheck';

// When the model is trained:
const baseline = createBaseline(trainingRows, { bins: 10 });
await fs.writeFile('baseline.json', JSON.stringify(baseline));

// In the scheduled check:
const report = detectDrift(JSON.parse(await fs.readFile('baseline.json', 'utf8')), todaysRows);
```

A report built from a baseline is identical to one built from the rows, except that the KS test uses the stored sample (2,000 evenly spaced reference values by default, `sampleSize` to change it) once the reference is larger than that. Bins, binning and category caps are fixed at baseline time; thresholds are chosen at comparison time.

## Command line

Every command reads `.csv`, `.tsv`, `.ndjson`, `.jsonl` or `.json` (an array of objects), prints Markdown, and exits 1 when the check fails so it can gate a pipeline. `--json` prints the report object instead, `--no-fail` always exits 0.

```bash
leakcheck leak <data> --label <column> [--exclude a,b] [--label-time col --feature-times a,b]
leakcheck overlap <train> <test> [--keys a,b]
leakcheck drift <reference | baseline.json> <current> [--psi 0.2] [--p-value 0.05] [--bins 10]
leakcheck baseline <data> --out baseline.json
leakcheck validate <contract.json> <data> [--now <iso>] [--strict]
leakcheck infer <data> --name <name> [--out contract.json]
leakcheck profile <data>
```

A contract file is the same object you would pass to `defineContract`, with `pattern` as a string; custom `check` functions are only available from code. `leakcheck --help` lists every option.

## Leakage

`detectLeakage(rows, options)` looks at each feature against the label and reports, per feature:

| Check | How | Flags when |
| --- | --- | --- |
| Label copy | Share of rows where the feature's text equals the label's | at least 99% |
| Association | Numeric feature and numeric label: absolute Pearson r. Numeric feature and categorical label: eta squared, and Cramér's V over quantile bins of the feature, whichever is stronger. Categorical feature and numeric label: eta squared. Both categorical: bias-corrected Cramér's V | at least 0.95 |
| Identifier | Categorical feature whose distinct values exceed half the rows | always |
| Future-dated | A `featureTimes` column later than `labelTime` | any row |

Why two measures for a numeric feature? A payout that is zero when a claim was rejected and anything else when it was paid determines the label completely, yet its eta squared can sit near 0.5 because paid amounts vary widely. Binning the feature by its quantiles and asking whether the bins determine the label catches that rule.

Why bias-correct Cramér's V? A table with many sparse cells (a column with hundreds of categories against a binary label) scores high by chance in the classic formula. The Bergsma correction removes that, so a high value means something.

Numeric columns with at most 10 distinct values (`maxCategoricalDistinct`) are treated as categories, which is what tiers, codes and 0/1 flags are. Everything is configurable through `thresholds`, `minSamples`, `features`, `exclude` and `identifierShare`.

`detectOverlap(train, test, { keys })` reports test rows whose entity key exists in train (the classic "same customer on both sides of the split") and test rows that are exact duplicates of a train row over the compared columns.

## Drift

`detectDrift(reference, current, options)` compares each column of the reference window with the current window:

- **Numeric columns** (numbers, integers, dates): the reference is cut into `bins` quantile bins (10 by default; equal-width bins with `binning: 'width'`), and the current window is counted into the same bins. The report carries the PSI over those bins, a two-sample Kolmogorov-Smirnov test on the raw values, the Jensen-Shannon divergence, the per-bin shares, and descriptive statistics for both windows.
- **Categorical columns** (strings, booleans, low-cardinality numbers with `categorical`): the same over categories, with the reference's top `maxCategories` kept and the rest merged into `other`, and a chi-square test of homogeneity instead of KS.
- **Missing values** are compared as a rate for every column.

A column counts as drifted when PSI exceeds `thresholds.psi` (0.2), the test's p-value is below `thresholds.pValue` (0.05), or the missing rate moved by more than `thresholds.missingRate` (0.1). The signals say which. Columns with fewer than `minSamples` values, columns absent from the current window, and identifier-like columns (more distinct values than `maxCategories` and unique in most rows) are skipped with a reason rather than reported as drift.

Rules of thumb for PSI: below 0.1 stable, 0.1 to 0.25 worth a look, above 0.25 a real shift. The p-values are honest at a few dozen samples and up; with very large windows every tiny difference becomes "significant", so lean on PSI there.

## Contracts

`defineContract` checks a contract for consistency and returns it; `validate(contract, rows)` produces a report with `ok`, every issue (capped at `maxIssues`, with full totals in `issueCounts`), per-column counts, extra columns, duplicate keys and the freshness of the newest row.

| Rule | Where |
| --- | --- |
| `type` (`string`, `number`, `integer`, `boolean`, `date`, `any`) | column |
| `required`, `min`, `max`, `enum`, `pattern`, `minLength`, `maxLength`, `unique`, `check(value, row)` | column |
| `grain` (columns that identify one record; must be present and unique together) | contract |
| `freshness` (`{ column, maxAge: '2d' }`) | contract |
| `extraColumns` (`allow`, `warn`, `error`), `minRows` | contract |

`inferContract(rows, { name })` drafts a contract from a sample: types, required flags for complete columns, numeric bounds widened by 10%, and enums for strings with few distinct values. It is a starting point to edit, not a substitute for knowing your grain.

## Profiles and reports

`profile(rows)` gives per-column types, missing and distinct counts, numeric statistics with quantiles and a histogram, or the top categories. `validationToMarkdown`, `driftToMarkdown`, `leakageToMarkdown`, `overlapToMarkdown`, `profileToMarkdown` and `contractToMarkdown` render the corresponding objects as Markdown tables.

The statistics are exported too, for your own checks: `psi`, `jensenShannon`, `ksTest`, `chiSquareTest`, `contingencyChiSquare`, `cramersV`, `etaSquared`, `pearson`, `quantile`, `quantileEdges`, `binCounts`, and the incomplete gamma functions behind the p-values.

## Browser demo

The docs site at https://qwertymuzaffar.github.io/leakcheck/ runs the checks in the browser on a CSV you paste or generate, with nothing uploaded anywhere.

## Performance

Synthetic data, 100,000 rows by 8 columns, Node 20 on an M1 Pro laptop (`npm run bench`):

| Check | Time |
| --- | --- |
| `validate` (contract with grain) | about 0.15 to 0.3 s |
| `profile` | about 0.4 to 0.5 s |
| `detectDrift` | about 0.5 s |
| `detectLeakage` | about 0.5 s |
| `detectOverlap` (entity keys) | about 0.2 s |

Everything is linear in the number of rows apart from the sorts behind quantiles and the KS test, so a million rows takes roughly ten times as long. The library keeps every column in memory as a plain array; for larger data, sample or run the checks per partition.

## Design notes and limitations

- Leakage detection is a screen, not a proof. It finds the obvious cases (copies, proxies, identifiers, post-outcome timestamps) and cannot see leakage that lives in how the features were computed. Use it to catch mistakes early, then still audit the feature pipeline.
- Association thresholds are deliberately high (0.95). Lower them to hunt for strong but legitimate features, and expect to review the results.
- The KS p-value uses the asymptotic distribution with a small-sample correction; the chi-square tests use the usual expected-count approximation. Both are fine for the sample sizes drift monitoring deals with and are not meant as substitutes for a statistics package.
- Longitudes, categories that wrap, and other domain-specific bins are not special-cased; pass `bins`, `binning` or your own `columns` selection when the defaults do not fit.
- I/O is limited to the CSV, NDJSON and JSON readers; Parquet, databases, scheduling, alerting and storing reports are up to the caller.

## License

MIT
