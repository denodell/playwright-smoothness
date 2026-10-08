#!/usr/bin/env bash
set -uo pipefail
dir="${SMOOTHNESS_BASELINE_DIR:-}"
if [ -n "$dir" ] && [ -n "$(find "$dir" -type f 2> /dev/null | head -1)" ]; then
  echo "Publishing $(find "$dir" -type f | wc -l | tr -d ' ') baseline file(s) as '${SMOOTHNESS_ACTION_ARTIFACT:-smoothness-baselines}'."
  echo "collected=true" >> "$GITHUB_OUTPUT"
else
  echo "::warning::No smoothness baselines were recorded, so none were published. Recording needs playwright-butter 1.1 or later, tests that call toBeSmooth() or use withButter(), and the setup step before them."
  echo "collected=false" >> "$GITHUB_OUTPUT"
fi
