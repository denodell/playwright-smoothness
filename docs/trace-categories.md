# Trace categories and tracing overhead

Full mode records a Chrome trace for each run. This page covers which trace categories the library turns on and why, how frames in the trace are counted, and how much time tracing adds. Everything here was measured locally on Chrome 153 with Playwright 1.63 unless it says otherwise.

## Category sizes

The same interaction was traced with different sets of categories. It was ten wheel scrolls over a page whose scroll handler blocks for 25ms, with a `performance.mark()` before and after.

| Categories                                                                                                                                                    | Trace size | Events | PipelineReporter | AnimationFrame | EventLatency | Marks |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ---------------- | -------------- | ------------ | ----- |
| A broad DevTools set (`devtools.timeline`, `disabled-by-default-devtools.timeline`, `…timeline.frame`, `benchmark`, `cc`, `viz`, `gpu`) + `blink.user_timing` | 2,148KB    | 11,048 | ✓                | ✓              | ✓            | ✓     |
| `disabled-by-default-devtools.timeline.frame` + `blink.user_timing`                                                                                           | **240KB**  | 749    | ✓                | –              | –            | ✓     |
| `benchmark` + `blink.user_timing`                                                                                                                             | 974KB      | 4,194  | ✓                | –              | ✓            | ✓     |
| `cc` + `blink.user_timing`                                                                                                                                    | 851KB      | 3,888  | ✓                | –              | ✓            | ✓     |
| `…timeline.frame` + `input` + `blink.user_timing`                                                                                                             | 633KB      | 2,928  | ✓                | –              | ✓            | ✓     |
| `…timeline.frame` + `devtools.timeline` + `blink.user_timing`                                                                                                 | **368KB**  | 1,350  | ✓                | ✓              | –            | ✓     |
| `devtools.timeline` + `blink.user_timing`                                                                                                                     | 188KB      | 604    | –                | ✓              | –            | ✓     |

The events the library uses come from these categories:

- `PipelineReporter` gives each frame's state. It's tagged `cc,benchmark,disabled-by-default-devtools.timeline.frame`, so it's recorded when any of those three is on, and `…timeline.frame` is by far the smallest of them.
- `AnimationFrame` gives the duration of every main-thread frame, and is in `devtools.timeline`.
- `performance.mark()` calls are in `blink.user_timing`. Each mark's `args.data.startTime` is its `performance.now()` value, so the marks line the trace up exactly with the page's clock.
- `EventLatency` is in `cc,benchmark,input,input.scrolling`. The detection suite used it to find when input started, but the library doesn't need it, because it places its own marks.

The library's sets are defined in `packages/butter-core/src/trace/categories.ts`:

| Use                                                           | Categories                                                         | Size for this interaction                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| Frame states (always in full mode)                            | `disabled-by-default-devtools.timeline.frame`, `blink.user_timing` | 240KB                                             |
| Plus the 120Hz prediction (`refreshRate: 120`)                | + `devtools.timeline`                                              | 368KB                                             |
| Plus the CPU profile (always in full mode)                    | + `disabled-by-default-v8.cpu_profiler`                            | a click: 147KB in total with the frame categories |
| Plus screenshots (`scroll()`'s measured runs, for blank rows) | + `disabled-by-default-devtools.screenshot`                        | 12–22MB per 3.3s fast scroll (measurements.md)    |

The frame-state set is about 9x smaller than the broad set, and records the same frame states.

## Frame counting

The library places `playwright-smoothness:start` and `:end` marks around the measured action, and only counts frames between them. The start mark goes in two animation frames after tracing starts.

The detection suite found a dropped frame about 550ms before the first input in most traces, and worked around it by only counting frames from the first input to shortly after the last. That frame comes from a different compositor (`layer_tree_host_id` 1, frame sequence 5), which belongs to Playwright's initial `about:blank` document. The page under test is `layer_tree_host_id` 2, and the dropped frame falls outside the marks anyway.

A single frame can appear in more than one `PipelineReporter` event:

- Exact repeats, with the same host, source, sequence and state, are counted once.
- A frame reported as both `STATE_PRESENTED_ALL` and `STATE_DROPPED` counts as both. The compositor presented the scroll, but the blocked main thread missed its update. That's how a blocked scroll handler appears in the trace: 25ms of blocking drops 2 frames in the scroll-blocking table in [measurements.md](measurements.md). Counting the pair as only presented would hide it.

Only frames from the page's own renderer process count, identified by the process the start mark came from. The browser process presents frames too, and after a reload it presents one inside the measurement window in every run, which would add one to `onTime`. Out-of-process iframes are separate documents, so their frames aren't counted, and the result notes that they were there.

`frames.total` is presented plus dropped. Frames marked `STATE_NO_UPDATE_DESIRED` had nothing to show and aren't counted. When no frame had an update, `onTimePercent` is `null`, not 100.

## Tracing overhead

`tests/integration/tracing-overhead.spec.ts` measures the same interactions on the same page in quick mode and full mode, 5 runs each, with 4x CPU throttling:

| Interaction          | Long frames (quick / full) | Worst frame     | Input-to-paint p95 | Wall time per measure() |
| -------------------- | -------------------------- | --------------- | ------------------ | ----------------------- |
| Click, 150ms handler | 1 / 1                      | 152.8 / 152.8ms | 152 / 160ms        | 4.7s / 4.8s             |
| Typing, 60ms keydown | 3 / 3                      | 64.3 / 65.0ms   | 64 / 64ms          | 6.5s / 6.5s             |
| Scroll, 70ms handler | 5 / 5                      | 87.2 / 87.7ms   | n/a / n/a          | 6.9s / 7.2s             |

Before the CPU profiler was added, tracing with these categories didn't change the measurements. Long-frame counts were identical, worst frames were within 0.7ms, and input-to-paint was within one Event Timing step (8ms), which is under the 16ms floor. Wall time rose 1–4%. The integration test asserts this on every CI run.

The test was run again after the profiler was added. The counts still matched (1 / 1, 3 / 3, 5 / 5), worst frames were within 1.8ms and p95 was identical, while wall time per `measure()` rose 6–13% locally instead of 1–4%. On GitHub Actions (PR #4), the counts and p95 were again identical in both modes, and wall time rose 7–22% (a single click went from 4.96s to 6.06s). The profiler samples the main thread about every 140µs, which adds a little time around the interaction without changing what's measured.

Baselines are keyed by mode, so a full-mode run is never compared with a quick-mode baseline. The numbers the two modes share agree anyway, so separate baselines for each mode are all that's needed.
