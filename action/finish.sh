#!/usr/bin/env bash
set -uo pipefail
if [ -n "${RUN_CODE:-}" ] && [ "$RUN_CODE" != 0 ]; then
  echo "outcome=failed" >> "$GITHUB_OUTPUT"
  echo "The Playwright run failed."
  exit 1
fi
echo "outcome=passed" >> "$GITHUB_OUTPUT"
