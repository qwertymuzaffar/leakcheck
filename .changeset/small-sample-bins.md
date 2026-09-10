---
'leakcheck': patch
---

Scale the quantile bins of the binned Cramer's V with the sample size. Ten bins on a few dozen rows let the bias correction push a perfect numeric proxy below the 0.95 association threshold (about 0.95 on 60 rows, so it was not flagged); the default is now the square root of a third of the rows, clamped to 2..10, which keeps that proxy above 0.98 at 60 rows and leaves 300 or more rows at ten bins. `detectLeakage` accepts `bins` and the CLI `leak` command `--bins` to fix the count.
