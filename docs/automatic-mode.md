# Automatic mode

Measure every test you already have, with no changes to the tests.

```ts
// tests/fixtures.ts — the only file that changes
import { test as base } from '@playwright/test';
import { withSmoothness } from 'playwright-smoothness';

export const test = withSmoothness(base, { auto: true });
export { expect } from '@playwright/test';
```

Tests that import `test` from this file are measured automatically. `smoothness` and `smoothnessOptions` are available in them too, for explicit `measure()` and `scroll()` calls.

## What's measured

Each test that opens a page is measured **once**, for its whole run, with no warm-up and no reloads. The in-page collector streams what it sees to Playwright as it happens, so nothing is lost when the test navigates:

- **Every interaction, in order:** `auto.interactions` lists each click, tap or key press with its element and input-to-paint time (`click on button#checkout: 180ms`), across every page and navigation. `input.byTarget` summarises them per element.
- **Long frames caused by those interactions**, with the scripts responsible, as in `measure()`. Frames from page loads and background timers are identified and left out.
- The result is written to `test-results/smoothness/<test>/auto.json` and attached as `smoothness: auto`, so the [reporter](../README.md#summary-for-pull-requests) includes it.

Tests that never open a page (API tests, for example) produce no result.

**CPU throttling is off by default in automatic mode** (`cpuThrottling: 1`). Slowing every test 4x would slow the whole suite and could break its timeouts. Turn it on with `withSmoothness(base, { auto: true, cpuThrottling: 4 })` if the suite can take it.

## The baseline: a rolling history from main

Each test's baseline is the **median of its last 10 passing runs on the main branch** (`history`). A run is compared once the history has at least 3 runs (`minHistory`); until then the result says "building history".

- **Recording** happens on push builds of the main (or master) branch in CI: GitHub Actions, GitLab CI, Azure Pipelines and CircleCI are detected. Set `record: true` or `SMOOTHNESS_RECORD=1` to force it, or `record: false` to turn it off. Pull requests only compare, so they never change main's history.
- Only runs where the test itself passed are recorded.
- Histories are keyed by test, project, platform, CPU model and CPU throttling, like `measure()` baselines, because hosted runners differ in speed (see [measurements.md](measurements.md)).
- Files live in `historyDir`: by default `baselineDir` if you set one, else `smoothness-history` next to your Playwright config.

### When a test changes

When a spec file changes, the histories of the tests in it **start again** instead of failing: the test may now do different things. The whole spec file is hashed, so editing one test resets its neighbours too. That's conservative but simple. The result notes it, and the test gets a `smoothness-baseline-reset` annotation.

## Keeping the history in CI

The history must outlive each CI run, so keep `historyDir` as an artifact. The pattern is the same as for baselines ([ci.md](ci.md)), and simpler, because history files are used where they're downloaded:

```yaml
- uses: dawidd6/action-download-artifact@v6
  continue-on-error: true # the first run has no history yet
  with:
    workflow: smoothness.yml
    branch: main
    name: smoothness-history
    path: smoothness-history

- run: npx playwright test # records on main, compares on pull requests

- name: 'Main: keep the history'
  if: github.ref == 'refs/heads/main'
  uses: actions/upload-artifact@v4
  with:
    name: smoothness-history
    path: smoothness-history
    retention-days: 90
```

## Limitations

- **An input followed straight away by a navigation isn't measured.** The browser only measures an input (in Event Timing and in Long Animation Frames) once the next frame paints. A test that clicks and then immediately calls `page.goto()` navigates before that paint, so there's no data to collect. The result says so: "The last input before a navigation (pointerdown on …) wasn't measured". This is reported when the next document on the same page started within 250ms of the input and nothing measured it.
- **Measured once.** There's no warm-up and no median across runs; the rolling median across main-branch runs takes their place. On a developer Mac, the first interaction on a page read about twice as long as later ones. On GitHub's runners it didn't ([measurements.md](measurements.md)), so CI histories aren't affected.
- **Quick mode only.** Full mode (tracing, screenshots, the CPU profile) is for explicit `measure()` and `scroll()` calls.
- **Interactions under 16ms aren't reported by the browser** (Event Timing's minimum threshold), so `input.interactions` counts slower ones.
- **Chromium only**, as elsewhere. Other browsers get a `smoothness-skipped` annotation.
