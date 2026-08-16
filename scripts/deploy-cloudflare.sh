#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/control-plane"

if grep -q 'REPLACE_WITH_' wrangler.jsonc; then
  echo "wrangler.jsonc still contains resource ID placeholders." >&2
  echo "Create D1/KV/R2/Queues, then replace the D1 and KV IDs before deploying." >&2
  exit 2
fi

corepack pnpm exec wrangler whoami
corepack pnpm exec wrangler d1 migrations apply feather-runtime-db --remote
corepack pnpm exec wrangler deploy --env=""

# HTTP pull consumers are configured with Wrangler CLI, not wrangler.jsonc (Cloudflare 2026 semantics).
corepack pnpm exec wrangler queues consumer http add feather-runtime-jobs \
  --batch-size 4 \
  --message-retries 3 \
  --dead-letter-queue feather-runtime-jobs-dlq \
  --visibility-timeout-secs 300 \
  --retry-delay-secs 5
