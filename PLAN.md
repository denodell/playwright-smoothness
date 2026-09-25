# PLAN: playwright-smoothness v1

This plan follows `CLAUDE_CODE_BRIEF.md` milestone by milestone. Each milestone lists what gets built, the files it creates, how its acceptance check is run, and the risks I can see from reading the spike. **Status: approved 2026-09-24**, with the changes listed under "Decisions from plan review" at the end.

---

## Ground rules I'll follow

- One milestone at a time, **one pull request per milestone** on a branch named `m<N>-<topic>`. Small commits inside each. The full suite (lint, typecheck, unit, integration) runs green before a milestone is closed. The PR description records the acceptance checks, the numbers from the real GitHub Actions runner, and the reason for every new dependency. The next milestone starts only after that PR is merged.
- Every Playwright and CDP API is checked against current docs before first use, and the doc link goes in a code comment next to the call. Experimental ones (`Input.synthesizeScrollGesture`, trace event formats, `Emulation.setCPUThrottlingRate`) get a note in `docs/measurements.md`.
- Any sleep in library code is a named constant with a comment saying which measurement window needs it.
- Every new dependency is justified in the PR description. The planned list is short (see "Dependencies").
- If a runner disagrees with the brief, `docs/measurements.md` and the brief's section 3 are updated in the same commit.
- The package name appears in one place for code (`src/constants.ts` → `PACKAGE_NAME`) plus `package.json`, README and docs, so a rename is one grep-and-replace commit.

---

## Architecture overview

```
test code
  └─ smoothness fixture (src/fixture.ts)
       ├─ measure(label, fn, opts) / scroll(locator, opts)
       │    ├─ run loop: warm-up + N runs, reset between runs   (src/runner.ts)
       │    ├─ CDP: CPU throttling, scroll gestures              (src/cdp.ts)
       │    ├─ in-page collector (addInitScript)                  (src/collector/)
       │    ├─ tracer (full mode only)                            (src/trace/)
       │    └─ list screenshot analysis (full mode, scroll only)  (src/list/)
       ├─ classify + aggregate → SmoothnessResult (schemaVersion 1) (src/analysis/)
       └─ write JSON + attach to report                           (src/output.ts)
expect(result).toBeSmooth()
  └─ load baseline → compare → pass / warn annotation / fail      (src/baseline/, src/matcher.ts)
reporter  → markdown PR summary                                    (src/reporter/)
CLI       → calibrate                                              (src/cli/)
withSmoothness(base, { auto: true }) → automatic fixture           (src/auto/)
```

Key design decisions (open to challenge):

1. **The collector is plain JavaScript, not TypeScript compiled into a closure.** It's authored as a standalone TS module, bundled by tsup into a string, and injected with `addInitScript({ content })`. That keeps it testable in isolation (it runs in a real page in the integration suite) and stops bundler helpers leaking into the page. Every observer callback and every per-entry operation has its own try/catch; a caught error is counted into a `collectorErrors` field that surfaces in `unavailable`, never swallowed invisibly.
2. **The collector records compact records only**: numbers and strings. Targets are described at callback time (`tag#id.class`, walked up to the nearest interactive ancestor, with the raw target kept too). No DOM references survive a callback.
3. **Measurement windows are timestamp slices of one continuous collector buffer.** `measure()` reads `performance.now()` in-page before and after the callback, then waits a named settle window (enough frames for Event Timing and LoAF entries to be delivered), then pulls entries overlapping the window. That's simpler and safer than starting and stopping observers.
4. **Classification is a pure function** over `{ loaf[], events[], scrolls[], loadEventEnd, window }`, ported from the spike's rules (`firstUIEventTimestamp > 0`, Event Timing window overlap, scroll timestamp overlap, load cutoff at `loadEventEnd + 50ms`, `invokerType` as a secondary signal). Pure means it's unit-tested with fixtures recorded from real runs of the detection suite's classification page.
5. **The trace parser is a pure function** over parsed trace JSON with a declared list of required event names and fields. Anything missing produces an `unavailable` entry with the Chrome version and the missing field. It never returns 0 for "didn't see it."
6. **Warn mode passes the test.** `enforce: 'warn'` adds a `smoothness-warning` annotation, prints to stderr, and marks the JSON result `status: 'warn'`. When `GITHUB_ACTIONS=true` it also prints a `::warning file=<spec>,line=<line>,title=Smoothness::<summary>` workflow command, so the warning shows on the pull request itself. It does *not* use `expect.soft`, because Playwright marks a test with a failed soft assertion as failed, which would break principle 3.
7. **Non-Chromium projects**: the fixture calls `test.info().annotations.push({ type: 'smoothness-skipped', description: ... })` and returns a result where every measurement is in `unavailable`. `toBeSmooth()` on such a result passes with that annotation, never silently.

---

## M0: Repository, tooling, and detection test suite

**Build**
- `package.json` (ESM-first, dual export via tsup, `exports` map for `.`, `./reporter`, `./cli`; `bin: playwright-smoothness`), `tsconfig.json`, `tsup.config.ts`, `eslint.config.js` (flat config), `.prettierrc`, `.changeset/config.json`, `.gitignore`, `.nvmrc` (20).
- Node 20+ in `engines`. `@playwright/test` as a peer dependency. **Minimum version:** I believe opt-in new headless via `channel: 'chromium'` landed in Playwright 1.49 (the release that split out `chromium-headless-shell`). I'll confirm against the release notes before setting `peerDependencies` and record the source in `docs/measurements.md`. LoAF needs Chrome 123+, which 1.49's bundled Chromium already exceeds.
- ~~Copy the spike into `spike/` for reference.~~ Done, then removed during M0 review: the detection suite reproduces every spike experiment that matters (exactly, on GitHub Actions), and the spike's numbers are recorded in the brief's section 3 and `docs/measurements.md`. An unmaintained second copy of the same experiments would only invite copying its older patterns. The original stays in `loaf-headless-spike.zip`.
- `test-pages/`, served by a zero-dependency Node static server (`test-pages/server.mjs`, same shape as the spike's) through Playwright's `webServer`:
  - `raf.html`: a 200ms `requestAnimationFrame` callback
  - `click.html`: 150ms click handler (configurable via `?clickwork=`), a nested-label button, a self-removing button
  - `search.html`: input with a 60ms keydown handler
  - `scroll.html`: scroll handler with `?wait=` (wall clock) and `?work=` (iterations, so it responds to throttling)
  - `mixed.html`: load-time blocking script, background timer, and all interaction types together (the classification page, ported from the spike's `auto.html`)
  - `list.html`: a virtualized list with `?cost=`, `?overscan=`, and `?costmode=wall|iter`
  - shared `test-pages/lib/work.js` with `busyWait(ms)` and `doWork(iterations)`
- `tests/detection/*.spec.ts`: **raw Playwright, no library code.** These reproduce section 3: the scroll-blocking table (trace dropped frames, LoAF, rAF timestamps, `performance.now()` in rAF, at 12/25/40/70ms), click and keypress Event Timing, list fling states, and the throttling-versus-wall-clock check. Each writes JSON to `test-results/detection/`.
- `.github/workflows/ci.yml`: lint, typecheck, unit, integration on `ubuntu-latest`, with pinned Playwright and Chromium.
- `.github/workflows/noise.yml`: runs the integration suite five times (matrix or loop) and uploads a spread summary as an artifact. Triggered manually and on a schedule.
- `.github/workflows/latest.yml`: scheduled run against the latest Playwright and Chromium (brief section 7).
- `tests/detection/headless-mode.spec.ts` and `.github/workflows/headless-matrix.yml`: record every candidate headless-shell signal (see M1 `src/environment.ts`) for each of headless shell, new headless and headed, on Playwright at the minimum supported version, 1.56, 1.57 (first Chrome for Testing release) and the latest. Headed runs under `xvfb-run`. The chosen method and the full signal table go in `docs/measurements.md`.
- `docs/measurements.md`: actual numbers from a GitHub Actions run, next to the spike's numbers.

**Acceptance:** detection suite reproduces section 3 within stated tolerances (I'll write the tolerances into the spec file before running, not after). Real runner numbers recorded in `docs/measurements.md`.

**Risk:** the section 3 scroll table was measured without CPU throttling (the spike's `trace.spec.ts` has no CDP throttling). I'll reproduce it that way and add a second throttled table rather than mixing the two.

## M1: Quick-mode core

**Build**
- `src/collector/collector.ts` (in-page; Event Timing at `durationThreshold: 16`, LoAF, capture-phase passive scroll listener, navigation timing snapshot). Built to `dist/collector.js` string.
- `src/cdp.ts`: CDP session per page, `Emulation.setCPUThrottlingRate`, reset to 1 after measuring.
- `src/runner.ts`: warm-up run (discarded) + `runs` measured runs, medians and `spread` per headline number. Between runs the page is reset with `reset: 'reload'` (default), `'none'`, or an async function. After a reload the runner waits until the page is **settled**: the `load` event, then a quiet period with no long animation frames (`SETTLE_QUIET_MS`, a named constant, with a `SETTLE_TIMEOUT_MS` ceiling). If the page never goes quiet, the run continues and the result records a `settle-timeout` note in `unavailable`, so leftover load work isn't mistaken for interaction work without anyone knowing. The first run gets the same settle wait.
- `src/environment.ts`: browser name and version, and **headless mode detection** (`headless-shell`, `new-headless`, `headed`). Candidate signals, to be compared in M0:
  1. the launched executable path (`chrome-headless-shell` versus `chrome`/`chromium`), from `browser.browserType().executablePath()` and the launch options;
  2. CDP `Browser.getVersion` `product` and `userAgent`, which aren't affected by the `userAgent` override that Playwright's device descriptors apply to pages;
  3. the project's `channel` and `headless` options from `testInfo.project.use`.
  I'll pick the method that's right in every cell of a CI matrix of Playwright versions: the minimum supported one, 1.56 (the spike's), 1.57 (the first on Chrome for Testing builds), and the latest. If no single signal is reliable, the result says `headlessMode: 'unknown'` instead of guessing. The headless shell gets a warning annotation (and a `::warning` on Actions).
- `src/analysis/interactions.ts`: group Event Timing by `interactionId`, take the max-duration entry per interaction, interactive-ancestor naming, LoAF invoker fallback when `target` is null.
- `src/analysis/classify.ts`: load / interaction / background classification. Only interaction frames count toward gates.
- `src/analysis/aggregate.ts`: builds `input` and `longFrames` sections, `topScripts` ranked by blocking time.
- `src/fixture.ts`, `src/options.ts` (defaults, types, doc comments, env and CI detection for `mode`), `src/types.ts` (the `SmoothnessResult` schema).
- `src/index.ts` exports `test`, `expect`, types.
- **Framework check:** two pages that cover the two attribution problems teams will hit:
  - `test-pages/react/`: React, **delegated** events. Expect LoAF invokers to name the root container and React's dispatcher.
  - `test-pages/angular/`: Angular with Zone.js, **wrapped** events. Zone.js wraps every handler, so LoAF may blame `zone.js` instead of the component method.
  Both are prebuilt by esbuild into static files with source maps, so the webServer stays zero-dependency. Angular is built without the Angular CLI (standalone component, JIT via `@angular/compiler`), which keeps the dev dependency footprint down; if JIT hides the attribution problem that AOT builds show, I'll switch to an AOT build and say so. For each page I'll record what LoAF invokers, `sourceFunctionName` and `sourceURL:line:char` look like, and whether Event Timing still names the real element. If the app's function can't be named from LoAF alone, I'll add source-map resolution and, for Zone.js, a rule that skips known framework frames (`zone.js`, React's dispatcher) when choosing the script to blame, keeping the raw entry alongside. Findings go in `docs/frameworks.md`.

**Acceptance:** detection suite passes for quick-mode signals through the library. Classification is correct on `mixed.html` in at least 19 of 20 runs (a dedicated repeat test, `tests/integration/classify-repeat.spec.ts`).

## M2: Baselines, matcher, and output

**Build**
- `src/baseline/store.ts`: path from `testInfo.snapshotPath()`, keyed by label, project, platform, mode, refresh rate **and CPU throttling rate** (a baseline taken at 4x is meaningless at 1x). Written when `updateSnapshots` is `all` or `missing` or no baseline exists. The first run records, passes, and adds a `smoothness-baseline-created` annotation.
- `baselineDir` lookup: if set, read from `<baselineDir>/<same relative key>` first, falling back to the snapshot path.
- `src/baseline/compare.ts`: pure comparison. Gates: `frames.onTimePercent` (lower is worse), `list.blankFramePercent`, `input.p95ToPaintMs`, `longFrames.count`. `totalBlockingMs` only with an explicit `gateTotalBlocking: true` option. Handles missing baseline, missing measurement on either side (reported, not gated, not zero), and the zero-baseline case (an absolute floor is needed, otherwise 0 → 1 long frame is an infinite increase; I'll propose small per-metric floors and document them).
- `src/matcher.ts`: `toBeSmooth(options?)`, message leads with what got worse and the top scripts, then numbers, then a noise note pointing to `calibrate` when the run spread is wider than `maxIncrease`.
- `src/output.ts`: JSON to `test-results/smoothness/<test-id>/<label>.json` and `testInfo.attach()`.

**Acceptance:** unit tests for compare (missing baseline, missing measurements, warn vs fail, zero baselines, noise note). Integration: 10ms → 60ms click work fails with `enforce: 'fail'`; a same-code rerun passes.

## M3: Full mode

**Build**
- `src/trace/tracer.ts`: `browser.startTracing` / `stopTracing` around each run. I'll start from the spike's category set, remove categories one at a time, and record in `docs/trace-categories.md` which events each one contributes and what it costs in bytes.
- `src/trace/parse.ts`: `PipelineReporter` (`ph: 'b'`, `args.frame_reporter.state`), `AnimationFrame` durations, `Screenshot` events. Window by trace timestamps aligned to the measured interaction. Explicitly ignores `has_missing_content` and `checkerboarded_needs_raster`.
- `frames` section: `total` excludes `STATE_NO_UPDATE_DESIRED`; `onTime` = presented all/partial; `dropped` = `STATE_DROPPED`.
- `budget120` from `AnimationFrame` durations over 8.33ms, `predicted: true`, never gated.
- `tests/fixtures/traces/*.json`: trimmed recorded traces (12ms, 25ms, a list fling, and a deliberately broken one missing fields), so the parser runs in unit tests without a browser.
- Tracing overhead measurement written up in `docs/measurements.md`.

**Acceptance:** 12ms → 0 dropped, 25ms → more than 0. Parser fixtures pass, including the "missing field → unavailable" case.

## M4: `smoothness.scroll()` for lists

**Build**
- `src/scroll.ts`: `wheel` and `touch` via `Input.synthesizeScrollGesture` (`gestureSourceType: 'mouse' | 'touch'`), speeds `slow`/`normal`/`fast` mapped to px/s (proposed 1500/3000/6000, the spike used 6000), `distance: 'end'` computed from the element's scroll extent, horizontal and vertical. `keys` sends arrow keys at a named fixed interval and measures each press through Event Timing.
  - Risk: `touch` source may require `hasTouch` on the context. I'll check, and either enable it for the gesture or mark `touch` unavailable with a reason.
- `src/list/blank.ts`: crop each trace screenshot to the list's bounding box (scaled from viewport to screenshot size, which is 500×500 in the spike, not the viewport size), classify pixels as background within a tolerance, and report `blankFrames`, `blankFramePercent`, `leastDrawnPercent`. `background: 'auto'` reads the computed background colour; `placeholders` accepts colours or selectors (selectors resolved to their computed colours before the gesture).
- **JPEG decoding approach (recommendation):** decode in the Chromium that's already running, in a separate throwaway page, using `createImageBitmap` and `OffscreenCanvas`, and return per-frame drawn ratios, not pixels. Zero new dependencies, hardware-accelerated, well under the 2s budget. It runs after the measurement window closes, so it can't affect the numbers. The fallback, if that proves awkward, is `jpeg-js` (pure JS, no native build); I'd benchmark it against the 2s/200-frame budget before choosing it.

**Acceptance:** cheap list reports close to 0% blank; costly list (15ms/row, no overscan) reports a majority blank; analysis of 200 frames takes under 2s on the CI runner (timed in the test).

## M5: Reporter and calibrate

**Build**
- `src/reporter/index.ts` (exported as `playwright-smoothness/reporter`): reads result attachments in `onTestEnd`, writes `test-results/smoothness/summary.md` in the `129ms (+20ms, +18%)` style, top scripts for failures, and a section for unavailable or skipped checks.
- `src/cli/index.ts` + `src/cli/calibrate.ts`: `npx playwright-smoothness calibrate [--runs 5] [-- <playwright args>]` spawns `npx playwright test` repeatedly with `SMOOTHNESS_CALIBRATE=1` (disables gating, writes JSON), reads results, prints each check's spread and a suggested `maxIncrease` just above it, and warns above 0.15 naming the noisy metric. No argument-parsing dependency; `node:util` `parseArgs` is enough.

**Acceptance:** snapshot tests for the markdown. Two consecutive calibrate runs on the test pages give stable suggestions (I'll define "stable" as within one rounding step, and write that down first).

## M6: Automatic mode

**Build**
- `src/auto/withSmoothness.ts`: wraps a `test` with an auto fixture that injects the collector, records for the whole test once, and writes a result with a per-interaction breakdown ("click on `button#checkout`: 180ms to paint").
- `src/auto/history.ts`: rolling median of the last N passing runs on main (N proposed at 10), stored as `<baselineDir>/auto/<test-key>.json`. Only written when the run is on the main branch (detected from CI env vars, overridable).
- `src/auto/sourceHash.ts`: hash the **whole spec file** at `testInfo.file`. If the hash differs from the stored one, start a fresh history for every test in that file and annotate instead of failing. This is conservative (editing one test resets its neighbours too) but simple and correct. A per-test hash is a later refinement, only if people ask for it.
- `docs/ci-history.md`: how to keep the history as a CI artifact.

**Acceptance:** a plain Playwright spec in `tests/auto-fixture/`, unchanged except for its fixtures import, produces a result and a baseline. Editing the spec file resets its baseline (automated by copying the spec to a temp dir and editing it).

## Release stages

Eight milestones is a long time before anyone uses the library, so it ships in three steps. Publishing to npm is outward-facing, so I'll prepare each release and ask before running `npm publish`.

- **0.1.0 preview, after M2.** Quick mode, baselines, the matcher, JSON output. Marked as a preview in the README and on npm (`next` dist-tag). The point is to collect noise data from other people's runners early. Needs a minimal README (install, quick start, what the numbers mean, limitations so far), `npm publish --dry-run` clean, and a changeset. This work lands in the M2 PR.
- **Public launch (0.x `latest`), after M4.** Adds full mode and `smoothness.scroll()` with blank-row detection, the headline feature. Needs the README hero image (drawn list frame next to a blank one, generated from the M4 test list), the CI recipe, and `examples/plain-site/` plus `examples/react-list/`. This work lands in the M4 PR (or a small release PR straight after it).
- **1.0, after M7.** Reporter, calibrate, automatic mode, full documentation.

## M7: Documentation and 1.0

- `README.md`: pitch, hero image (drawn frame next to a blank frame, generated from the M4 test list), 60-second quick start, what each number means, limitations, GitHub Actions CI recipe.
- `examples/plain-site/`, `examples/react-list/`, `examples/github-actions/`.
- `npm publish --dry-run` clean; CHANGELOG via changesets.

---

## Files (planned)

```
.changeset/config.json
.github/workflows/{ci,noise,latest}.yml
docs/{measurements,frameworks,trace-categories,ci-history,mode-detection}.md
examples/{plain-site,react-list,github-actions}/
src/
  index.ts  constants.ts  types.ts  options.ts  fixture.ts  runner.ts  cdp.ts
  matcher.ts  output.ts  scroll.ts
  collector/collector.ts
  analysis/{interactions,classify,aggregate,stats}.ts
  baseline/{store,compare}.ts
  trace/{tracer,parse}.ts
  list/blank.ts
  reporter/index.ts
  cli/{index,calibrate}.ts
  auto/{withSmoothness,history,sourceHash}.ts
  environment.ts
test-pages/  server.mjs  lib/work.js  *.html  react/  angular/
tests/
  unit/            (vitest-free: Playwright Test runs unit specs too, see below)
  detection/       (raw Playwright, M0)
  integration/     (through the library)
  fixtures/traces/ (recorded trace JSON)
  auto-fixture/    (M6)
playwright.config.ts  tsconfig.json  tsup.config.ts  eslint.config.js  .prettierrc
package.json  LICENSE  README.md  CHANGELOG.md  PLAN.md
```

## Dependencies

- **Runtime:** none planned. Peer: `@playwright/test`. Possibly `source-map-js` (M1, only if the framework check shows it's needed) and `jpeg-js` (M4, only if in-browser decoding fails).
- **Dev:** `typescript`, `tsup`, `eslint` + `typescript-eslint`, `prettier`, `@changesets/cli`, `react` + `react-dom`, and `@angular/core`, `@angular/common`, `@angular/compiler`, `@angular/platform-browser`, `zone.js`, `rxjs` (test pages only), `@types/node`.
- **Unit tests:** I'll run them with Playwright Test itself (a separate `unit` project with no browser) rather than add vitest. One runner, one fewer dependency. Happy to switch if you'd prefer vitest.

## Mode detection (to be documented in `docs/mode-detection.md`)

Order: `test.use({ smoothness: { mode } })` → `SMOOTHNESS_MODE` → scheduled CI (`GITHUB_EVENT_NAME=schedule`, `CI_PIPELINE_SOURCE=schedule` for GitLab, `BUILD_REASON=Schedule` for Azure Pipelines, `CIRCLE_PIPELINE_TRIGGER_SOURCE=scheduled_pipeline` for CircleCI) → `full`, otherwise `quick`. The chosen mode and the rule that chose it are recorded in the result.

---

## Decisions from plan review (2026-09-24)

1. **Reset between runs:** reload by default, with `'none'` and a custom async function as escape hatches. After every reload, wait until the page is settled: loaded, then a quiet period with no long frames (`SETTLE_QUIET_MS`, named constant). See M1.
2. **Workflow:** a branch and a pull request per milestone. Real-runner CI numbers go in each PR.
3. **Warn mode:** the test passes, with an annotation, a `warn` status, and a GitHub Actions `::warning` line.
4. **Baseline key** includes the CPU throttling rate.
5. **Second framework:** Angular (Zone.js wraps handlers) next to React (delegated events).
6. **Unit tests** run on Playwright Test.
7. **Spike zip** stays untracked and goes in `.gitignore`.
8. **Zero-baseline floors:** 1 long frame, **16ms** input-to-paint (two Event Timing steps, so a single 8ms rounding step can't trip it), 1 percentage point for on-time and blank-frame percentages. Documented and overridable.
9. **Headless shell detection:** choose a method by comparing signals across a Playwright version matrix that includes 1.57 (Chrome for Testing builds). See M0 and M1.
10. **Test-change detection (M6):** hash the whole spec file. Per-test hashing only if people ask for it.
11. **Staged release:** 0.1.0 preview after M2, public launch after M4, 1.0 after M7. See "Release stages".

## Decisions made during M1

12. **Option fixture name: `smoothnessOptions`, not `smoothness`.** Playwright can't use one name for both the fixture that has `measure()` and an option that `test.use()` overrides: overriding an option replaces the fixture's value. Every option can also be passed per call, as in `smoothness.measure(label, fn, { runs: 3 })`.
13. **Framework check: React and Angular (with Zone.js and zoneless).** LoAF never names the app's handler in any of them, and source maps can't fix that, because LoAF records only the entry-point script (the framework's dispatcher). No source-map resolution was added. Instead, each top script lists the interactions it blocked (`during`), taken from Event Timing, which names the real element every time. See `docs/frameworks.md`. A JavaScript profile in full mode could name the handler; that's proposed for M3.
14. **Results record the machine** (CPU model, cores, platform). GitHub's hosted runners varied about 2x in speed between jobs, so M2 must treat a baseline from a different machine as not comparable. See `docs/measurements.md`.

## Decisions made during M2

15. **Baselines are also keyed by CPU model and by test title.** CPU model because hosted runners differ up to 1.5x between models (decision 14). A baseline from another model is never compared; the message lists which models have baselines. Test title because two tests in one spec file that use the same label would otherwise share a baseline without anyone noticing. Renaming a test starts a fresh baseline.
16. **`--update-snapshots` modes:** `missing` (Playwright's default) records a baseline only when none exists; `all` replaces it; `changed` replaces it only when the check got worse; `none` never writes, and a missing baseline is reported as not compared.
17. **Warn mode** passes the test, adds a `smoothness-warning` annotation, prints the full report to stderr, and in GitHub Actions prints a `::warning` for the test's file and line.
18. **Percent metrics compare the bad share.** `frames.onTimePercent` is compared as 100 − value, so 95% → 81% on-time frames can't hide inside a 15% relative allowance.
19. **Typed config:** `defineConfig<SmoothnessTestOptions>()` is needed for `use: { smoothnessOptions }` to typecheck in `playwright.config.ts`. Covered by a compile-only test.
20. **CI baselines** come from the main branch through `baselineDir` (`docs/ci.md`). The recipe is checked end to end before the public release (M4).
21. **Preview publishing** uses `npm run release:preview`, which passes `--tag next` explicitly, because npm didn't show `publishConfig.tag` taking effect in a dry run. Publishing needs your go-ahead.

## Decisions made during M3

22. **Trace window from in-page marks**, not from input events. `performance.mark()` calls land in the trace (`blink.user_timing`) with both clocks, so frames are counted between the marks. This also explains M0's "tracing start" drop: it came from Playwright's `about:blank` compositor.
23. **Minimal categories:** `disabled-by-default-devtools.timeline.frame` + `blink.user_timing` (240KB, against 2,148KB for the spike's set), plus `devtools.timeline` only for `refreshRate: 120`.
24. **A frame reported both presented and dropped counts as both.** That's how a blocked main thread shows while the compositor keeps scrolling, and it's what the section 3 table measures.
25. **`frames.onTimePercent` is null when no frame had an update**, rather than 100.
26. **Full mode records a V8 CPU profile** (your call on PR #4). It's in the same trace and windowed by the same marks, and attributed to the page's main thread only. `profile.hotFunctions` names `onCheckout` behind React's and Angular's dispatchers in readable builds. Minified React would need source maps; that's an open question.
