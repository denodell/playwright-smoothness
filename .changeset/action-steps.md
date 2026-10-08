---
'playwright-butter': minor
'butter-core': minor
---

The GitHub Action can now go around a Playwright step you already have: `denodell/playwright-butter/setup@v1` before it fetches main's baselines and sets up the run, and `denodell/playwright-butter/report@v1` after it writes the summary, comments on the pull request and, on main, publishes the baselines. The all-in-one Action still works as before, and now runs the suite once on scheduled runs instead of twice. Its `snapshot-dir` input is no longer used. Recording through the Action now needs playwright-butter 1.1 or later.

`SMOOTHNESS_RECORD_BASELINES=1` makes each check compare with its baseline, then record the result as the new one, next to the test and in `baselineDir`, so CI can publish that folder as main's baselines without `--update-snapshots`. In the summary, a re-recorded baseline no longer says it was re-recorded by `--update-snapshots`, since this setting re-records it too.
