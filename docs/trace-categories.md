# Trace categories and tracing overhead

Full mode records a Chrome trace for each run. This page records which categories the library enables, why, and what tracing costs. Measured locally on Chrome 153 (Playwright 1.63).

## What each category contributes

The same interaction was traced with different category sets: ten wheel scrolls over a page whose scroll handler blocks for 25ms, with a `performance.mark()` before and after.

| Categories                                                                                                                                               | Trace size | Events | PipelineReporter | AnimationFrame | EventLatency | Marks |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ---------------- | -------------- | ------------ | ----- |
| The spike's set (`devtools.timeline`, `disabled-by-default-devtools.timeline`, `…timeline.frame`, `benchmark`, `cc`, `viz`, `gpu`) + `blink.user_timing` | 2,148KB    | 11,048 | ✓                | ✓              | ✓            | ✓     |
| `disabled-by-default-devtools.timeline.frame` + `blink.user_timing`                                                                                      | **240KB**  | 749    | ✓                | –              | –            | ✓     |
| `benchmark` + `blink.user_timing`                                                                                                                        | 974KB      | 4,194  | ✓                | –              | ✓            | ✓     |
| `cc` + `blink.user_timing`                                                                                                                               | 851KB      | 3,888  | ✓                | –              | ✓            | ✓     |
| `…timeline.frame` + `input` + `blink.user_timing`                                                                                                        | 633KB      | 2,928  | ✓                | –              | ✓            | ✓     |
| `…timeline.frame` + `devtools.timeline` + `blink.user_timing`                                                                                            | **368KB**  | 1,350  | ✓                | ✓              | –            | ✓     |
| `devtools.timeline` + `blink.user_timing`                                                                                                                | 188KB      | 604    | –                | ✓              | –            | ✓     |

Where each event lives:

- `PipelineReporter` (frame states) is tagged `cc,benchmark,disabled-by-default-devtools.timeline.frame` and recorded when any of the three is on. `…timeline.frame` is by far the smallest of them.
- `AnimationFrame` (every main-thread frame's duration) is in `devtools.timeline`.
- `performance.mark()` calls are in `blink.user_timing`. Each mark's `args.data.startTime` is its `performance.now()` value, so the marks line the trace up with the page's clock exactly.
- `EventLatency` is in `cc,benchmark,input,input.scrolling`. The detection suite used it to find the input window. The library doesn't need it, because it places its own marks.

**Chosen sets** (`src/trace/categories.ts`):

| Use                                            | Categories                                                         | Size for this interaction |
| ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| Frame states (always in full mode)             | `disabled-by-default-devtools.timeline.frame`, `blink.user_timing` | 240KB                     |
| Plus the 120Hz prediction (`refreshRate: 120`) | + `devtools.timeline`                                              | 368KB                     |
| Plus list screenshots (`scroll()`, M4)         | + `disabled-by-default-devtools.screenshot`                        | measured in M4            |

That's about 9x smaller than the spike's set, with the same frame states.

## Windowing, and the "tracing start" drop explained

The library puts `playwright-smoothness:start` and `:end` marks around the measured action and counts only frames between them. The start mark is placed two animation frames after tracing starts.

In M0 the detection suite found a dropped frame about 550ms before the first input in most traces, and worked around it with an input window. The M3 probe found the cause. That frame comes from a **different compositor** (`layer_tree_host_id` 1, frame sequence 5): Playwright's initial `about:blank` document. The page under test is `layer_tree_host_id` 2. The mark window excludes it naturally.

Each frame can appear in more than one `PipelineReporter` event:

- **Exact repeats** (same host, source, sequence and state) are counted once.
- **One frame reported as both `STATE_PRESENTED_ALL` and `STATE_DROPPED`** counts as both. The compositor presented the scroll, but the blocked main thread missed its update. That's the signal the section 3 table rests on (25ms blocking: 2 dropped). Collapsing the pair into "presented" would hide it.

`frames.total` is presented plus dropped. `STATE_NO_UPDATE_DESIRED` frames had nothing to show and aren't counted. When no frame had an update, `onTimePercent` is `null`, not 100.

## Tracing overhead

The same interactions measured in quick mode and full mode on the same page, 5 runs each, 4x CPU throttling (`tests/integration/tracing-overhead.spec.ts`):

| Interaction          | Long frames (quick / full) | Worst frame     | Input-to-paint p95 | Wall time per measure() |
| -------------------- | -------------------------- | --------------- | ------------------ | ----------------------- |
| Click, 150ms handler | 1 / 1                      | 152.8 / 152.8ms | 152 / 160ms        | 4.7s / 4.8s             |
| Typing, 60ms keydown | 3 / 3                      | 64.3 / 65.0ms   | 64 / 64ms          | 6.5s / 6.5s             |
| Scroll, 70ms handler | 5 / 5                      | 87.2 / 87.7ms   | n/a / n/a          | 6.9s / 7.2s             |

Tracing with the chosen categories doesn't change what's measured: identical long-frame counts, worst frames within 0.7ms, and input-to-paint within one Event Timing step (8ms), which is under the 16ms floor. Wall time rises 1–4%. The integration test asserts this on every CI run.

**Per-mode baselines are enough.** Baselines are keyed by mode, so a full-mode run is never compared with a quick-mode baseline, and the numbers the two modes share agree anyway.
