#!/usr/bin/env bash
set -uo pipefail
eval "$COMMAND"
echo "code=$?" >> "$GITHUB_OUTPUT"
exit 0
