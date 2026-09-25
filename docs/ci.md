# Baselines in CI

A baseline only means something on the machine that gates, so baselines come from CI, not from developer laptops. The flow:

1. **On the main branch**, run the suite with `--update-snapshots=all`, so every baseline is re-recorded from main, and upload the snapshot files as an artifact.
2. **On pull requests**, download the latest artifact from main into a directory and point `baselineDir` at it. Each check then compares against main.

`baselineDir` mirrors your snapshot layout: a baseline at `<snapshotDir>/<path>` is looked for at `<baselineDir>/<path>` first. Baselines are matched on CPU model, so an artifact built on one hosted-runner CPU won't be used on another. Keep each CPU model's files (step 1 below merges them), or use a dedicated runner.

## GitHub Actions

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

      - name: 'Main: re-record baselines'
        if: github.ref == 'refs/heads/main'
        run: |
          # Keep baselines for other CPU models, then re-record this machine's.
          if [ -d smoothness-baselines ]; then cp -R smoothness-baselines/. tests/; fi
          npx playwright test --update-snapshots=all

      # upload-artifact trims paths to the files' common directory, which would lose the
      # <spec>-snapshots/ part. Copy the baselines into a staging directory with their paths
      # relative to the snapshot directory intact.
      - name: 'Main: collect baselines'
        if: github.ref == 'refs/heads/main'
        run: |
          mkdir -p baselines-out
          # Portable: GNU cp --parents doesn't exist on macOS runners.
          (cd tests && find . -path '*-snapshots/smoothness/*' -type f | while read -r f; do
            mkdir -p "../baselines-out/$(dirname "$f")" && cp "$f" "../baselines-out/$f"
          done)
          test -n "$(find baselines-out -type f)" || { echo 'no baselines were collected'; exit 1; }
      - name: 'Main: publish baselines'
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with:
          name: smoothness-baselines
          path: baselines-out
          retention-days: 90
```

And in `playwright.config.ts` (the type parameter lets `use` accept `smoothnessOptions`):

```ts
import { defineConfig } from '@playwright/test';
import type { SmoothnessTestOptions } from 'playwright-smoothness';

export default defineConfig<SmoothnessTestOptions>({
  use: {
    channel: 'chromium',
    smoothnessOptions: { baselineDir: process.env.SMOOTHNESS_BASELINE_DIR },
  },
});
```

This example assumes `snapshotDir` is `tests` (the default when `testDir` is `tests`). `dawidd6/action-download-artifact` is a third-party action; GitHub's own `actions/download-artifact` can only read artifacts from the same workflow run.

## How this recipe is tested

`scripts/verify-ci-recipe.sh` runs these steps against `examples/plain-site` on every pull request to this project (the Examples workflow). It records on "main", collects the baselines as above, runs as a fresh pull request with `baselineDir`, checks that every result was compared against the collected baseline, and checks that a deliberate regression fails. The one step it can't exercise is downloading an artifact from a different workflow run.

## Full mode on a schedule

Scheduled runs use full mode automatically (see [mode-detection.md](mode-detection.md)), and full-mode baselines are kept separately from quick-mode ones. To gate them, add `schedule:` to `on:` and a step that compares before the main-branch step re-records:

```yaml
- name: 'Scheduled: compare with the last scheduled run'
  if: github.event_name == 'schedule'
  run: npx playwright test
  env:
    SMOOTHNESS_BASELINE_DIR: smoothness-baselines
```

Put it before the "Main" steps. Those already run on scheduled runs, because a scheduled run on the default branch has `github.ref` set to `refs/heads/main`, so they re-record afterwards and the artifact carries both quick-mode and full-mode baselines.
