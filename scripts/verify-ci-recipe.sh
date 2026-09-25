#!/usr/bin/env bash
# Runs the steps of docs/ci.md against examples/plain-site on one machine:
#   1. "main": record baselines with --update-snapshots=all, collect them as the recipe does;
#   2. "pull request": a fresh checkout (no local baselines) with baselineDir → every check
#      must be compared against the collected baseline, and pass;
#   3. a regression (SLOW=80, enforce fail) → the run must fail, blaming the filters handler.
# The cross-run artifact download (dawidd6/action-download-artifact) isn't exercised here.
set -euo pipefail
cd "$(dirname "$0")/../examples/plain-site"
rm -rf baselines-out smoothness-baselines test-results tests/*-snapshots

echo "== main: record baselines"
npx playwright test --update-snapshots=all
mkdir -p baselines-out
# The same portable copy as docs/ci.md (GNU cp --parents doesn't exist on macOS).
(cd tests && find . -path '*-snapshots/smoothness/*' -type f | while read -r f; do
  mkdir -p "../baselines-out/$(dirname "$f")" && cp "$f" "../baselines-out/$f"
done)
test -n "$(find baselines-out -type f)" || { echo 'no baselines were collected'; exit 1; }
find baselines-out -type f

echo "== pull request: compare against main's baselines"
rm -rf tests/*-snapshots
mv baselines-out smoothness-baselines
SMOOTHNESS_BASELINE_DIR=smoothness-baselines npx playwright test --update-snapshots=none
node -e "
const fs = require('fs'), path = require('path');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') && files.push(p); } })('test-results/smoothness');
let bad = 0;
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = r.comparison;
  const ok = c && c.status === 'pass' && c.baseline && c.baseline.source === 'baselineDir';
  console.log((ok ? 'ok   ' : 'FAIL ') + r.label + ': ' + (c ? c.status + ' from ' + (c.baseline && c.baseline.source) : 'no comparison'));
  if (!ok) bad++;
}
if (files.length !== 2 || bad) { console.error('expected 2 results compared against baselineDir'); process.exit(1); }
"

echo "== regression: must fail"
if SLOW=80 SMOOTHNESS_ENFORCE=fail SMOOTHNESS_BASELINE_DIR=smoothness-baselines npx playwright test --update-snapshots=none -g 'filters' > regression.log 2>&1; then
  cat regression.log; echo 'the regression passed, but should have failed'; exit 1
fi
grep -q 'is less smooth than its baseline' regression.log
grep -q 'toggleFilters' regression.log
# The reporter (loaded by package name in the example's config) names it in the summary.
grep -q '\*\*1 got worse\*\*' test-results/smoothness/summary.md
grep -q 'toggleFilters' test-results/smoothness/summary.md
echo "regression failed as expected:"; grep -A4 'is less smooth' regression.log | head -6
rm -f regression.log
echo "CI recipe verified"
