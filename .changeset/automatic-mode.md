---
'playwright-smoothness': minor
---

Automatic mode: `withSmoothness(base, { auto: true })` in a fixtures file measures every test that opens a page, once, across navigations, with no changes to the tests. Each run is compared with the median of the test's recent passing runs on the main branch (`history`, `minHistory`, `record`, `historyDir`). Editing a spec file restarts its history instead of failing, and an input the test navigates away from before it paints is reported as not measured.
