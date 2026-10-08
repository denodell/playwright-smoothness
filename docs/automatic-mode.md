# Automatic mode

Automatic mode measures every test you already have, with one change to your fixtures file:

```ts
// tests/fixtures.ts
import { test as base } from '@playwright/test';
import { withButter } from 'playwright-butter';

export const test = withButter(base, { auto: true });
export { expect } from '@playwright/test';
```

Tests that import `test` from this file get `butter` and `butterOptions` too, for explicit `measure()` and `scroll()` calls.

## What's measured

Each test that opens a page is measured once, for its whole run, with no warm-up and no reloads. The in-page collector streams what it sees to Playwright as it happens, so nothing is lost when the test navigates. That includes pages a test opens itself with `browser.newPage()` or `browser.newContext()`, and a page the test closes itself, whose last input is collected before it closes.

- `auto.interactions` lists each click, tap or key press with its element and input-to-paint time (`click on button#checkout: 180ms`), in order, across every page and navigation. `input.byTarget` summarizes them per element.
- Long frames caused by those interactions are listed with the scripts responsible, as in `measure()`. Frames from page loads and background timers are left out.
- The result is written to `test-results/smoothness/<test>/auto.json` and attached as `smoothness: auto`, so the [reporter](../README.md#reporter) includes it.

Tests that never open a page, such as API tests, produce no result.

CPU throttling is off by default in automatic mode (`cpuThrottling: 1`), because slowing every test 4x would slow the whole suite and could break its timeouts. If the suite can take it, `withButter(base, { auto: true, cpuThrottling: 4 })` turns it on.

## Rolling history from main

Each test's baseline is the median of its last 10 passing runs on the main branch (`history`). A run is compared once the history has at least 3 runs (`minHistory`). Until then, the result says "building history".

- Runs are recorded on push builds of the main (or master) branch in CI. GitHub Actions, GitLab CI, Azure Pipelines and CircleCI are detected. `record: true` or `SMOOTHNESS_RECORD=1` forces recording, and `record: false` turns it off. Pull requests only compare, so they never change main's history.
- Only runs where the test itself passed are recorded.
- Histories are keyed by test, project, platform, CPU model and CPU throttling, like `measure()` baselines, because hosted runners differ in speed ([measurements.md](measurements.md)).
- Files live in `historyDir`. By default that's `baselineDir` if you set one, and otherwise `.cache/playwright-smoothness/history` in your project's `node_modules`: the nearest one from your Playwright config up to the project root, so a workspace package whose dependencies are hoisted uses the root's. Histories are rewritten while other tests are running, and a dev server that watches your project reloads its pages when a file it watches changes. Dev servers don't watch `node_modules`, so the default stays out of their way. A project with no `node_modules`, as with Yarn Plug'n'Play, keeps them in `smoothness-history` next to the config instead, and the result notes it. That folder, or a `historyDir` or `baselineDir` elsewhere in the project, needs adding to the dev server's ignored files, such as Vite's `server.watch.ignored`.

### When a run warns

A check warns when the run is worse than the history's median by more than `maxIncrease` and the metric's floor, and also worse than every one of those recent runs by more than the floor. One run of one test varies a lot on its own, and the second condition uses each test's own variation instead of one allowance for every test. A check inside its recent range passes, with the reason "within this test's recent runs on main".

On the [Mermaid live editor](https://github.com/mermaid-js/mermaid-live-editor)'s 43 measured tests, run 20 times on unchanged code on a developer Mac:

| Rule                        | Warnings on unchanged code   | A planted 60ms delay on each edit, caught |
| --------------------------- | ---------------------------- | ----------------------------------------- |
| The median alone            | 39 of 731 comparisons (5.3%) | 7 of the 7 tests it affects               |
| The median and recent range | 9 of 731 (1.2%)              | 6 of 7                                    |

The test it missed runs the delay twice, and its input-to-paint and long frames stayed within what that test does on its own. A change smaller than a test's own variation isn't reported. Runs made hours after the history, when the whole machine was slower, still warned on 2 or 3 tests that hadn't changed, against 5 with the median alone. Treat a single warning as a reason to look, and [`calibrate`](../README.md#choose-maxincrease) shows which tests vary most on your machine.

### Changed spec files

When a spec file changes, the histories of the tests in it start again instead of failing, since the tests may now do different things. The whole spec file is hashed, so editing one test resets its neighbors too, which is conservative but simple. The result notes the reset, and the test gets a `smoothness-baseline-reset` annotation.

## Keep the history in CI

The [GitHub Action](ci.md#the-github-action) keeps the history for you, with the baselines. Without it, the history has to outlive each CI run, so `historyDir` is kept as an artifact. It's downloaded after `npm ci`, which empties `node_modules`. The pattern is the same as for [baselines in CI](ci.md), and simpler, because history files are used where they're downloaded:

```yaml
- uses: dawidd6/action-download-artifact@v6
  continue-on-error: true # the first run has no history yet
  with:
    workflow: smoothness.yml
    branch: main
    name: smoothness-history
    path: node_modules/.cache/playwright-smoothness/history

- run: npx playwright test # records on main, compares on pull requests

- name: 'Main: keep the history'
  if: github.ref == 'refs/heads/main'
  uses: actions/upload-artifact@v4
  with:
    name: smoothness-history
    path: node_modules/.cache/playwright-smoothness/history
    retention-days: 90
```

## Limitations

- An input followed straight away by a navigation isn't measured. The browser only measures an input (in Event Timing and in Long Animation Frames) once the next frame paints, and a test that clicks and then immediately calls `page.goto()` navigates before that paint. The result says "The last input before a navigation (pointerdown on …) wasn't measured" when the next document on the same page started within 250ms of the input and nothing measured it.
- Each test is measured once, with no warm-up and no median across runs. The rolling median across main-branch runs takes their place. On a developer Mac, the first interaction on a page read about twice as long as later ones, but on GitHub's runners it didn't ([measurements.md](measurements.md)), so CI histories aren't affected.
- It only uses quick mode. Full mode (tracing, screenshots, the CPU profile) is for explicit `measure()` and `scroll()` calls.
- The [README's limitations](../README.md#limitations) apply too: Chromium only, and no interactions under 16ms.
