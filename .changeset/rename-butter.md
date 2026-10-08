---
'playwright-butter': minor
'butter-core': minor
---

playwright-smoothness is now playwright-butter, and smoothness-core is now butter-core. To move over, install `playwright-butter` in place of `playwright-smoothness` and change the imports, the reporter (`playwright-butter/reporter`), the command (`npx playwright-butter`) and the GitHub Action (`denodell/playwright-butter@v1`, or its `setup` and `report` steps). `withSmoothness()` is now `withButter()`, and the `smoothness` fixture is now `butter` (`butter.measure()`, `butter.scroll()`), and `smoothnessOptions` is now `butterOptions` (with the `ButterTestOptions` type); the old names still work for now. Nothing else changes: `toBeSmooth()` and the `SMOOTHNESS_*` environment variables keep their names, and existing baselines and automatic-mode histories still load. `npx playwright-butter init-agents` replaces a skill added under the old name.
