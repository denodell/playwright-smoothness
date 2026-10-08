# Mode detection

Quick mode measures with Event Timing and Long Animation Frames. Full mode adds a Chrome trace for dropped frames and screenshots for blank rows in lists. Full mode is slower and produces large traces, so the default is quick mode on pull requests and full mode on scheduled runs.

## Rules

The first rule that applies wins:

1. The `mode` option, from `test.use({ butterOptions: { mode } })`, the config's `use`, or a per-call override such as `butter.measure(label, fn, { mode: 'full' })`.
2. `SMOOTHNESS_MODE`, set to `quick` or `full` (case-insensitive). Any other value is an error, so a typo can't silently pick a mode.
3. A scheduled CI run gets `full`:

   | CI provider     | Variable                         | Value                |
   | --------------- | -------------------------------- | -------------------- |
   | GitHub Actions  | `GITHUB_EVENT_NAME`              | `schedule`           |
   | GitLab CI       | `CI_PIPELINE_SOURCE`             | `schedule`           |
   | Azure Pipelines | `BUILD_REASON`                   | `Schedule`           |
   | CircleCI        | `CIRCLE_PIPELINE_TRIGGER_SOURCE` | `scheduled_pipeline` |

4. Otherwise `quick`.

Every result records the chosen mode as `mode`, and the rule that chose it as `settings.modeSource`.

The rules are implemented in `packages/butter-core/src/options.ts` (`detectMode`) and tested in `tests/unit/options.spec.ts`.
