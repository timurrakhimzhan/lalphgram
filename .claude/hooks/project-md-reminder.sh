#!/bin/bash

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only care about source/test files in packages
if [[ ! "$FILE_PATH" =~ packages/[^/]+/(src|test)/ ]]; then
  exit 0
fi

# Extract package name
PACKAGE=$(echo "$FILE_PATH" | sed -n 's|.*/packages/\([^/]*\)/.*|\1|p')

if [ -n "$PACKAGE" ]; then
  jq -n --arg pkg "$PACKAGE" '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": "You modified source/test files in packages/\($pkg). If you added, removed, or changed any services, methods, types, or interfaces, update packages/\($pkg)/PROJECT.md to reflect the changes. Keep PROJECT.md in sync with the actual code."
    }
  }'
fi

exit 0
