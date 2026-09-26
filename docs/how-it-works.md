# How it works

The design decisions behind the numbers: which browser signals are used and why, how a frame is judged to be an interaction's work, and how results are compared with baselines. The evidence for each decision is in [measurements.md](measurements.md).

## The signals, and what each can't see

| Source                       | What it gives                                                                                                                                                   | Limits                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long Animation Frames (LoAF) | Frames over 50ms, with `blockingDuration`, `firstUIEventTimestamp`, and the scripts that ran (invoker, source, function, start time, duration)                  | The 50ms threshold is fixed by the spec, and `durationThreshold` is ignored. In practice it catches about 40ms or more of script, since rendering adds to the frame. |
| Event Timing                 | Each input's time to the next paint, with `interactionId` and `target`                                                                                          | 16ms minimum threshold, durations in 8ms steps. Covers clicks, taps, keys and pointer events, but not scrolling or wheel events.                                     |
| Chrome trace (full mode)     | Every compositor frame's state (presented, partly presented, dropped, no update), every main-thread frame's duration, the V8 CPU profile, per-frame screenshots | Internal format, Chromium only. Large with screenshots (12–22MB per fling), so each trace is parsed and dropped straight away.                                       |

`requestAnimationFrame` sampling isn't used. rAF timestamps under-report, because a late frame keeps its scheduled time. `performance.now()` inside rAF over-reports, because a late callback doesn't mean a dropped frame. Scrolling runs on the compositor thread, so a blocked main thread drops far fewer frames than LoAF suggests. The trace is the only accurate source for dropped frames (the scroll-blocking table in [measurements.md](measurements.md)).

The in-page collector wraps every observer callback and every per-entry step in its own `try`/`catch`, because an exception inside a callback silently drops the rest of that batch. Records are plain numbers and strings: element targets are described while the callback runs. Anything that couldn't be measured is reported in the result's `unavailable` list, never thrown.

## One measurement

1. The CPU is slowed 4x by default (`Emulation.setCPUThrottlingRate`). On a fast machine, moderate jank produces no long frames at all without it.
2. One warm-up run is made first and discarded, because the first input on a page can cost a slow frame with no page work at all.
3. Before each run the page is reset (reloaded by default, or left as it is with `'none'`, or put back by your own function), and the library waits until the page has loaded and no long frame has ended for 500ms, for up to 5 seconds. A page that never goes quiet gets a note, not a failure.
4. The action runs between two `performance.mark()` calls. Full mode counts trace frames only between those marks, and only from the page's own renderer process, which also leaves out Playwright's initial `about:blank` compositor ([trace-categories.md](trace-categories.md)).
5. The result is the median of 5 runs. Single runs have few frames, so one stray pair of drops moves a run a lot.

## Which frames are an interaction's work

Every long frame is classified as interaction, load or background, with no labels from the test. In order:

1. A frame made only of `setInterval` callbacks is never an interaction frame. An interval timer can fire inside a click's window (between the handler and the paint, especially under throttling), but it runs on a fixed schedule whatever the user does. Work a handler triggers uses `setTimeout`, `requestAnimationFrame` or promises.
2. It handled an input (`firstUIEventTimestamp > 0`): an interaction frame if the input was already waiting when the frame started, or if some script in it ran after the input arrived.
3. It started during an Event Timing interaction (2ms tolerance for rounding). Overlap isn't enough: a background frame already running when a click arrived delayed the input, and input-to-paint already includes that delay. Counting it as a long frame too would make the check depend on the timer's phase.
4. A scroll event fired during it.
5. It started before load finished, plus 50ms: load.
6. An `event-listener` script ran in it (a secondary signal for input the other rules missed).
7. Otherwise, background.

Scripts are attributed one at a time, not a whole frame at once. Within an interaction frame, a script that started before the input arrived (a timer the click interrupted) isn't blamed, and its share of the frame is dropped. Each script the report names lists the interactions it blocked (`during`), because behind a framework's dispatcher LoAF names the dispatcher, not your handler ([frameworks.md](frameworks.md)).

Event Timing reports the element actually clicked, which is often a `span` inside a button, so the library walks up to the nearest `button, a, input, select, textarea, [role], [tabindex]`. An element that removes itself leaves the target null; the LoAF script invoker (for example `BUTTON#vanish.onclick`) is used instead.

## Frames in full mode

- A frame reported both presented and dropped counts as both. That's how a blocked main thread shows while the compositor keeps scrolling.
- `frames.onTimePercent` is null when no frame had an update, rather than 100.
- The CPU profile is read only from the thread the start mark came from (the page's main thread), so workers never appear.

## Comparing with a baseline

- The key is label, test title, project, platform, mode, refresh rate, CPU throttling and CPU model. Renaming a test starts a fresh baseline. Hosted runners differ up to 1.5x in speed between CPU models, so a baseline from another model is never compared; the result lists the models that have one.
- Floors stop a zero or tiny baseline from turning one extra frame into an infinite increase: 16ms input-to-paint (two Event Timing steps, so one rounding step can't trip it), 1 long frame, and 1 percentage point for on-time and blank-frame percentages.
- Percentages are compared on the bad share: `frames.onTimePercent` is compared as 100 − value, so 95% → 81% on time can't hide inside a 15% relative allowance.
- Total blocking time is reported but only gated with `gateTotalBlocking: true`, because it's the noisiest number.
- Warn mode passes the test, adds a `smoothness-warning` annotation, prints the full report, and in GitHub Actions prints a `::warning` on the test's line. It doesn't use `expect.soft`, which fails the test.
- While calibrating (`SMOOTHNESS_CALIBRATE=1`, set by the CLI), nothing is compared or written. Calibrate measures the run-to-run variation of the medians, which is what a baseline comparison actually meets, and suggests the smallest 0.05 step above the worst case.
