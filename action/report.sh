#!/usr/bin/env bash
set -uo pipefail

summary="$RESULTS_DIR/smoothness/summary.md"
if [ -f "$summary" ] && [ -n "${STARTED:-}" ] && [ "$summary" -nt "$STARTED" ]; then
  echo "Using the reporter's summary."
else
  npx playwright-smoothness summary --results "$RESULTS_DIR" --out "$summary" --github-summary
fi
echo "summary=$summary" >> "$GITHUB_OUTPUT"

[ "${COMMENT:-true}" = true ] && [ -n "${PR_NUMBER:-}" ] || exit 0

marker='<!-- playwright-smoothness -->'
body="$(printf '%s\n%s' "$marker" "$(cat "$summary")")"

briefs="$(npx playwright-smoothness brief --results "$RESULTS_DIR" 2> /dev/null)"
if [ -n "$briefs" ]; then
  if [ "${#briefs}" -gt 50000 ]; then
    briefs="${briefs:0:50000}
…cut to fit in a comment. Run npx playwright-smoothness brief on the results artifact for all of it."
  fi
  body="$body

<details>
<summary>Fix briefs for a coding agent</summary>

Paste this into your agent, or run \`npx playwright-smoothness brief\` locally after reproducing the run.

\`\`\`\`markdown
$briefs
\`\`\`\`

</details>"
fi
repo="${GITHUB_REPOSITORY:?}"
existing=$(gh api "repos/$repo/issues/$PR_NUMBER/comments?per_page=100" --paginate \
  --jq ".[] | select(.body | startswith(\"$marker\")) | .id" 2>/dev/null | tail -1)
if [ -n "$existing" ]; then
  gh api -X PATCH "repos/$repo/issues/comments/$existing" -f body="$body" > /dev/null \
    && echo "Updated the summary comment." \
    || echo "::warning::Couldn't update the summary comment. Does the job have permissions: pull-requests: write?"
else
  gh api -X POST "repos/$repo/issues/$PR_NUMBER/comments" -f body="$body" > /dev/null \
    && echo "Posted the summary comment." \
    || echo "::warning::Couldn't post the summary comment. Does the job have permissions: pull-requests: write? Pull requests from forks can't be commented on with the default token."
fi
exit 0
