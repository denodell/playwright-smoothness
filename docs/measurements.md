# Measurements

This file records what the detection suite (`tests/detection/`, raw Playwright with no library code) actually measures, next to the spike's numbers from section 3 of the brief. Every tolerance in the detection suite is justified here.

Environments:

| Name           | Where                | Playwright | Chrome                             | CPU                                            |
| -------------- | -------------------- | ---------- | ---------------------------------- | ---------------------------------------------- |
| Spike          | single-CPU sandbox   | 1.56       | 141.0.7390.37                      | 1                                              |
| Local          | macOS, Apple Silicon | 1.63.0     | 153.0.8010.12 (Chrome for Testing) | 10 cores                                       |
| GitHub Actions | `ubuntu-latest`      | 1.63.0     | 153.0.8010.12                      | _pending: first CI run on the M0 pull request_ |

All numbers are new headless (`channel: 'chromium'`) unless stated.

## Versions and sources

- **Minimum Playwright: 1.49.** The 1.49 release notes introduce opt-in new headless: "You can opt into the new headless mode by using `'chromium'` channel." 1.49 bundles Chromium 131, which is past LoAF's Chrome 123. Source: https://playwright.dev/docs/release-notes (1.49 section).
- **1.57 switched to Chrome for Testing builds.** The release notes say headed mode uses `chrome` and headless mode uses `chrome-headless-shell`. That is why headless-mode detection is tested across versions (see below).
- `browser.startTracing` / `stopTracing` and CDP `Input.synthesizeScrollGesture` are present and typed in Playwright 1.63 (`types.d.ts`, `protocol.d.ts`).

## Scroll-blocking table (section 3)

A scroll handler blocks the main thread N ms (wall clock) per scroll. Ten wheel scrolls of 150px, 80ms apart. No CPU throttling. `tests/detection/scroll-table.spec.ts`.

| Blocking | Trace dropped, spike | Trace dropped, local (median of 5; runs) | GitHub Actions | LoAF (spike / local) | rAF timestamps late (spike / local) | `performance.now()` in rAF late (spike / local) |
| -------- | -------------------- | ---------------------------------------- | -------------- | -------------------- | ----------------------------------- | ----------------------------------------------- |
| 0ms      | 0                    | 0 (0, 0, 2, 0, 0)                        | _pending_      | 0 / 0                | 0 / 0                               | 0 / 0                                           |
| 12ms     | 0                    | 0 (0, 7, 0, 0, 0)                        | _pending_      | 0 / 0                | 0 / 0                               | 10 / 10                                         |
| 25ms     | 2                    | 2 (2, 2, 2, 3, 4)                        | _pending_      | 0 / 0                | 0 / 0                               | 10 / 10                                         |
| 40ms     | 4                    | 6 (6, 4, 6, 4, 6)                        | _pending_      | 10 / 10              | 10 / 10                             | 10 / 10                                         |
| 70ms     | 8                    | 9 (8, 9, 8, 9, 9)                        | _pending_      | 10 / 10              | 10 / 10                             | 10 / 10                                         |

Trace size: about 1.9MB per run (spike: about 1.8MB).

### Why the suite differs from the spike's method

The spike counted every `STATE_DROPPED` frame in the trace from one run. Reproducing that on Chrome 153 gave 1 dropped frame at 0ms and 3 at 12ms, which contradicts the spike's table. Probing the raw traces showed three separate causes, and the suite now handles each one:

1. **Tracing start adds a dropped frame.** In most runs, one `STATE_DROPPED` frame lands about 550ms before the first input, when tracing starts. The suite counts only frames inside the input window: from the first input's `EventLatency` to the last one plus 150ms (`INPUT_TAIL_MS`). **Consequence for M3:** the library must window trace frames to the interaction too.
2. **The first wheel on a page costs a 46–58ms frame,** with no page work at all (three runs: 46, 58, 46ms). After one warm-up wheel it's gone (longest frame 18–20ms). The suite does one warm-up wheel before measuring. **Consequence for M1:** the warm-up run is required, not optional.
3. **Single runs are noisy because there are very few frames.** Each wheel tick presents about one frame (12–14 presented frames per run), so one stray pair of drops moves a run a lot. At 12ms blocking, one run of five dropped 7 frames and the other four dropped 0. The suite takes the median of 5 traced runs. **Consequence for M3:** gating on one run's drop count would be flaky, so the default `runs: 5` median is necessary.

`frame_reporter.affects_smoothness` was also checked as a filter. It was false on nearly every dropped frame, including the real drops at 25ms, so it isn't useful.

### Tolerances (written before the first CI run)

- 0ms and 12ms: median trace drops ≤ 2 (spike: 0). LoAF 0. rAF timestamps 0 late.
- 12ms: `performance.now()` flags at least 8 of 10 (it over-reports).
- 25ms: median trace drops > 0. LoAF 0. rAF timestamps 0 late.
- 40ms and 70ms: median trace drops > 0; LoAF and rAF timestamps flag at least 8 of 10.
- Across rows: 25ms > 0ms, 70ms > 12ms, and 70ms ≥ 25ms, all on medians.

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

**New finding: the first interaction on a page is inflated.** With a 25ms handler, the first click measured 56ms and produced a LoAF entry; the next three measured 24ms. This is the click version of the first-wheel cost above. **Consequence for M6:** automatic mode runs each test once, so a test's first interaction will read high. It needs a note in the result, or it should be excluded from gates. I'll bring this up in the M6 PR.

## CPU throttling (section 3)

`tests/detection/throttling.spec.ts`, scroll handler with 1,500,000 iterations per scroll, ten 400px wheel scrolls, five runs each.

|                    | Long frames (min / median / max) | Total blocking ms (min / median / max) |
| ------------------ | -------------------------------- | -------------------------------------- |
| 1x, local          | 0 / 0 / 1                        | 0 / 0 / 14                             |
| 4x, local          | 10 / 10 / 10                     | 131 / 134 / 145 (±5%)                  |
| 4x, spike          | 9 / 10 / 10                      | 164 / 205 / 248 (about ±25%)           |
| 4x, GitHub Actions | _pending_                        | _pending_                              |

The local machine is much less noisy than the spike's sandbox. The noise workflow (`.github/workflows/noise.yml`) measures the runner.

Wall clock versus iterations, measured from the click handler's LoAF script duration:

|                     | 1x      | 4x                   |
| ------------------- | ------- | -------------------- |
| `busyWait(100)`     | 100.2ms | 100.3ms (not slowed) |
| `doWork(6,000,000)` | 71.7ms  | 263.8ms (3.7x)       |

## Refresh rate and AnimationFrame (section 3)

- Frames per second with rAF, new headless: default 60, `--disable-frame-rate-limit` 57, `--disable-gpu-vsync` 60. As the spike found, the flags don't raise the rate.
- AnimationFrame events after a warm-up wheel. 0ms blocking: 31 frames, 17 over 8.33ms, 3 over 16.7ms, longest 17.4ms. 25ms blocking: 10 over 16.7ms, longest 42.8ms. None over 50ms, so LoAF would see none of these. As in the spike, many frames exceed 8.33ms with no work, which is why the 120Hz budget is reported only.

## Long-list fling (section 3)

`Input.synthesizeScrollGesture`, `yDistance: -20000`, `speed: 6000`, 600×600 viewport, with screenshots.

| Rows                       | Frames | Presented | Dropped | `has_missing_content` | Screenshots | Trace size |
| -------------------------- | ------ | --------- | ------- | --------------------- | ----------- | ---------- |
| cheap (0ms, overscan 2)    | 427    | 404       | 5       | 0                     | 204         | 21.5MB     |
| moderate (4ms, overscan 2) | 427    | 406       | 4       | 0                     | 205         | 21.3MB     |
| costly (15ms, overscan 0)  | 255    | 233       | 10      | 0                     | 205         | 13.4MB     |

- Every fling scrolled the full 20,000px on the compositor thread (`SCROLL_COMPOSITOR_THREAD`).
- Dropped frames stay under 4% even for the costly list, so they can't reveal blank rows. That confirms the need for screenshot analysis (M4).
- **`has_missing_content` changed between Chrome versions.** On 141 it fired on about 78% of frames for every list. On 153 it's 0 for every list, including the blank one. The brief already says not to use it. The suite now asserts only that it doesn't separate cheap from costly, which holds on both versions.
- **Trace size is about 10x the spike's estimate** once screenshots are on: 13–22MB per 3.3s fling, against about 1.8MB per 1.5s without screenshots. M3 and M4 need to stream or discard traces promptly, and not keep them in memory across runs.
- Blank-frame percentages (spike: cheap ≥87% drawn, costly median 0%) aren't reproduced yet. That needs the M4 pixel analysis.

## Headless-mode detection

`tests/detection/headless-mode.spec.ts`, run by the `mode-*` projects locally and by `.github/workflows/headless-matrix.yml` on Playwright 1.49.0, 1.56.0, 1.57.0 and latest.

Local, Playwright 1.63.0:

| Mode           | CDP `Browser.getVersion` product | CDP user agent token           | UA-CH brands                          | `executablePath()`             |
| -------------- | -------------------------------- | ------------------------------ | ------------------------------------- | ------------------------------ |
| headless shell | `HeadlessChrome/153.0.8010.12`   | `HeadlessChrome/153.0.8010.12` | HeadlessChrome, Not_A Brand, Chromium | Chrome for Testing app (wrong) |
| new headless   | `Chrome/153.0.8010.12`           | `HeadlessChrome/153.0.0.0`     | Chromium, Not_A Brand                 | Chrome for Testing app         |
| headed         | `Chrome/153.0.8010.12`           | `Chrome/153.0.0.0`             | Chromium, Not_A Brand                 | Chrome for Testing app         |

**Candidate rule (CDP only, so page user-agent overrides from device descriptors don't affect it):** product starts with `HeadlessChrome/` → headless shell; otherwise the CDP user agent contains `HeadlessChrome/` → new headless; otherwise headed. The rule is in `scripts/headless-summary.mjs`, which checks it against every record from the matrix.

`browserType().executablePath()` is **not** usable. It returns the browser type's default executable, not the one that was launched, so it names the full Chrome binary even when the headless shell is running.

Matrix results: _pending, from the M0 pull request's headless-matrix run._
