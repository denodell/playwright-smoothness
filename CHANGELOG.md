# playwright-smoothness

## 1.0.0

The first release. The public API — the `smoothness` fixture with `measure()` and `scroll()`, `smoothnessOptions`, `toBeSmooth()`, `withSmoothness()`, the reporter, the `calibrate` command, and the JSON result format (`schemaVersion: 1`) — follows semantic versioning from here.

### Measuring

- **`smoothness.measure(label, action)`**, quick mode: input-to-paint from Event Timing and long frames from the Long Animation Frames API, with the scripts responsible. It uses 4x CPU throttling, a warm-up run, and 5 reloaded and settled runs, and reports medians. Frames from page loads and background timers are identified and left out. Every script is linked to the interactions it blocked (`during: ['click on button#checkout']`), which works behind framework dispatchers.
- **Full mode** (`mode: 'full'`, the default on scheduled CI runs): each run is traced with a minimal category set (about 240KB per interaction) and windowed by in-page marks. It adds `frames` (on-time and dropped frames from Chrome's frame reporter, counted only for the page's own renderer process), `profile.hotFunctions` from V8's sampling profiler (it names your handler behind React and Angular dispatchers, and maps minified names back through source maps), and, with `refreshRate: 120`, a reported-only `budget120` prediction.
- **`smoothness.scroll(locator, options)`** for lists: wheel (compositor-driven gestures), touch (real touch-event flicks; needs `hasTouch`), or arrow keys, vertically or horizontally, at named or numeric speeds. In full mode it detects **blank frames** from the trace's screenshots (`list.blankFramePercent`, gated, and `list.leastDrawnPercent`), with `list.background` and `list.placeholders` to say what counts as blank.
- **Automatic mode**: `withSmoothness(base, { auto: true })` in a fixtures file measures every test that opens a page, once, across navigations, with no changes to the tests. It compares against the median of the test's recent passing runs on the main branch; editing a spec file restarts its history.

### Comparing

- **`toBeSmooth()`** compares with a stored baseline, never a fixed number. Baselines are keyed by label, test, project, platform, mode, refresh rate, CPU throttling and CPU model, and `baselineDir` reads baselines from main in CI. A check is worse beyond `maxIncrease` (default 15%), with floors so rounding can't fail it. `enforce: 'warn'` (the default) annotates and adds a GitHub Actions `::warning`; `'fail'` fails the test. Failure messages lead with what got worse and who caused it.
- Nothing unknown is reported as zero: measurements that couldn't be taken are `null` and listed in `unavailable`, with a reason.

### Reporting and tuning

- **`playwright-smoothness/reporter`** writes a markdown summary for pull requests (and the GitHub Actions job summary).
- **`npx playwright-smoothness calibrate`** runs the suite several times on unchanged code and suggests a `maxIncrease` per check.
