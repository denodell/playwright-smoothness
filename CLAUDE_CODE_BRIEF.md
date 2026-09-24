# Build brief: a Playwright library that fails the build when a web UI stops being smooth

Working package name: **`playwright-smoothness`**. If the name changes (for example to `playwright-60fps`), change it everywhere in one commit. The fixture is `smoothness` and the matcher is `toBeSmooth()` whatever the package is called.

Read this whole brief before writing any code. Then write `PLAN.md` with your milestone plan, the files you intend to create, and any questions that block you. Work milestone by milestone, commit in small steps, and run the full test suite at the end of each milestone. Don't start a milestone until the previous one's acceptance checks pass.

---

## 1. What we're building and why

Web teams have no packaged way to test smoothness in CI. Android has Macrobenchmark's frame timing metric and iOS has XCTest's hitch metrics, but on the web teams inspect jank by hand in DevTools, or rely on `requestAnimationFrame` scripts that give wrong answers (see section 3). Large companies like Figma build their own systems.

This library adds that capability to Playwright:

- It measures scripted interactions (scrolls, clicks, typing, key navigation) in Chromium.
- It compares each result with a stored baseline, not a fixed number.
- It fails the test when the interaction got meaningfully worse, and names the scripts responsible.

The headline use case is long lists: flicking through a catalogue, feed, or data table and failing the build when frames drop **or rows go blank while scrolling**.

It's a measurement layer that plugs into a team's existing Playwright setup and CI. It is not a hosted service, a dashboard, or a hardware fleet.

## 2. Principles (apply to every decision)

1. **Small public API.** One fixture (`smoothness`) with a few methods, one matcher (`toBeSmooth()`), one reporter, one CLI. Everything else is an option with a sensible default.
2. **Compare against a baseline, never an absolute target.** Absolute numbers depend too much on the CI machine.
3. **Start as a warning.** `enforce: 'warn'` is the default. Teams switch to `'fail'` once they trust a check.
4. **Explain every failure.** A failure message says what got worse, by how much against the baseline, and which scripts or elements were responsible.
5. **Never lie quietly.** If a measurement is unavailable (wrong browser, missing trace field, unsupported API), say so in the result and the report. Never report zero where the truth is "unknown."
6. **In-page code must never throw.** Wrap every PerformanceObserver callback and every per-entry operation in its own try/catch. When a callback throws, every other entry in that batch is lost silently. This happened in the spike and hid a real interaction.
7. **Chromium only for gating.** In Firefox and WebKit, skip the measurement with a visible test annotation. Never pass silently.
8. **Machine-readable output.** Every result is also written as versioned JSON (`schemaVersion: 1`), so CI scripts and coding agents can read it.

## 3. Facts established by the spike (don't re-derive; build on these)

A prototype was run with Chromium 141 and Playwright 1.56 in the headless shell, new headless (`channel: 'chromium'`), and headed modes. The spike project is in `loaf-headless-spike.zip`. ~~Copy it into `spike/` for reference, but don't ship it.~~ It was copied during M0 and then removed: the detection suite (`tests/detection/`) now reproduces these experiments, and the spike's numbers live in this section and in `docs/measurements.md`.

**APIs and what they can and can't see**

| Source | What it gives | Limits |
|---|---|---|
| Long Animation Frames (LoAF) | Frames over 50ms, with `blockingDuration`, `firstUIEventTimestamp`, and `scripts[]` (invoker, invokerType, sourceURL, sourceFunctionName, duration) | The 50ms threshold is fixed by the spec as a privacy protection. `durationThreshold` is ignored. In practice it catches about 40ms or more of script, since rendering time adds to the frame. |
| Event Timing (`type: 'event'`) | Per-event duration from input to the next paint, with `interactionId` and `target` | Accepts `durationThreshold: 16`, the minimum. Durations come in 8ms steps. Covers clicks, taps, keys, and pointer events, but **not scrolling or wheel events**. |
| Chrome trace (`browser.startTracing`) | `PipelineReporter` events whose `args.frame_reporter.state` is `STATE_PRESENTED_ALL`, `STATE_PRESENTED_PARTIAL`, `STATE_DROPPED`, or `STATE_NO_UPDATE_DESIRED`. `AnimationFrame` events give every main-thread frame's duration, with no 50ms cutoff. `Screenshot` events hold per-frame JPEGs when `screenshots: true`. | Internal, unstable format. Chromium only. About 1.8MB per 1.5s of interaction. |

**Measured behavior (scroll handler blocking the main thread N ms per scroll, 10 scrolls)**

| Blocking | Trace dropped frames | LoAF | rAF timestamps | `performance.now()` in rAF |
|---|---|---|---|---|
| 12ms | 0 | missed | missed | flagged 10 (wrong) |
| 25ms | 2 | missed | missed | flagged 10 |
| 40ms | 4 | 10 | 10 | 10 |
| 70ms | 8 | 10 | 10 | 10 |

- **Do not use `requestAnimationFrame` sampling as a metric.** Frame timestamps under-report, because late frames keep their scheduled time. `performance.now()` over-reports, because a late callback doesn't mean a dropped frame.
- The trace was the only accurate source for dropped frames. Scrolling runs on the compositor thread, so a blocked main thread drops far fewer frames than LoAF suggests.

**Headless and rendering**

- The headless shell is identified by CDP `Browser.getVersion`: its `product` starts with `HeadlessChrome/`. New headless has `HeadlessChrome/` only in the CDP user agent. Verified on Playwright 1.49, 1.56, 1.57 (the first Chrome for Testing release) and 1.63 on GitHub Actions. `browserType().executablePath()` does not identify the running binary.
- All three modes produced the same pass/fail results. Default to **new headless** (`channel: 'chromium'`), because Playwright's docs say it's closer to real Chrome. Warn when running in the headless shell.
- Pages report `visibilityState: 'visible'` in headless, so LoAF works there.
- Headless Chrome is fixed at about 60 frames per second. `--disable-frame-rate-limit` and `--disable-gpu-vsync` had no effect. 120Hz can only be *predicted*, by checking `AnimationFrame` durations against 8.33ms.
- In a single-CPU sandbox, 9 of 31 frames exceeded 8.33ms with no added work, so 120Hz predictions must be baseline-compared and reported only, never gated.

**CPU throttling and noise**

- `Emulation.setCPUThrottlingRate` through a CDP session works. Without throttling, moderate jank produced **zero** long frames on a fast machine (on a slower GitHub Actions runner the same work already made long frames at 1x). Throttling is on by default (rate 4).
- Wall-clock busy-waits aren't slowed by throttling. The library's own test pages must use iteration-based work when testing throttling.
- Noise across five runs at 4x: total blocking time varied by about ±25 to 40% around the median (single-CPU sandbox). On a GitHub Actions runner, within one job, it varied only ±1–2%. But runner speed varied about 2x *between* jobs (see `docs/measurements.md`), so baselines must record and match the machine they came from. The long-frame count and Event Timing durations were much steadier. The calibrate command and failure messages must make noise visible (see M5).

**Interactions and classification (automatic mode groundwork)**

- Event Timing reported every click and keypress with its target element. A click on a nested `span` reports the span, so walk up to the nearest interactive ancestor (`button, a, input, select, textarea, [role], [tabindex]`) for reporting.
- A self-removing element leaves `target` null. Fall back to the LoAF script invoker (for example `BUTTON#vanish.onclick`).
- Scroll interactions come from LoAF invokers (for example `DIV#feed.onscroll`) plus a passive capture-phase scroll listener recording timestamps.
- Load, interaction, and background frames were classified 10 out of 10 correctly in every run, using `firstUIEventTimestamp > 0`, overlap with Event Timing interaction windows, overlap with scroll timestamps, and `start < navigation.loadEventEnd + 50ms`. LoAF's `invokerType` (`classic-script`, `event-listener`, `user-callback`, and so on) is a secondary signal.
- **Not yet tested: framework event delegation (React and similar).** Expect LoAF invokers to name the root container and the framework's dispatcher rather than the app's handler, and sourceURLs to point at bundles. Event Timing targets should still be the real element. See M1.

**Long lists**

- `Input.synthesizeScrollGesture` produces a real, compositor-driven fling (for example `yDistance: -20000, speed: 6000`).
- `frame_reporter.has_missing_content` and `checkerboarded_needs_raster` **must not be used**. They fired on about 78% of frames even for a cheap list whose screenshots were fully drawn (Chrome 141). On Chrome 153 they read 0 on every frame, including a blank list, locally and on GitHub Actions (see `docs/measurements.md`). Either way they carry no signal.
- **Blank rows are the main failure in virtualized lists, and dropped frames miss them.** A list with 15ms per-row cost and no overscan dropped only 8 of 240 frames, but screenshots showed it blank in 188 of 203 frames.
- Trace screenshots (about 200 per 3.3s fling, 500×500 JPEG) reliably separated the cases. With screenshots on, a trace is 12–22MB per fling (measured on GitHub Actions and locally, Chrome 153), about 10x the no-screenshot size, so traces must be discarded as soon as they're parsed. A cheap list stayed at least 87% drawn, a moderate one dipped to 72%, and the costly one had a median of 0%.

## 4. Public API (v1)

```ts
import { test, expect } from 'playwright-smoothness';

test('article list scrolls smoothly', async ({ page, smoothness }) => {
  await page.goto('/articles');
  const result = await smoothness.measure('open filters', async () => {
    await page.getByRole('button', { name: 'Filters' }).click();
  });
  expect(result).toBeSmooth();
});

test('catalogue flick stays drawn', async ({ page, smoothness }) => {
  await page.goto('/catalogue');
  const result = await smoothness.scroll(page.getByRole('list', { name: 'Trending' }), {
    distance: 'end',          // or pixels
    direction: 'vertical',    // or 'horizontal'
    input: 'touch',           // 'wheel' | 'touch' | 'keys'
    speed: 'fast',            // 'slow' | 'normal' | 'fast' | pixels per second
  });
  expect(result).toBeSmooth();
});
```

**Options** (through `test.use({ smoothness: {...} })` or config `use`):

```ts
{
  mode: 'quick',        // 'quick' = Event Timing + LoAF; 'full' adds trace and screenshots
  runs: 5,              // repeated runs; median taken; one warm-up run discarded
  cpuThrottling: 4,
  maxIncrease: 0.15,    // allowed increase against the baseline
  refreshRate: 60,      // 120 adds a reported-only budget prediction
  enforce: 'warn',      // 'warn' | 'fail'
  baselineDir: undefined, // optional directory with baselines downloaded from main
  list: { background: 'auto', placeholders: [] }, // see M4
}
```

- `mode` can also be set with the environment variable `SMOOTHNESS_MODE`. If nothing is set, detect scheduled CI runs (for example `GITHUB_EVENT_NAME=schedule`) and use `full` there, `quick` elsewhere. Document the detection rules.
- Auto mode (M6): `export const test = withSmoothness(base, { auto: true })` in a fixtures file.

**Result object** (also written as JSON):

```ts
{
  schemaVersion: 1, label, mode, runs, browserVersion, headlessMode,
  frames?:     { total, onTime, dropped, onTimePercent },           // full mode
  list?:       { blankFrames, blankFramePercent, leastDrawnPercent }, // scroll() in full mode
  input:       { interactions, p95ToPaintMs, worstMs, byTarget: [{ target, ms }] },
  longFrames:  { count, totalBlockingMs, worstMs,
                 topScripts: [{ source, fn, invoker, invokerType, blockingMs }] },
  budget120?:  { framesOverBudget, predicted: true },
  spread:      { /* min, median, max per headline number across runs */ },
  unavailable: [ /* names of measurements that couldn't be taken, with reasons */ ],
}
```

**`toBeSmooth(options?)`** compares with the baseline. The gates are: `frames.onTimePercent` (full mode), `list.blankFramePercent` (for scroll results in full mode), `input.p95ToPaintMs`, and `longFrames.count`. `totalBlockingMs` is reported but only gated with an explicit option, because of its noise. The failure message leads with what changed and the top scripts, then the numbers.

## 5. Milestones

### M0: Repository, tooling, and a detection test suite
- TypeScript, Node 20 or later, `@playwright/test` as a peer dependency. Pick the lowest version that supports `channel: 'chromium'` new headless and check it against Playwright's release notes. Build with `tsup` (ESM and CJS with types). ESLint and Prettier. MIT licence. Changesets for releases.
- Create `test-pages/`, a small static site served by Playwright's `webServer`, with controlled jank: a 200ms `requestAnimationFrame` callback; a 150ms click handler; a nested-label button; a self-removing button; a search input with a 60ms keydown handler; scroll handlers with configurable wall-clock and iteration-based work; a load-time blocking script; a background timer; and a virtualized list with configurable per-row cost and overscan.
- GitHub Actions workflow: lint, typecheck, unit tests, and the integration suite on `ubuntu-latest`, plus a **noise job** that runs the integration suite five times and uploads the spread as an artifact.
- **Acceptance:** the integration suite reproduces the section 3 tables within reasonable tolerance, run through raw Playwright before any library code. Record the actual numbers on a real GitHub Actions runner in `docs/measurements.md`. They will differ from the sandbox.

### M1: Quick mode core
- An in-page collector, injected with `addInitScript`, for Event Timing (threshold 16), LoAF, and scroll timestamps. Every callback is try/catch wrapped per entry. It stores compact records only, never DOM nodes, and describes targets at callback time.
- CPU throttling through a CDP session. Runs, warm-up, and median.
- Interaction grouping by `interactionId`, interactive-ancestor target naming, and LoAF invoker fallback.
- Load, interaction, and background classification. Only interaction frames count towards gates.
- **Framework check:** add a small React test page (and ideally one more framework) that uses delegated events. Report what LoAF attribution looks like there, and add source-map resolution for `sourceURL:line` if it's needed to name the app's function. Document the result.
- **Acceptance:** the detection suite passes for quick-mode signals. Classification is correct on the mixed page in at least 19 of 20 runs.

### M2: Baselines, the matcher, and output
- Store baselines with Playwright's snapshot mechanism (`testInfo.snapshotPath`), keyed by label, project, platform, mode, and refresh rate. Update them with `--update-snapshots`. The first run records and passes, with a visible note.
- `baselineDir` option for CI baselines downloaded from main.
- `toBeSmooth()` with `maxIncrease` (default 0.15). `enforce: 'warn'` produces a soft failure or annotation, not a hard failure.
- JSON written under `test-results/smoothness/` and attached to the Playwright report.
- Failure messages as specified in section 4. **When the measured spread across runs is wider than `maxIncrease`, say so in the message and point to `calibrate`.**
- **Acceptance:** unit tests for comparison logic, including missing baselines, missing measurements, and warn versus fail. Integration test: a change from 10ms to 60ms click work fails. A change within noise passes.

### M3: Full mode
- Tracing with the minimal category set needed (measure and document what each category contributes), parsing `PipelineReporter` states and `AnimationFrame` durations.
- **Trace parser safety:** parse defensively. Record the Chrome version. If expected events or fields are missing, mark the measurement `unavailable` with a clear reason. Never report zero.
- Measure the overhead of tracing, comparing quick and full mode on the same pages and the same interaction frame counts. Document it, and confirm that per-mode baselines are enough.
- `refreshRate: 120` adds `budget120` from `AnimationFrame` durations against 8.33ms, reported only.
- **Acceptance:** the detection suite reproduces the trace column of the section 3 table (12ms gives 0 dropped frames; 25ms gives more than 0). A test fixture of recorded trace JSON keeps the parser covered without a browser.

### M4: `smoothness.scroll()` for lists
- `wheel` and `touch` through `Input.synthesizeScrollGesture`, at speeds mapped from `slow`, `normal`, and `fast`, or given in pixels per second. Horizontal and vertical. `keys` sends arrow keys at a fixed interval and measures each press through Event Timing.
- **Blank-frame detection (full mode):** take trace screenshots, crop them to the list's bounding box, and measure how much of it is plain background per frame. `background: 'auto'` samples the list's computed background color. `placeholders` accepts colors or selectors whose appearance should count as blank. Report `blankFrames`, `blankFramePercent`, and `leastDrawnPercent`. Keep the image analysis dependency-light, and choose and justify a JPEG decoding approach.
- **Acceptance:** on the virtualized test list, the cheap configuration reports close to 0% blank frames and the costly one (15ms per row, no overscan) reports a majority blank. The per-frame analysis runs in under 2 seconds for 200 frames on a CI runner.

### M5: Reporter and calibrate
- `playwright-smoothness/reporter`: writes a markdown summary suitable for a pull request comment, showing each check's change against the baseline in the style `129ms (+20ms, +18%)`, the top scripts for failures, and a list of checks that were unavailable or skipped.
- `npx playwright-smoothness calibrate`: runs the suite several times on unchanged code and prints each check's spread, with a suggested `maxIncrease` for each (just above the observed spread). It warns when a suggestion is above 0.15 and explains which metric is noisy.
- **Acceptance:** snapshot tests for the markdown output. Calibrate produces stable suggestions over two consecutive invocations on the test pages.

### M6: Automatic mode
- `withSmoothness(base, { auto: true })` wraps a test object with an automatic fixture that measures every test, using the M1 collector, with no code changes in the tests.
- In automatic mode each test runs **once**. The baseline is a rolling median of recent passing runs on main, stored in `baselineDir`. Document how teams keep that history as a CI artifact.
- Detect when a test's own code changed (for example by hashing its source text located with `testInfo.file` and the test's line), and start a fresh baseline instead of failing.
- Per-interaction breakdown in the result using Event Timing targets, so reports say "click on `button#checkout`: 180ms to paint" without labels.
- **Acceptance:** an existing plain Playwright test, with nothing changed but the fixtures file, produces a result and a baseline. Editing that test resets its baseline.

### M7: Documentation and release
- README: a one-line pitch, a hero image (a drawn list frame next to a blank one), a 60-second quick start, what each number means, **limitations** (Chromium only; main-thread attribution; 120Hz is a prediction; noise on shared runners; headless shell versus new headless), and a CI recipe for GitHub Actions with a dedicated runner, baselines as artifacts, quick mode on pull requests, and full mode on a schedule.
- Example projects in `examples/`: a plain site, a React list, and a GitHub Actions workflow.
- `npm publish --dry-run` clean. CHANGELOG through changesets.

## 6. Out of scope for v1 (keep the architecture open for them)

- A `scan` CLI that finds safe interactions and writes tests for review
- Electron app support (Playwright's Electron support is experimental)
- A cross-browser fallback without LoAF
- An MCP server so coding agents can run checks locally
- Choosing interactions from real-user monitoring data
- GPU and compositor-only jank analysis beyond what the trace states give

## 7. Working rules for this build

- Check every Playwright and CDP API against current docs before using it. Several are experimental (`Input.synthesizeScrollGesture`, Chrome trace formats). Pin the Playwright and Chrome versions in CI, and add a scheduled job that runs the suite against the latest versions, so format changes show up early.
- Don't add dependencies without a reason written in the pull request description.
- No fixed sleeps in library code except where a measurement window requires one. Name those durations as constants with comments.
- Every public option has a default, a type, a doc comment, and a test.
- When something in this brief turns out to be wrong on a real runner, update `docs/measurements.md` and this brief's assumptions in the same commit, then continue.
