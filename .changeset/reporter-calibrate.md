---
'playwright-smoothness': minor
---

`playwright-smoothness/reporter` writes a markdown summary for pull requests (and the GitHub Actions job summary): every check's change against its baseline, the scripts and CPU-profile functions behind regressions, and everything not measured or compared. `npx playwright-smoothness calibrate` runs the suite several times on unchanged code and suggests a `maxIncrease` per check.
