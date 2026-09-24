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

      - name: Pull request: compare with main
        if: github.event_name == 'pull_request'
        run: npx playwright test
        env:
          SMOOTHNESS_BASELINE_DIR: smoothness-baselines

      - name: Main: re-record baselines
        if: github.ref == 'refs/heads/main'
        run: |
          # Keep baselines for other CPU models, then re-record this machine's.
          if [ -d smoothness-baselines ]; then cp -R smoothness-baselines/. tests/; fi
          npx playwright test --update-snapshots=all

      # upload-artifact trims paths to the files' common directory, which would lose the
      # <spec>-snapshots/ part. Copy the baselines into a staging directory with their paths
      # relative to the snapshot directory intact.
      - name: Main: collect baselines
        if: github.ref == 'refs/heads/main'
        run: |
          mkdir -p baselines-out
          (cd tests && find . -path '*-snapshots/smoothness/*' -type f -exec cp --parents {} ../baselines-out/ \;)
      - name: Main: publish baselines
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

This recipe will be checked end to end, and extended with full mode on a schedule, before the public release (plan M4).
