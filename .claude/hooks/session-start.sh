#!/usr/bin/env bash
# Hook SessionStart : installe les dépendances dans les sessions cloud.
[[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules ]]; then
  npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
fi
exit 0
