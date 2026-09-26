# Before you adopt it

These are the questions teams usually ask before adding a performance check to their test suite. The numbers come from this repository's own measurements and CI.

## Time it adds to your suite

It only measures where you ask it to, and you decide how long each check takes.

| What (measured on a Mac; times scale with the machine) | Time                                 |
| ------------------------------------------------------ | ------------------------------------ |
| A plain click, for comparison                          | 0.1s                                 |
| `measure()` on a click, defaults (warm-up + 5 runs)    | 3.9s                                 |
| `measure()` on a click, `runs: 1`                      | 0.7s                                 |
| `measure()` in full mode (tracing, CPU profile)        | 4.2s                                 |
| `scroll()` 20,000px at `'fast'`, 5 runs                | 26s                                  |
| Automatic mode (`withSmoothness`), per test            | about 0.1s: no reruns, no throttling |

Each run reloads the page and waits for it to settle, so a check takes roughly `runs + 1` times as long as the action plus a reload. `runs`, `speed` and `distance` change how long a check takes. A common setup is automatic mode on every test, plus a handful of explicit `measure()` and `scroll()` checks for the interactions you care about most.

## Flaky CI

Several parts of the design keep a noisy runner from failing your build:

- **It warns by default.** `enforce: 'warn'` passes the test and adds an annotation (and a `::warning` in GitHub Actions). A check moves to `'fail'` once `calibrate` shows it's steady on your runner.
- **It compares medians, with floors.** A check has to get worse by more than `maxIncrease` (15%) _and_ by more than a floor (16ms of input delay, 1 long frame, 1 percentage point), so one Event Timing rounding step or one extra frame can't fail it.
- **It only compares results from the same CPU model.** GitHub's hosted runners differ by up to 1.5x between models. On a model with no baseline, the check reports "not compared" instead of guessing.
- **It measures its own noise.** `npx playwright-smoothness calibrate` runs your suite several times on unchanged code and tells you the `maxIncrease` each check needs.

Within one CI job, results on GitHub's runners varied by about ±2% from run to run ([measurements.md](measurements.md)).

## Requirements

- Node 20 or later, and `@playwright/test` 1.49 or later. CI runs the suite on 1.49 and on the current version.
- Chromium, which a Playwright project already has. New headless (`channel: 'chromium'`) is the one to run.
- **No runtime dependencies.** The package is about 270KB.
- **Memory:** 30–50MB in the test worker for a full-mode `scroll()` with a replay. The same check still passes with the worker's heap capped at 90MB. Full mode briefly opens a second page in the browser while it analyzes screenshots.
- **Disk:** a result file of about 3KB per check, baselines and histories of a few KB each, and a replay video (about 430KB) only when a `scroll()` check gets worse. Traces are never written to disk.

## Operating systems

Linux, macOS and Windows. CI runs the unit and integration suites on Ubuntu and Windows, and development happens on macOS.

## Chromium only

The signals it relies on (Long Animation Frames, the Event Timing details it needs, Chrome's frame-level trace, and `Emulation.setCPUThrottlingRate`) come from Chromium. In Firefox and WebKit projects, checks are skipped with a `smoothness-skipped` annotation and `null` results. They're never reported as zero or as passing.

## Network access and privacy

There's no telemetry, and the library makes no network requests of its own. The only fetches are for source maps, to name minified functions in full mode's CPU profile. They go through the page's own request context, to the same servers your page already loads its scripts from. The reporter writes a Markdown file, and posting it to a pull request is up to your workflow.

## Lighthouse, Web Vitals and RUM

Each of these answers a different question:

- **Lighthouse** measures a page load in a lab. `playwright-smoothness` measures the interactions your tests perform: clicks, typing, and scrolling a list.
- **RUM and INP in the field** tell you about real users on real devices, after the change has shipped. `playwright-smoothness` catches the regression in the pull request that causes it, and names the element and the code responsible.
- **Blank rows** in a virtualized list don't show up as dropped frames or as slow INP. `scroll()` measures them from screenshots.

Field data still tells you what real users see after a release. This check runs before the merge.

## Headless Chrome and real phones

A CI server running headless Chrome is a long way from your users' phones. The CPU is slowed 4x by default so that moderate jank shows up on fast hardware, and the numbers are compared with your own baseline on the same kind of machine, not with an absolute target. A lab can reliably tell you whether a change made an interaction slower. How fast it is on real phones is a question for field data.

## Changes to your tests

Automatic mode is one line in your fixtures file (`withSmoothness(base, { auto: true })`), and your tests stay as they are. An explicit check wraps an action in `smoothness.measure()` and adds `expect(result).toBeSmooth()`. Both need Playwright Test (the `@playwright/test` runner), not the bare `playwright` library.

## Framework support

The measurements come from the browser, so they work the same whichever framework rendered the page. React and Angular (with Zone.js and zoneless) are tested. Behind a framework's event dispatcher, Long Animation Frames names the dispatcher instead of your handler, so reports lead with the element ("click on `button#checkout`: 180ms"). Full mode's CPU profile names your actual handler, through source maps when the build is minified ([frameworks.md](frameworks.md)).

## Chrome updates

Chrome's trace format is internal and it does change: Chrome 131 and Chrome 153 name one of the trace fields differently, and the library reads both. A scheduled workflow runs the suite against the newest Playwright and Chromium every night. When a measurement can't be taken, the result lists it under `unavailable` with the reason, and it's never reported as zero. The JSON result is versioned (`schemaVersion: 1`), and the API follows semantic versioning.

## Trying it out

Automatic mode with the default `enforce: 'warn'` fails nothing. Anything that got worse gets an annotation, and the reporter shows every test's numbers. Removing the one line from your fixtures file turns it off again.
