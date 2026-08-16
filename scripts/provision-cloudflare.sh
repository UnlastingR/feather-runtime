#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

corepack pnpm --filter @feather/control-plane exec wrangler whoami

echo 'Creating resources when absent. Existing-name errors are safe to ignore and inspect.'
corepack pnpm --filter @feather/control-plane exec wrangler d1 create feather-runtime-db || true
corepack pnpm --filter @feather/control-plane exec wrangler kv namespace create feather-runtime-cache || true
corepack pnpm --filter @feather/control-plane exec wrangler r2 bucket create feather-runtime-artifacts || true
corepack pnpm --filter @feather/control-plane exec wrangler queues create feather-runtime-jobs || true
corepack pnpm --filter @feather/control-plane exec wrangler queues create feather-runtime-jobs-dlq || true

cat <<'EOF'

Next:
1. Copy the D1 database_id and KV namespace id into apps/control-plane/wrangler.jsonc.
2. Set BOOTSTRAP_TOKEN, NODE_KEY_ENCRYPTION_KEY and API_HASH_PEPPER with `wrangler secret put`.
3. Run scripts/deploy-cloudflare.sh.
EOF
