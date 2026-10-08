# Measurements

This file records what the detection suite (`tests/detection/`, raw Playwright with no library code) measures, next to the numbers from the spike. The spike was the prototype this library grew from, and it ran in a single-CPU sandbox on Chrome 141. Each tolerance in the detection suite is explained here.

The measurements come from three environments:

| Name           | Where                | Playwright | Chrome                             | CPU                                                  |
| -------------- | -------------------- | ---------- | ---------------------------------- | ---------------------------------------------------- |
| Spike          | single-CPU sandbox   | 1.56       | 141.0.7390.37                      | 1                                                    |
| Local          | macOS, Apple Silicon | 1.63.0     | 153.0.8010.12 (Chrome for Testing) | 10 cores                                             |
| GitHub Actions | `ubuntu-latest`      | 1.63.0     | 153.0.8010.12                      | 4 vCPU, AMD EPYC 9V45, 16GB (PR #1, run 35940477326) |

All numbers are new headless (`channel: 'chromium'`) unless stated.

## Versions and sources

- Minimum Playwright: 1.49. The 1.49 release notes introduce opt-in new headless: "You can opt into the new headless mode by using `'chromium'` channel." 1.49 bundles Chromium 131, which is past LoAF's Chrome 123. Source: https://playwright.dev/docs/release-notes (1.49 section).
- 1.57 switched to Chrome for Testing builds. The release notes say headed mode uses `chrome` and headless mode uses `chrome-headless-shell`, so headless-mode detection is tested across versions (see [Headless-mode detection](#headless-mode-detection)).
- `browser.startTracing` / `stopTracing` and CDP `Input.synthesizeScrollGesture` are present and typed in Playwright 1.63 (`types.d.ts`, `protocol.d.ts`).

## Scroll-blocking table

A scroll handler blocks the main thread for N ms (wall clock) on each scroll. The test makes ten wheel scrolls of 150px, 80ms apart, with no CPU throttling (`tests/detection/scroll-table.spec.ts`).

| Blocking | Trace dropped, spike | Trace dropped, local (median of 5; runs) | Trace dropped, GitHub Actions (median; runs) | LoAF (spike / local / GHA) | rAF timestamps late (spike / local / GHA) | `performance.now()` in rAF late (spike / local / GHA) |
| -------- | -------------------- | ---------------------------------------- | -------------------------------------------- | -------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| 0ms      | 0                    | 0 (0, 0, 2, 0, 0)                        | 0 (0, 0, 0, 0, 0)                            | 0 / 0 / 0                  | 0 / 0 / 0                                 | 0 / 0 / 0                                             |
| 12ms     | 0                    | 0 (0, 7, 0, 0, 0)                        | 0 (0, 0, 0, 0, 0)                            | 0 / 0 / 0                  | 0 / 0 / 0                                 | 10 / 10 / 10                                          |
| 25ms     | 2                    | 2 (2, 2, 2, 3, 4)                        | 2 (2, 2, 2, 2, 2)                            | 0 / 0 / 0                  | 0 / 0 / 0                                 | 10 / 10 / 10                                          |
| 40ms     | 4                    | 6 (6, 4, 6, 4, 6)                        | 4 (4, 4, 4, 4, 4)                            | 10 / 10 / 10               | 10 / 10 / 10                              | 10 / 10 / 10                                          |
| 70ms     | 8                    | 9 (8, 9, 8, 9, 9)                        | 8 (8, 8, 8, 8, 8)                            | 10 / 10 / 10               | 10 / 10 / 10                              | 10 / 10 / 10                                          |

Trace size: about 1.9MB per run on both machines (spike: about 1.8MB).

On the GitHub Actions runner the spike's table reproduces exactly, with no spread: all five runs gave 0 / 0 / 2 / 4 / 8. The noise in the local columns comes from the Mac.

### Differences from the spike's method (found on the local Mac)

The spike counted every `STATE_DROPPED` frame in the trace from one run. Doing the same on Chrome 153 gave 1 dropped frame at 0ms and 3 at 12ms, which contradicts the spike's table. The raw traces showed three separate causes, and the suite now handles each one. The GitHub Actions run shows that causes 2 and 3 only happen on the Mac (see the note after each). The suite keeps all three fixes anyway, because they're cheap, they're correct in principle, and developers run the suite locally.

1. Starting a trace adds a dropped frame. In most runs, one `STATE_DROPPED` frame lands about 550ms before the first input, when tracing starts. The suite only counts frames inside the input window, from the first input's `EventLatency` to the last one plus 150ms (`INPUT_TAIL_MS`). The library also limits trace frames to the interaction, using in-page marks. _(Found later: the frame belongs to Playwright's initial `about:blank` document, which has its own compositor, so it comes from neither tracing nor the page. See [trace-categories.md](trace-categories.md).)_
2. The first wheel on a page takes a 46–58ms frame, with no page work at all (three runs: 46, 58, 46ms). After one warm-up wheel the long frame is gone (longest frame 18–20ms). The suite makes one warm-up wheel before measuring, and this is why `measure()` makes a warm-up run first. _GitHub Actions:_ after the warm-up, the longest frame with no work was 16.5ms. The same effect on the first click didn't appear on the runner at all (see [Event Timing and LoAF](#event-timing-and-loaf)), so it's at least partly a Mac effect. The warm-up run stays for developer machines.
3. Single runs are noisy because they have very few frames. Each wheel tick presents about one frame (12–14 presented frames per run), so one stray pair of drops moves a run a lot. At 12ms blocking, one run of five dropped 7 frames and the other four dropped 0. Gating on one run's drop count would be flaky on a developer machine, so the suite takes the median of 5 traced runs, and the library does the same with `runs: 5`. _GitHub Actions:_ there was no spread across five runs at any blocking level, so the runner doesn't need the median. It stays for local runs.

`frame_reporter.affects_smoothness` was also tried as a filter. It was false on nearly every dropped frame, including the real drops at 25ms, so it isn't useful.

### Tolerances (written before the first CI run, and met on it)

- 0ms and 12ms: median trace drops ≤ 2 (spike: 0). LoAF at most 1 of 10. rAF timestamps 0 late.
- 12ms: `performance.now()` flags at least 8 of 10 (it over-reports).
- 25ms: median trace drops > 0. LoAF at most 1 of 10. rAF timestamps 0 late.
- 40ms and 70ms: median trace drops > 0; LoAF and rAF timestamps flag at least 8 of 10.
- Across rows: 25ms > 0ms, 70ms > 12ms, and 70ms ≥ 25ms, all on medians.
- The LoAF column only counts long frames in which the scroll handler ran. On 2026-09-26, a 12ms run on the fastest runner model (EPYC 9V45) saw two unrelated long frames during the scrolls. They're recorded as `loafOther` and aren't counted as the handler.
- LoAF allows one handler frame at 12ms and 25ms. On a busy runner, the handlers for several wheel events can run in the same frame, and four 12ms handlers plus rendering go past 50ms. That happened once in a CI run on 2026-09-26. Even then, the column misses the handler in at least 9 of 10 scrolls.

## Event Timing and LoAF

| Check                           | Spike                                           | Local                                     |
| ------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| 200ms rAF callback              | 1 LoAF entry                                    | 1 entry, `user-callback`, `heavyFrame`    |
| 150ms click                     | 1 entry, `BUTTON#heavy.onclick`, `onHeavyClick` | same                                      |
| LoAF for 12ms / 25ms clicks     | 0                                               | 0 (after a warm-up click)                 |
| Event Timing, 25ms click        | 24–32ms, 8ms steps                              | 24ms ×5 after warm-up, 8ms steps          |
| Nested span click target        | `span.label`                                    | `span.label`; `closest()` gives `#nested` |
| Self-removing button            | target null; invoker `BUTTON#vanish.onclick`    | same                                      |
| 60ms keydown ×3                 | 3 interactions on `input#search`                | same, ≥56ms each                          |
| Wheel scrolling in Event Timing | none                                            | none; scroll listener saw ≥10 events      |
| Idle page                       | 0 LoAF                                          | 0                                         |

The first interaction on a page reads high on the Mac but not on the runner. With a 25ms handler, the local Mac measured the first click at 56ms, with a LoAF entry, and the next three at 24ms. GitHub Actions measured all four at 24ms with no LoAF entry, so the effect comes from the machine rather than from Chrome. Automatic mode measures each test once, so on a developer machine a test's first interaction may read high. CI runners, where histories come from, aren't affected (see Limitations in [automatic-mode.md](automatic-mode.md)).

## CPU throttling

`tests/detection/throttling.spec.ts` runs a scroll handler that does 1,500,000 iterations per scroll, with ten 400px wheel scrolls and five runs for each setting.

|                    | Long frames (min / median / max) | Total blocking ms (min / median / max) |
| ------------------ | -------------------------------- | -------------------------------------- |
| 1x, local          | 0 / 0 / 1                        | 0 / 0 / 14                             |
| 4x, local          | 10 / 10 / 10                     | 131 / 134 / 145 (±5%)                  |
| 4x, spike          | 9 / 10 / 10                      | 164 / 205 / 248 (about ±25%)           |
| 1x, GitHub Actions | 0 / 0 / 0                        | 0 / 0 / 0                              |
| 4x, GitHub Actions | 10 / 10 / 10                     | 942 / 952 / 999 (±3%)                  |

Both machines are much less noisy than the spike's single-CPU sandbox. The same work blocks about 7x longer on the runner than on the Mac (952ms against 134ms of total blocking), which is why baselines have to come from the machine that gates.

Throttling slows work measured in iterations, but not a wait measured in wall-clock time. These durations come from the click handler's LoAF script duration:

|                            | 1x      | 4x                   |
| -------------------------- | ------- | -------------------- |
| `busyWait(100)`, local     | 100.2ms | 100.3ms (not slowed) |
| `doWork(6,000,000)`, local | 71.7ms  | 263.8ms (3.7x)       |
| `busyWait(100)`, GHA       | 100.1ms | 100.0ms (not slowed) |
| `doWork(6,000,000)`, GHA   | 150.3ms | 608.1ms (4.0x)       |

## Noise on GitHub Actions

A noise workflow ran the whole detection suite five times in one job on `main` (run 35943204024). It has since been removed, and `calibrate` now does this job.

Within one job, noise is very low. Every scroll-table number was identical across all five runs (0 / 0 / 2 / 4 / 8 dropped, with the LoAF and rAF columns exact too). Throttled long-frame counts didn't move (10 / 10 / 10), and throttled total blocking time varied by ±1–2%, against ±25–40% in the spike's single-CPU sandbox. Dropped-frame counts for the fast list scroll were the least steady (cheap: 2–3; costly: 7–9).

Between jobs, runner speed varies by up to 1.5x, and total blocking at 4x by up to 2x. The same iteration-based work took:

| Job                        | CPU                        | `doWork(6,000,000)` at 1x | Throttled scroll, total blocking (4x) |
| -------------------------- | -------------------------- | ------------------------- | ------------------------------------- |
| PR #1 CI (run 35940477326) | AMD EPYC 9V45, 4 vCPU      | 150ms                     | 952ms                                 |
| Noise (run 35943204024)    | not recorded; see next row | 226ms                     | 1,891ms                               |
| PR #2 CI (run 35945190946) | AMD EPYC 9V74, 4 vCPU      | 197ms                     | 1,568ms                               |
| Noise (run 35945158558)    | AMD EPYC 7763, 4 vCPU      | 226ms                     | 1,902ms                               |

The later runs recorded their CPUs. Three models gave three speeds for the same work: 150ms on the EPYC 9V45, 197ms on the EPYC 9V74, and 226ms on the EPYC 7763 (the same as the earlier noise run, which didn't record its CPU). `ubuntu-latest` is a pool of different hardware, and each job lands on one of them.

This had two effects on the library:

1. The unthrottled throttling check failed on the slower runner. Without throttling, the 1,500,000-iteration scroll work already made 60ms frames there, so 4x couldn't add long frames (10 against 10). The detection test now asserts what throttling does guarantee: total blocking time and the worst frame at least double. The spike's finding that moderate jank gives zero long frames at 1x only holds on a fast machine.
2. Baselines can only be compared on the same kind of machine. A baseline recorded on a fast runner would make every check on a slow runner look about 100% worse. Every result now records `machine` (CPU model, core count, platform), so the library detects a baseline from a different machine and reports that, instead of reporting a false regression. Timing-based checks (`input.p95ToPaintMs`, `longFrames.worstMs`) move with CPU speed. Counts (`longFrames.count`, dropped frames) move less, but frames can still cross the 50ms threshold, as the throttling check above showed.

## Refresh rate and AnimationFrame

- Frames per second with rAF in new headless: 60 by default, 57 with `--disable-frame-rate-limit`, and 60 with `--disable-gpu-vsync` (GitHub Actions: 60, 58, 61). As the spike found, the flags don't raise the rate.
- AnimationFrame events after a warm-up wheel, locally: at 0ms blocking, 31 frames, 17 over 8.33ms, 3 over 16.7ms, longest 17.4ms. At 25ms blocking, 10 over 16.7ms, longest 42.8ms. On GitHub Actions: at 0ms, 10 of 31 over 8.33ms, none over 16.7ms, longest 16.5ms. At 25ms, 10 over 16.7ms, longest 25.2ms. None were over 50ms on either machine, so LoAF wouldn't see any of them. As in the spike, many frames take more than 8.33ms with no work, which is why the 120Hz budget is reported but not gated.

## Fast scroll through a long list

`Input.synthesizeScrollGesture`, `yDistance: -20000`, `speed: 6000`, 600×600 viewport, with screenshots.

| Rows                       | Frames | Presented | Dropped | `has_missing_content` | Screenshots | Trace size |
| -------------------------- | ------ | --------- | ------- | --------------------- | ----------- | ---------- |
| cheap (0ms, overscan 2)    | 427    | 404       | 5       | 0                     | 204         | 21.5MB     |
| moderate (4ms, overscan 2) | 427    | 406       | 4       | 0                     | 205         | 21.3MB     |
| costly (15ms, overscan 0)  | 255    | 233       | 10      | 0                     | 205         | 13.4MB     |
| cheap, GHA                 | 423    | 404       | 3       | 0                     | 203         | 19.8MB     |
| moderate, GHA              | 427    | 407       | 2       | 0                     | 205         | 19.9MB     |
| costly, GHA                | 252    | 234       | 7       | 0                     | 205         | 12.4MB     |

- Every scroll covered the full 20,000px on the compositor thread (`SCROLL_COMPOSITOR_THREAD`).
- Dropped frames stay under 4% even for the costly list, so they can't reveal blank rows. That's why blank rows are measured from screenshots ([list-detection.md](list-detection.md)).
- `has_missing_content` changed between Chrome versions. On 141 it was set on about 78% of frames for every list. On 153 it's 0 for every list, including the blank one, on both the Mac and the runner. The library doesn't use it, and the suite only asserts that it doesn't separate cheap from costly, which holds on both versions.
- With screenshots on, a trace is about 10x the spike's estimate: 13–22MB per 3.3s scroll, against about 1.8MB per 1.5s without screenshots. The library parses and discards each trace as soon as it's recorded.
- `scroll()` measures blank-frame percentages (spike: cheap ≥87% drawn, costly median 0%), as described in [list-detection.md](list-detection.md).

## Synthetic touch scrolling

`Input.synthesizeScrollGesture` with `gestureSourceType: 'touch'` does nothing on Linux, and the CDP call returns no error. A temporary probe on the GitHub Actions runner (PR #5) scrolled the test list 2,000px on Chrome 153:

| Method                                                   | macOS   | Linux (`ubuntu-latest`) |
| -------------------------------------------------------- | ------- | ----------------------- |
| `synthesizeScrollGesture`, touch source, default context | 2,010px | **0px**                 |
| … with `hasTouch: true`                                  | 1,997px | **0px**                 |
| … with `hasTouch` and `isMobile`                         | 2,010px | **0px**                 |
| … with CDP `Emulation.setTouchEmulationEnabled`          | 1,994px | **0px**                 |
| `synthesizeScrollGesture`, `'default'` source            | 2,000px | 2,000px                 |
| `synthesizeScrollGesture`, mouse source                  | 2,000px | 2,000px                 |
| `Input.dispatchTouchEvent`: one 380px drag, then release | 544px   | 572px                   |

`input: 'touch'` is built from real touch events instead. It makes repeated swipes (press, drag across 60% of the list at the requested speed, release, and let the list keep moving on its own) until the distance is covered, and it behaves the same on both platforms. The problem was found because the React example's "cheap list stays drawn" check passed on CI with 0% blank frames while the list didn't scroll at all. Since then, `scroll()` also reports list data as unavailable when no run moved the list.

## Headless-mode detection

`tests/detection/headless-mode.spec.ts` runs in the `mode-*` projects locally, and in `.github/workflows/headless-matrix.yml` on Playwright 1.49.0, 1.56.0, 1.57.0 and latest.

Local, Playwright 1.63.0:

| Mode           | CDP `Browser.getVersion` product | CDP user agent token           | UA-CH brands                          | `executablePath()`             |
| -------------- | -------------------------------- | ------------------------------ | ------------------------------------- | ------------------------------ |
| headless shell | `HeadlessChrome/153.0.8010.12`   | `HeadlessChrome/153.0.8010.12` | HeadlessChrome, Not_A Brand, Chromium | Chrome for Testing app (wrong) |
| new headless   | `Chrome/153.0.8010.12`           | `HeadlessChrome/153.0.0.0`     | Chromium, Not_A Brand                 | Chrome for Testing app         |
| headed         | `Chrome/153.0.8010.12`           | `Chrome/153.0.0.0`             | Chromium, Not_A Brand                 | Chrome for Testing app         |

The detection rule only uses CDP, so user-agent overrides that device descriptors apply to the page don't affect it. If the product starts with `HeadlessChrome/`, it's the headless shell. Otherwise, if the CDP user agent contains `HeadlessChrome/`, it's new headless. Anything else is headed. `scripts/headless-summary.mjs` mirrors the rule and checks it against every record from the matrix.

`browserType().executablePath()` isn't usable. It returns the browser type's default executable rather than the one that was launched, so it names the full Chrome binary even when the headless shell is running.

The matrix on GitHub Actions `ubuntu-latest` (headed under `xvfb-run`, run 35940477338) detected 12 of 12 records correctly:

| Playwright | Chrome        | Headless shell product | New headless: product / CDP UA token       | Headed: product / CDP UA token     |
| ---------- | ------------- | ---------------------- | ------------------------------------------ | ---------------------------------- |
| 1.49.0     | 131.0.6778.33 | `HeadlessChrome/131…`  | `Chrome/131…` / `HeadlessChrome/131.0.0.0` | `Chrome/131…` / `Chrome/131.0.0.0` |
| 1.56.0     | 141.0.7390.37 | `HeadlessChrome/141…`  | `Chrome/141…` / `HeadlessChrome/141.0.0.0` | `Chrome/141…` / `Chrome/141.0.0.0` |
| 1.57.0     | 143.0.7499.4  | `HeadlessChrome/143…`  | `Chrome/143…` / `HeadlessChrome/143.0.0.0` | `Chrome/143…` / `Chrome/143.0.0.0` |
| 1.63.0     | 153.0.8010.12 | `HeadlessChrome/153…`  | `Chrome/153…` / `HeadlessChrome/153.0.0.0` | `Chrome/153…` / `Chrome/153.0.0.0` |

The Chrome for Testing switch in 1.57 didn't change any of these signals. `executablePath()` was wrong on every version (it always names `chrome`). `packages/butter-core/src/environment.ts` uses the CDP rule above. If `Browser.getVersion` fails, or returns something that matches none of the patterns, the result reports `headlessMode: 'unknown'`.
