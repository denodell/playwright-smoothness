# How the mode is chosen

`quick` mode measures with Event Timing and Long Animation Frames. `full` mode adds a Chrome trace (dropped frames) and screenshots (blank rows in lists). Full mode is slower and produces large traces, so the default is `quick` on pull requests and `full` on scheduled runs.

The first rule that applies wins:

1. **The `mode` option**, from `test.use({ smoothnessOptions: { mode } })`, the config's `use`, or a per-call override such as `smoothness.measure(label, fn, { mode: 'full' })`.
2. **`SMOOTHNESS_MODE`**, set to `quick` or `full` (case-insensitive). Any other value is an error, so a typo can't silently pick a mode.
3. **A scheduled CI run** gets `full`:

   | CI provider     | Variable                         | Value                |
   | --------------- | -------------------------------- | -------------------- |
   | GitHub Actions  | `GITHUB_EVENT_NAME`              | `schedule`           |
   | GitLab CI       | `CI_PIPELINE_SOURCE`             | `schedule`           |
   | Azure Pipelines | `BUILD_REASON`                   | `Schedule`           |
   | CircleCI        | `CIRCLE_PIPELINE_TRIGGER_SOURCE` | `scheduled_pipeline` |

4. **Otherwise `quick`.**

The chosen mode is in every result as `mode`. The rule that chose it is available as `modeSource` on the resolved options. It's written into the JSON output from M2.

The rules are implemented in `src/options.ts` (`detectMode`) and tested in `tests/unit/options.spec.ts`.
