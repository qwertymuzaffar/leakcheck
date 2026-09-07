---
'leakcheck': minor
---

Baselines (`createBaseline` + `detectDrift(baseline, rows)`) so monitoring jobs compare new batches without the training rows; a `leakcheck` command line for CSV, TSV, NDJSON and JSON files with Markdown or JSON output and failing exit codes; `parseCsv`, `parseNdjson`, `toCsv` in the core and `leakcheck/node` file readers; a browser demo. Options passed as explicit `undefined` no longer override default thresholds.
