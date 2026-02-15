#!/usr/bin/env bash
set -euo pipefail

pnpm install

# Clone reference repos locally (ignored by git)
mkdir -p repos

if [ ! -d "repos/effect-ts" ]; then
  echo "Cloning Effect TS repository for reference..."
  git clone --depth 1 https://github.com/Effect-TS/effect.git repos/effect-ts
  echo "Effect TS cloned to repos/effect-ts!"
else
  echo "repos/effect-ts already exists, skipping clone."
fi
