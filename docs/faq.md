# Before you adopt it

These are the questions teams usually ask before adding a performance check to their test suite. The numbers come from this repository's own measurements and CI.

## Time added to a suite

Checks only run where you add them, and you decide how long each one takes.

| What (measured on a Mac; times scale with the machine) | Time                                 |
| ------------------------------------------------------ | ------------------------------------ |
| A plain click, for comparison                          | 0.1s                                 |
| `measure()` on a click, defaults (warm-up + 5 runs)    | 3.9s                                 |
| `measure()` on a click, `runs: 1`                      | 0.7s                                 |
| `measure()` in full mode (tracing, CPU profile)        | 4.2s                                 |
| `scroll()` 20,000px at `'fast'`, 5 runs                | 26s                                  |
| Automatic mode (`withButter`), per test                | about 0.1s: no reruns, no throttling |

Each run reloads the page and waits for it to settle, so a check takes roughly `runs + 1` times as long as the action plus a reload. `runs`, `speed` and `distance` all change that. A common setup is automatic mode on every test, plus a handful of explicit `measure()` and `scroll()` checks for the interactions you care about most.

## Noisy CI runners

A noisy runner is unlikely to fail your build, for four reasons:

- Checks only warn until you set `enforce: 'fail'` ([warn first, then fail](../README.md#warn-first-then-fail)). A check can move to `'fail'` once `calibrate` shows it's steady on your runner.
- A check has to get worse by more than `maxIncrease` _and_ by more than a small floor, so one Event Timing rounding step or one extra frame can't fail it ([results](../README.md#results)).
- Results are only compared on the same CPU model. On a model with no baseline, the check reports "not compared" instead of guessing ([CI guide](ci.md#use-a-dedicated-runner-if-you-can)).
- `npx playwright-butter calibrate` runs your suite several times on unchanged code and tells you the `maxIncrease` each check needs.

Within one CI job, results on GitHub's runners varied by about ±2% from run to run ([measurements.md](measurements.md)).

## Requirements

- Node 20 or later, and `@playwright/test` 1.49 or later. CI runs the suite on 1.49 and on the current version.
- Playwright Test (the `@playwright/test` runner). The bare `playwright` library isn't enough.
- Chromium, which a Playwright project already has. New headless (`channel: 'chromium'`) is the one to run.
- No third-party runtime dependencies. `playwright-butter` and the `butter-core` package it depends on are about 300KB together.
- Memory: 30–50MB in the test worker for a full-mode `scroll()` with a replay. The same check still passes with the worker's heap capped at 90MB. Full mode briefly opens a second page in the browser while it analyzes screenshots.
- Disk: a result file of about 3KB per check, baselines and histories of a few KB each, and a replay video (a few hundred KB) only when a full-mode check gets worse. Traces are never written to disk.

## Operating systems

It runs on Linux, macOS and Windows. CI runs the unit and integration suites on Ubuntu and Windows, and development happens on macOS.

Linux is the steadier choice for the machine that gates, because Chrome's CPU throttling spaces timers irregularly on Windows. On a GitHub Actions Windows runner, a 100ms `setInterval` fired at gaps of up to 588ms, while a Linux runner kept a 250ms interval to within a millisecond of schedule. Pages driven by timers measure less steadily on Windows as a result.

On one Windows CI run, Chrome didn't apply CPU throttling at all: 4x left the work almost unslowed, where it applied fully in 10 other runs. Every `measure()` and `scroll()` now checks that throttling slowed a fixed loop, and says so in the result when it didn't.

## Chromium only

The signals it relies on come from Chromium: Long Animation Frames, the Event Timing details it needs, Chrome's frame-level trace, and `Emulation.setCPUThrottlingRate`. In Firefox and WebKit projects, checks are skipped with a `smoothness-skipped` annotation and `null` results. They're never reported as zero or as passing.

## Network access and privacy

There's no telemetry, and the library makes no network requests of its own. The only fetches are for source maps, to name minified functions in full mode's CPU profile. They go through the page's own request context, to the same servers your page already loads its scripts from. The reporter writes a Markdown file, and posting it to a pull request is up to your workflow.

## Lighthouse, Web Vitals and RUM

- Lighthouse measures a page load in a lab. `playwright-butter` measures the interactions your tests perform: clicks, typing, and scrolling a list.
- RUM and INP in the field tell you about real users on real devices, after the change has shipped. `playwright-butter` catches the regression in the pull request that causes it, and names the element and the code responsible.
- Blank rows in a virtualized list don't show up as dropped frames or as slow INP. `scroll()` measures them from screenshots.

Field data still tells you what real users see after a release, while this check runs before the merge.

## Headless Chrome and real phones

A CI server running headless Chrome is a long way from your users' phones. The CPU is slowed 4x by default so that moderate jank shows up on fast hardware, and the numbers are compared with your own baseline on the same kind of machine, instead of with an absolute target. A lab can reliably tell you whether a change made an interaction slower. How fast it is on real phones is a question for field data.

## Framework support

The measurements come from the browser, so they work the same whichever framework rendered the page. React and Angular (with Zone.js and zoneless) are tested. [frameworks.md](frameworks.md) covers how the reports name your handler when a framework's event dispatcher sits in front of it.

## Chrome updates

Chrome's trace format is internal and it does change: Chrome 131 and Chrome 153 name one of the trace fields differently, and the library reads both. A scheduled workflow runs the suite against the newest Playwright and Chromium every night. When a measurement can't be taken, the result lists it under `unavailable` with the reason. The JSON result is versioned (`schemaVersion: 1`), and the API follows semantic versioning.

## Trying it out

Automatic mode is one line in your fixtures file, and your tests stay as they are ([automatic mode](automatic-mode.md)). With the default `enforce: 'warn'` it fails nothing: anything that got worse gets an annotation, and the reporter shows every test's numbers. Removing the line turns it off again.
