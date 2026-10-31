#!/usr/bin/env bash
# Hook Stop : bloque la fin de tâche si le typecheck ou les tests échouent
# alors que des fichiers source ont changé.
cd "$CLAUDE_PROJECT_DIR" || exit 0
[[ -d node_modules ]] || exit 0
if git diff --quiet HEAD -- src scripts 2>/dev/null && [[ -z "$(git ls-files --others --exclude-standard src)" ]]; then
  exit 0
fi
out=$( { npm run -s typecheck && npm test --silent; } 2>&1 )
if [[ $? -ne 0 ]]; then
  echo "Typecheck ou tests en échec, corrigez avant de terminer :" >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
exit 0
