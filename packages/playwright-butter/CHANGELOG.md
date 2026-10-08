# playwright-butter

## 1.0.0

The first release. The public API and the JSON result format (`schemaVersion: 1`) follow semantic versioning from here. The public API is the `smoothness` fixture with `measure()` and `scroll()`, `smoothnessOptions`, `toBeSmooth()` and its budgets, `withSmoothness()`, the reporter, the `calibrate`, `summary`, `brief` and `init-agents` commands, and the GitHub Action. The measuring engine is published separately as [`smoothness-core`](https://github.com/denodell/playwright-smoothness/tree/main/packages/smoothness-core), which this package depends on at the same version.

### Measuring

- `smoothness.measure(label, action)` measures input-to-paint time with Event Timing, and long frames with the Long Animation Frames API, naming the scripts that ran in them. It slows the CPU 4x, makes a warm-up run, and reports the median of 5 reloaded runs. Frames from page loads and background timers are left out. Each script lists the interactions it blocked, which names the right element even behind a framework's event dispatcher.
- Full mode (`mode: 'full'`, the default on scheduled CI runs) also traces each run. It adds on-time and dropped frames from Chrome's frame reporter and the hottest functions from V8's sampling profiler, mapped back through source maps when the build is minified. With `refreshRate: 120` it adds a 120Hz prediction that's reported but never gated.
- `smoothness.scroll(locator, options)` scrolls a list by mouse wheel, touch or arrow keys, in either direction, at a named or numeric speed, to a pixel distance or to the end of the list (at most 20,000px). In full mode it counts blank frames from the trace's screenshots, with `list.background` and `list.placeholders` to say what counts as blank. Blank frames are only gated on a virtualized list, which is detected while scrolling (`list.virtualized`). Every run starts from the same place, with the browser's scroll restoration turned off while it runs, and the result notes any run that didn't.
- `withSmoothness(base, { auto: true })` in a fixtures file measures every test that opens a page, once, across navigations, without changing the tests. Each test is compared with the median of its recent passing runs on the main branch, and editing a spec file starts its history again.
- Pages a test opens itself are measured too: automatic mode follows every context a test creates with `browser.newPage()` or `browser.newContext()`, `measure()` takes a `page` option, and `scroll()` measures the page its locator is on.
- Elements are named without the ids frameworks generate on each load, such as React's `:r0:`. A control whose only id is generated is named by its text, such as `button:has-text("Filter")`, and scripts are grouped across runs the same way.

### Comparing

- `toBeSmooth()` compares a result with its stored baseline. Baselines are keyed by label, test, project, platform, mode, refresh rate, CPU throttling and CPU model, and `baselineDir` (or the `SMOOTHNESS_BASELINE_DIR` environment variable) reads the main branch's baselines in CI. A check gets worse when it grows past `maxIncrease` (15% by default) and a small floor, so rounding can't fail it. By default it warns, with an annotation and a GitHub Actions `::warning`, and `enforce: 'fail'` fails the test instead. Failure messages start with what got worse and the scripts responsible.
- `toBeSmooth({ budget })` adds fixed limits that are checked on every run, including the first: `maxInputToPaintMs`, `maxLongFrames`, `minOnTimePercent` and `maxBlankFramePercent`. A missed budget fails the test whatever `enforce` says, and so does a budget that couldn't be checked.
- A measurement that couldn't be taken is `null`, and its reason is listed in `unavailable`. An interaction too quick for Event Timing to report (under 16ms) passes, shown as `under 16ms`.

### Reporting and fixing

- `playwright-smoothness/reporter` writes a Markdown summary for pull requests, and adds it to the GitHub Actions job summary. Baselines re-recorded with `--update-snapshots` are counted as re-recorded, with what changed against the old one. `npx playwright-smoothness summary` writes the same summary from a run's result files, for runs without the reporter.
- When a full-mode `measure()` or `scroll()` check gets worse, a WebM replay of one run is attached to the test (`replay: 'on-regression' | 'on' | 'off'`). It plays at a quarter of real speed, and shows the frame rate at each moment beside a chart of it across the run. Each freeze is marked as a band on the chart and tagged with its length while it plays, such as `Frozen 180ms`. On lists, frames where the list is blank are outlined and tagged.
- A check that gets worse or misses its budget writes a fix brief next to its result (`<result>.fix.md`) and attaches it to the test: what got worse, the interactions, scripts and functions behind it with file and line, and the commands to check a fix on the same machine. `npx playwright-smoothness brief` collects a run's briefs into one document for a coding agent.
- `npx playwright-smoothness init-agents` adds a skill that teaches coding agents to fix what the checks find, in `.claude/skills/` and `.agents/skills/` with a pointer in `AGENTS.md`. The skill also ships in the package under `skills/playwright-smoothness/`, where TanStack Intent and skills-npm find it.
- `npx playwright-smoothness calibrate` runs the suite several times on unchanged code and suggests a `maxIncrease` for each check.

### CI

- The GitHub Action, `denodell/playwright-smoothness@v1`, runs the whole setup in one step. Pull requests compare with baselines published from the default branch and get the summary as one comment that each push updates, with the fix briefs folded underneath. Pushes to the default branch record and publish baselines, and automatic mode's history. Scheduled runs use full mode.
