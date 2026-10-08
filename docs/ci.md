# Baselines in CI

A baseline only means something on the machine that gates, so in CI the baselines come from CI runs on your main branch, never from developer laptops:

1. On the main branch, the suite runs with `SMOOTHNESS_RECORD_BASELINES=1`. Each check still compares with the baselines main had, then records this run's result as the new baseline, into the folder `baselineDir` points at. That folder is uploaded as an artifact.
2. On pull requests, the latest artifact from main is downloaded into a folder, and `baselineDir` points at it. Each check then compares against main.

`baselineDir` mirrors your snapshot layout: a baseline at `<snapshotDir>/<path>` is looked for at `<baselineDir>/<path>` first. Baselines are matched on CPU model, so an artifact built on one hosted-runner CPU won't be used on another. Main starts from the previous artifact before recording, so each CPU model's files are kept, and a dedicated runner avoids the problem.

## The GitHub Action, around your test step

Most projects already have a workflow that runs Playwright. Two steps go around the step that runs it, and that step stays as it is:

```yaml
- uses: denodell/playwright-butter/setup@v1
- run: npx playwright test # your step, unchanged
- uses: denodell/playwright-butter/report@v1
  if: always()
```

The job needs `permissions: { contents: read, pull-requests: write, actions: read }`, and the workflow needs to run on pushes to main as well as pull requests, so main records the baselines pull requests compare with. [`examples/github-actions/add-to-existing.yml`](../examples/github-actions/add-to-existing.yml) is a whole workflow.

`setup` downloads main's baselines and sets `SMOOTHNESS_BASELINE_DIR` for the rest of the job, so your config needs no changes. On a push, a schedule or a manual run on the default branch, it also sets `SMOOTHNESS_RECORD_BASELINES=1`. `report` adds the summary to the job summary, posts it on pull requests as one comment that each push updates, with any [fix briefs](../README.md#fix-briefs) folded underneath, and on the default branch publishes the recorded baselines.

| Step     | Input               | Default                | Description                                                                                |
| -------- | ------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `setup`  | `artifact-name`     | `smoothness-baselines` | The name baselines are published under. Two suites in one repository need different names. |
| `setup`  | `token`             | `github.token`         | Needs `actions: read` to fetch baselines.                                                  |
| `report` | `working-directory` | `.`                    | The folder your tests run in, for a monorepo.                                              |
| `report` | `results-dir`       | `test-results`         | Playwright's output directory, relative to the working directory.                          |
| `report` | `comment`           | `true`                 | Post the summary on the pull request.                                                      |
| `report` | `token`             | `github.token`         | Needs `pull-requests: write` to comment.                                                   |

`setup` has a `record` output, `true` when the run records baselines, and `report` has a `summary` output with the summary's path. Uploading results and replays is left to your workflow, since most already upload `test-results` or the Playwright report.

## The GitHub Action on its own

For a new workflow, the Action can run the suite too, in one step:

```yaml
# .github/workflows/smoothness.yml
name: Smoothness
on:
  push: { branches: [main] }
  pull_request:
  schedule: [{ cron: '0 3 * * *' }]
permissions: { contents: read, pull-requests: write, actions: read }
jobs:
  smoothness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - uses: denodell/playwright-butter@v1
```

- **Pull requests** compare with the newest baselines published from your default branch, and get the summary as a comment.
- **Pushes to the default branch** compare with the previous baselines, then record and publish this run's, keeping the ones recorded on other CPU models.
- **Scheduled runs** use full mode, and compare and record the same way.
- **Every run** installs Chromium, adds the summary to the job summary, and uploads results and replays as an artifact. The job fails when the Playwright run fails.

Automatic mode's history is kept in the same artifact, so tests wrapped with `withButter()` need nothing extra either way.

| Input                   | Default                  | Description                                                                                |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `command`               | `npx playwright test`    | How to run the suite.                                                                      |
| `working-directory`     | `.`                      | The folder to run in, for a monorepo.                                                      |
| `results-dir`           | `test-results`           | Playwright's output directory.                                                             |
| `comment`               | `true`                   | Post the summary on the pull request.                                                      |
| `install-browsers`      | `true`                   | Install Chromium and its system dependencies first.                                        |
| `artifact-name`         | `smoothness-baselines`   | The name baselines are published under. Two suites in one repository need different names. |
| `results-artifact-name` | a name unique to the job | The name results and replays are uploaded under.                                           |
| `token`                 | `github.token`           | Needs `actions: read` to fetch baselines and `pull-requests: write` to comment.            |

The Action's outputs are `outcome` (`passed` or `failed`) and `summary` (the summary's path). Pull requests from forks get a read-only token, so they're compared but not commented on, and the summary is still in the job summary. The `snapshot-dir` input from 1.0.0 is no longer used.

## By hand

These are the steps the Action takes, for other CI systems or a workflow of your own.

```yaml
# .github/workflows/smoothness.yml
name: Smoothness
on:
  push:
    branches: [main]
  pull_request:

jobs:
  smoothness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium

      # Start from main's latest baselines, on every branch. On main this keeps other CPU
      # models' baselines, so the artifact accumulates one file per CPU model.
      - uses: dawidd6/action-download-artifact@v6
        continue-on-error: true # the very first run has no artifact yet
        with:
          workflow: smoothness.yml
          branch: main
          name: smoothness-baselines
          path: smoothness-baselines

      - name: 'Pull request: compare with main'
        if: github.event_name == 'pull_request'
        run: npx playwright test
        env:
          SMOOTHNESS_BASELINE_DIR: smoothness-baselines

      - name: 'Main: compare, then record baselines'
        if: github.ref == 'refs/heads/main'
        run: npx playwright test
        env:
          SMOOTHNESS_BASELINE_DIR: smoothness-baselines
          SMOOTHNESS_RECORD_BASELINES: 1

      - name: 'Main: publish baselines'
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with:
          name: smoothness-baselines
          path: smoothness-baselines
          retention-days: 90
```

`SMOOTHNESS_BASELINE_DIR` sets `baselineDir` when the config doesn't, so the config needs no change. `dawidd6/action-download-artifact` is a third-party action, used because GitHub's own `actions/download-artifact` can only read artifacts from the same workflow run.

### Post the summary on the pull request

With the reporter in your config (`reporter: [['list'], ['playwright-butter/reporter']]`), each run adds the smoothness summary to the GitHub Actions job summary. Without it, `npx playwright-butter summary --github-summary` writes the same summary from the run's result files. This step also posts it as a comment on the pull request:

```yaml
- name: 'Pull request: comment with the summary'
  if: github.event_name == 'pull_request' && always()
  env:
    GH_TOKEN: ${{ github.token }}
  run: gh pr comment ${{ github.event.pull_request.number }} --body-file test-results/smoothness/summary.md --edit-last --create-if-none
```

The job needs `permissions: pull-requests: write`. `--edit-last` updates the previous comment, so each push doesn't add a new one.

### Run full mode on a schedule

Scheduled runs use full mode automatically ([mode detection](mode-detection.md)), and full-mode baselines are kept separately from quick-mode ones. Adding a `schedule:` trigger under `on:` is all it takes: a scheduled run on the default branch has `github.ref` set to `refs/heads/main`, so the "Main" step compares with the last scheduled run's baselines, then records, and the artifact carries both quick-mode and full-mode baselines.

## Use a dedicated runner if you can

GitHub's hosted `ubuntu-latest` runners landed on three different AMD EPYC models in this project's CI, with up to 1.5x difference in speed ([measurements.md](measurements.md) has the numbers). The recipe still works on hosted runners, because the artifact collects a baseline per CPU model over time. A pull request that lands on a model with no baseline yet isn't compared, and its result says "No baseline for this machine".

A self-hosted or larger dedicated runner (`runs-on: [self-hosted, linux]`, or a GitHub larger runner) runs every job on the same hardware, so every check is compared every time. The tests measure CPU time, so other work on that machine while they run makes the numbers noisier.

## Recipe tests

`scripts/verify-ci-recipe.sh` runs these steps against `examples/plain-site` on every pull request to this project, in the Examples workflow. It records on "main" with `SMOOTHNESS_RECORD_BASELINES`, runs as a fresh pull request with `baselineDir`, checks that every result was compared against the collected baseline, and checks that a deliberate regression fails. The one step it can't exercise is downloading an artifact from a different workflow run. The same workflow also runs the Action itself against `examples/plain-site`, so pushes to main publish that example's baselines and pull requests fetch them from an earlier run.
