#!/usr/bin/env bash
set -euo pipefail

event="${GITHUB_EVENT_NAME:-}"
on_default=false
[ -n "${DEFAULT_BRANCH:-}" ] && [ "${GITHUB_REF:-}" = "refs/heads/$DEFAULT_BRANCH" ] && on_default=true

record=false
if [ "$on_default" = true ]; then
  case "$event" in
    push | schedule | workflow_dispatch) record=true ;;
  esac
fi

temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
baselines="$temp/smoothness-baselines"
mkdir -p "$baselines"
started="$temp/smoothness-started"
touch "$started"

results_artifact="${RESULTS_ARTIFACT:-}"
[ -n "$results_artifact" ] || results_artifact="smoothness-results-${GITHUB_JOB:-job}-${GITHUB_RUN_ATTEMPT:-1}-$RANDOM$RANDOM"

{
  echo "record=$record"
  echo "baselines=$baselines"
  echo "started=$started"
  echo "results-artifact=$results_artifact"
} >> "$GITHUB_OUTPUT"

{
  echo "SMOOTHNESS_BASELINE_DIR=$baselines"
  echo "SMOOTHNESS_ACTION_STARTED=$started"
  echo "SMOOTHNESS_ACTION_ARTIFACT=${ARTIFACT_NAME:-smoothness-baselines}"
  if [ "$record" = true ]; then echo "SMOOTHNESS_RECORD_BASELINES=1"; fi
} >> "$GITHUB_ENV"

if [ "$record" = true ]; then
  echo "Event: $event on ${GITHUB_REF:-?}. Checks compare with main's baselines, then record this run's as the new ones."
else
  echo "Event: $event on ${GITHUB_REF:-?}. Checks compare with main's baselines."
fi
