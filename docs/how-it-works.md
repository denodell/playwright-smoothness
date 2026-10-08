# How it works

This page covers the design decisions behind the numbers: which browser signals the library uses and why, how it decides that a frame is an interaction's work, and how it compares results with baselines. The evidence for each decision is in [measurements.md](measurements.md).

## Browser signals and their limits

| Source                       | What it gives                                                                                                                                                   | Limits                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long Animation Frames (LoAF) | Frames over 50ms, with `blockingDuration`, `firstUIEventTimestamp`, and the scripts that ran (invoker, source, function, start time, duration)                  | The 50ms threshold is fixed by the spec, and `durationThreshold` is ignored. In practice it catches about 40ms or more of script, since rendering adds to the frame. |
| Event Timing                 | Each input's time to the next paint, with `interactionId` and `target`                                                                                          | 16ms minimum threshold, durations in 8ms steps. Covers clicks, taps, keys and pointer events, but not scrolling or wheel events.                                     |
| Chrome trace (full mode)     | Every compositor frame's state (presented, partly presented, dropped, no update), every main-thread frame's duration, the V8 CPU profile, per-frame screenshots | Internal format, Chromium only. Large with screenshots (12–22MB per fast scroll), so each trace is parsed and dropped straight away.                                 |

The library doesn't sample `requestAnimationFrame`. rAF timestamps under-report, because a late frame keeps its scheduled time, and `performance.now()` inside a rAF callback over-reports, because a late callback doesn't always mean a dropped frame. Scrolling runs on the compositor thread, so a blocked main thread drops far fewer frames than LoAF suggests. The trace is the only accurate source for dropped frames, as the scroll-blocking table in [measurements.md](measurements.md) shows.

The in-page collector wraps every observer callback, and each step that handles an entry, in its own `try`/`catch`, because an exception inside a callback silently drops the rest of that batch. It records plain numbers and strings, and describes element targets while the callback is still running. Anything it couldn't measure goes in the result's `unavailable` list instead of being thrown.

## Steps in one measurement

1. The CPU is slowed 4x by default with `Emulation.setCPUThrottlingRate`. Without it, moderate jank on a fast machine produces no long frames at all.
2. A warm-up run is made first and discarded, because the first input on a page can take a slow frame even when the page does no work.
3. Before each run the page is reset: reloaded by default, left as it is with `'none'`, or put back by your own function. The library then waits, for up to 5 seconds, until the page has loaded and no long frame has ended for 500ms. A page that never goes quiet gets a note instead of a failure.
4. The action runs between two `performance.mark()` calls. Full mode only counts trace frames between those marks, and only from the page's own renderer process, which also leaves out the compositor for Playwright's initial `about:blank` page ([trace-categories.md](trace-categories.md)).
5. The result is the median of the runs. A single run has few frames, so one stray pair of drops can move it a lot.

## Classify long frames

The library sorts every long frame into interaction, load or background work, without any labels from the test. It applies these rules in order:

1. A frame made only of `setInterval` callbacks is never an interaction frame. An interval timer can fire inside a click's window (between the handler and the paint, especially under throttling), but it runs on a fixed schedule whatever the user does. Work that a handler starts uses `setTimeout`, `requestAnimationFrame` or promises.
2. If the frame handled an input (`firstUIEventTimestamp > 0`), it's an interaction frame when the input was already waiting as the frame started, or when some script in it ran after the input arrived.
3. If the frame started during an Event Timing interaction (with 2ms of tolerance for rounding), it's an interaction frame. Overlapping the interaction isn't enough. A background frame that was already running when a click arrived delayed the input, and input-to-paint already includes that delay. Counting the frame as a long frame as well would make the check depend on where the timer happened to fall.
4. If a scroll event fired during the frame, it's an interaction frame.
5. If the frame started before load finished, or within 50ms after, it's load.
6. If an `event-listener` script ran in the frame, it's an interaction frame. This is a secondary signal that catches input the other rules missed.
7. Anything left is background.

Blame is given to one script at a time, rather than to a whole frame. Inside an interaction frame, a script that started before the input arrived (a timer the click interrupted) isn't blamed, and its share of the frame is dropped. Each script in the report lists the interactions it blocked (`during`), because when a framework dispatches events, LoAF names the dispatcher and not your handler ([frameworks.md](frameworks.md)).

Event Timing reports the element that was actually clicked, which is often a `span` inside a button. The library walks up from it to the nearest `button, a, input, select, textarea, [role], [tabindex]`. When an element removes itself, the target is null, and the library uses the LoAF script invoker instead (for example `BUTTON#vanish.onclick`).

## Full-mode frame counting

- A frame that the trace reports as both presented and dropped counts as both. That's how a blocked main thread shows up while the compositor keeps scrolling.
- `frames.onTimePercent` is null, rather than 100, when no frame had an update.
- The CPU profile is only read from the thread the start mark came from (the page's main thread), so workers never appear in it.

## Baseline comparison

- The baseline key is listed in the [README](../README.md#baselines). A baseline from a different CPU model is never compared, because hosted runners of different models differ by up to 1.5x in speed ([measurements.md](measurements.md#noise-on-github-actions)). The result lists the models that do have a baseline.
- The floors stop a zero or tiny baseline from turning one extra frame into an infinite increase. The 16ms input-to-paint floor is two Event Timing steps, so a single rounding step can't trip it.
- Percentages are compared on the bad share. `frames.onTimePercent` is compared as 100 − value, so a fall from 95% to 81% on time can't hide inside a 15% relative allowance.
- Total blocking time is only gated with `gateTotalBlocking: true` because it's the noisiest number.
- Warn mode doesn't use `expect.soft`, because a soft assertion still fails the test.
- While calibrating (`SMOOTHNESS_CALIBRATE=1`, which the CLI sets), nothing is compared or written. Calibrate measures how much the medians vary from run to run, since that's the variation a baseline comparison actually sees, and suggests the smallest 0.05 step above the worst case.

## Packages and the driver interface

The repository publishes two packages. `butter-core` is the measuring engine, and it doesn't depend on Playwright. It talks to the browser through a small interface in `packages/butter-core/src/driver.ts`. The interface covers running a function in the page, adding an init script, reloading, a CDP session and its events, screenshots, tracing, a click, a key press, fetching a source map, and opening a scratch page for image work and replay encoding. A list to scroll is an element target with its own `evaluate`, `scrollIntoView` and `focus`.

`playwright-butter` implements that interface for a Playwright page and locator (`packages/playwright-butter/src/driver.ts`). It also adds the Playwright Test parts: the fixture, `toBeSmooth()`, automatic mode, the reporter and the `calibrate` CLI. A lint rule stops core from importing Playwright, so another library such as Puppeteer can drive the same engine with its own adapter. The engine still needs Chromium, because it relies on the Chrome DevTools Protocol and Chrome's trace events.
