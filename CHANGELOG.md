# playwright-smoothness

## 1.0.0

The first release. From here, the public API and the JSON result format (`schemaVersion: 1`) follow semantic versioning. The public API is the `smoothness` fixture with `measure()` and `scroll()`, `smoothnessOptions`, `toBeSmooth()`, `withSmoothness()`, the reporter and the `calibrate` command.

### Measuring

- `smoothness.measure(label, action)` measures input-to-paint time with Event Timing and long frames with the Long Animation Frames API, and names the scripts that ran in them. It slows the CPU 4x, makes a warm-up run, and reports the median of 5 reloaded runs. Frames from page loads and background timers are left out, and each script lists the interactions it blocked, which names the right element even behind a framework's dispatcher.
- Full mode (`mode: 'full'`, the default on scheduled CI runs) also traces each run. It adds on-time and dropped frames from Chrome's frame reporter, the hottest functions from V8's sampling profiler (mapped back through source maps when the build is minified), and, with `refreshRate: 120`, a 120Hz prediction that's reported but never gated.
- `smoothness.scroll(locator, options)` scrolls a list by mouse wheel, touch or arrow keys, in either direction, at a named or numeric speed, to a pixel distance or to the end of the list (at most 20,000px). In full mode it measures blank frames from the trace's screenshots, with `list.background` and `list.placeholders` to say what counts as blank.
- `withSmoothness(base, { auto: true })` in a fixtures file measures every test that opens a page, once, across navigations, without changing the tests. Each test is compared with the median of its recent passing runs on the main branch, and editing a spec file starts its history again.

### Comparing

- `toBeSmooth()` compares a result with its stored baseline. Baselines are keyed by label, test, project, platform, mode, refresh rate, CPU throttling and CPU model, and `baselineDir` reads baselines from the main branch in CI. A check gets worse when it passes `maxIncrease` (15% by default) and a small floor, so rounding can't fail it. By default it warns, with an annotation and a GitHub Actions `::warning`; `enforce: 'fail'` fails the test instead. Failure messages start with what got worse and the scripts that did it.
- A measurement that couldn't be taken is `null` and listed in `unavailable` with the reason.

### Reporting and tuning

- `playwright-smoothness/reporter` writes a Markdown summary for pull requests, and adds it to the GitHub Actions job summary.
- When a full-mode `scroll()` check gets worse, a WebM replay of the scroll is attached to the test. It plays 4× slower than real time and marks the blank frames (`replay: 'on-regression' | 'on' | 'off'`).
- `npx playwright-smoothness calibrate` runs the suite several times on unchanged code and suggests a `maxIncrease` for each check.
