#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo '[feather-format] applying Prettier to tracked source/config/documentation files'
corepack pnpm exec prettier --write \
  apps \
  packages \
  docs \
  infra \
  tests \
  README.md \
  package.json \
  pnpm-workspace.yaml \
  tsconfig.base.json \
  vitest.config.ts \
  eslint.config.mjs \
  .prettierrc.json

echo '[feather-format] verifying formatting, lint and types'
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck

echo '[feather-format] PASS'
