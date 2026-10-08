# butter-core

## 1.0.0

The first release: the measuring engine behind [`playwright-smoothness`](https://github.com/denodell/playwright-smoothness#readme), released with it at the same version.

- `measure()` and `measureScroll()` run the measurements described in playwright-smoothness's README, through two interfaces an adapter implements: `PageDriver` for the page and `ElementTarget` for the element to scroll.
- `preparePage()` installs the in-page collector before the first navigation.
- `evaluate()` compares a result with its baseline, given a `BaselineTarget` that says where the runner keeps baselines, and `formatMessage()` explains what changed. `checkBudget()` checks fixed limits, and `formatBrief()` writes a fix brief for a coding agent.
- The result format (`schemaVersion: 1`) and the baseline and history files are the same ones playwright-smoothness writes.
