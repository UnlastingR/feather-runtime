#!/usr/bin/env bash
set -Eeuo pipefail

# This script exists for the one verification step that cannot be executed by
# an automated assistant without exposing a reusable bootstrap secret back to
# the execution environment. It deliberately keeps all generated credentials
# in process memory, never prints them, and invalidates the bootstrap token on
# exit after it has been installed.

set +x
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-https://feather-runtime-control-plane.kp946440.workers.dev}"
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-935584ffc3332690fddacf062b1dc25d}"
CF_QUEUE_ID="${CF_QUEUE_ID:-8809a5e08d4349ab81638bc69c9e48c0}"
CF_QUEUE_NAME="${CF_QUEUE_NAME:-feather-runtime-jobs}"
D1_DATABASE="${D1_DATABASE:-feather-runtime-db}"
R2_BUCKET="${R2_BUCKET:-feather-runtime-artifacts}"
AGENT_IMAGE="${AGENT_IMAGE:-feather-runtime-agent:e2e}"
LIGHTPANDA_IMAGE="${LIGHTPANDA_IMAGE:-lightpanda/browser:0.3.7}"
KEEP_E2E_STATE="${KEEP_E2E_STATE:-0}"

NETWORK_NAME="feather-e2e-$RANDOM"
LIGHTPANDA_CONTAINER="feather-e2e-lightpanda-$RANDOM"
AGENT_CONTAINER="feather-e2e-agent-$RANDOM"
NODE_ID="node_e2e_$(date +%s)_$RANDOM"

BOOTSTRAP_TOKEN=""
NODE_SECRET=""
ADMIN_TOKEN=""
ADMIN_KEY_ID=""
BOOTSTRAP_INSTALLED=0
QUEUE_WAS_EMPTY=0
E2E_SUCCEEDED=0
TASK_IDS=()
CREATED_TASK_ID=""

log() {
  printf '[feather-e2e] %s\n' "$*"
}

die() {
  printf '[feather-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

random_secret() {
  openssl rand -base64 36 | tr -d '\n'
}

wrangler() {
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    corepack pnpm --filter @feather/control-plane exec wrangler "$@"
}

put_worker_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | wrangler secret put "$name" --env="" >/dev/null
}

cf_queue_call() {
  local suffix="$1"
  local json="$2"
  curl -fsS --retry 2 --retry-delay 1 --max-time 30 \
    -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${CF_QUEUE_ID}/messages${suffix}" \
    -H "Authorization: Bearer ${CF_QUEUES_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$json"
}

json_field() {
  local expression="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v=${expression};if(v===undefined||v===null)process.exit(4);process.stdout.write(String(v))})"
}

task_artifact_keys() {
  local task_id="$1"
  wrangler d1 execute "$D1_DATABASE" --remote --json \
    --command "SELECT r2_key FROM artifacts WHERE task_id='${task_id}' ORDER BY created_at ASC;" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const block of JSON.parse(s)){for(const row of block.results||[]){if(row.r2_key)console.log(row.r2_key)}}})"
}

task_result_key() {
  local task_id="$1"
  wrangler d1 execute "$D1_DATABASE" --remote --json \
    --command "SELECT r2_key FROM artifacts WHERE task_id='${task_id}' AND kind='result' ORDER BY created_at DESC LIMIT 1;" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const key=j[0]?.results?.[0]?.r2_key;if(key)process.stdout.write(key)})"
}

delete_test_state() {
  local task_id key

  for task_id in "${TASK_IDS[@]:-}"; do
    while IFS= read -r key; do
      [[ -n "$key" ]] || continue
      wrangler r2 object delete "${R2_BUCKET}/${key}" --remote >/dev/null 2>&1 || true
    done < <(task_artifact_keys "$task_id" || true)
  done

  for task_id in "${TASK_IDS[@]:-}"; do
    wrangler d1 execute "$D1_DATABASE" --remote --json \
      --command "DELETE FROM tasks WHERE id='${task_id}';" >/dev/null 2>&1 || true
  done

  if [[ -n "$ADMIN_KEY_ID" ]]; then
    wrangler d1 execute "$D1_DATABASE" --remote --json \
      --command "DELETE FROM audit_logs WHERE target_type='api_key' AND target_id='${ADMIN_KEY_ID}'; DELETE FROM api_keys WHERE id='${ADMIN_KEY_ID}';" \
      >/dev/null 2>&1 || true
  fi

  wrangler d1 execute "$D1_DATABASE" --remote --json \
    --command "DELETE FROM nodes WHERE id='${NODE_ID}';" >/dev/null 2>&1 || true
}

cleanup() {
  local rc=$?
  set +e

  docker rm -f "$AGENT_CONTAINER" "$LIGHTPANDA_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true

  if [[ "$KEEP_E2E_STATE" != "1" ]]; then
    delete_test_state
    if [[ "$QUEUE_WAS_EMPTY" == "1" && "$E2E_SUCCEEDED" != "1" ]]; then
      # The script only claims exclusivity after checking the queue was empty.
      # Purging here prevents orphaned verification messages after a failed run.
      wrangler queues purge "$CF_QUEUE_NAME" --force >/dev/null 2>&1 || true
    fi
  else
    log "KEEP_E2E_STATE=1: retained D1/R2 verification state for inspection"
  fi

  if [[ "$BOOTSTRAP_INSTALLED" == "1" ]]; then
    # Invalidate the temporary bootstrap token with a fresh unknown value.
    local rotated
    rotated="$(random_secret)"
    put_worker_secret BOOTSTRAP_TOKEN "$rotated" >/dev/null 2>&1 || true
    unset rotated
  fi

  unset BOOTSTRAP_TOKEN NODE_SECRET ADMIN_TOKEN CF_QUEUES_TOKEN

  if [[ $rc -eq 0 ]]; then
    log "cleanup complete; temporary bootstrap credential has been invalidated"
  else
    log "cleanup complete after failure (exit ${rc})"
  fi
  exit "$rc"
}
trap cleanup EXIT

wait_for_agent() {
  local i
  for i in $(seq 1 45); do
    if docker logs "$AGENT_CONTAINER" 2>&1 | grep -q 'agent.started'; then
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "$AGENT_CONTAINER" 2>/dev/null | grep -q true; then
      docker logs "$AGENT_CONTAINER" 2>&1 | tail -80 >&2 || true
      return 1
    fi
    sleep 1
  done
  docker logs "$AGENT_CONTAINER" 2>&1 | tail -80 >&2 || true
  return 1
}

create_scrape() {
  local url="$1"
  local engine="$2"
  local response task_id

  response="$(curl -fsS --retry 2 --max-time 30 \
    -X POST "${CONTROL_PLANE_URL}/v1/scrape" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "{\"url\":\"${url}\",\"format\":\"markdown\",\"engine\":\"${engine}\"}")"

  task_id="$(printf '%s' "$response" | json_field 'j.taskId')"
  TASK_IDS+=("$task_id")
  CREATED_TASK_ID="$task_id"
}

wait_for_task() {
  local task_id="$1"
  local expected_engine="$2"
  local label="$3"
  local i response status selected result_artifact

  for i in $(seq 1 90); do
    response="$(curl -fsS --retry 2 --max-time 20 \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      "${CONTROL_PLANE_URL}/v1/tasks/${task_id}")"
    status="$(printf '%s' "$response" | json_field 'j.status')"

    case "$status" in
      completed)
        selected="$(printf '%s' "$response" | json_field 'j.selected_engine')"
        result_artifact="$(printf '%s' "$response" | json_field 'j.result_artifact_id')"
        [[ "$selected" == "$expected_engine" ]] \
          || die "${label}: expected engine ${expected_engine}, got ${selected}"
        [[ -n "$result_artifact" ]] \
          || die "${label}: task completed without result_artifact_id"
        log "${label}: completed via ${selected} (${task_id})"
        return 0
        ;;
      failed|cancelled|expired)
        printf '%s\n' "$response" >&2
        die "${label}: task ended in ${status}"
        ;;
    esac
    sleep 2
  done

  die "${label}: timed out waiting for task ${task_id}"
}

verify_result_artifact() {
  local task_id="$1"
  local label="$2"
  local key tmp

  key="$(task_result_key "$task_id")"
  [[ -n "$key" ]] || die "${label}: no R2 artifact key recorded"
  tmp="$(mktemp)"
  wrangler r2 object get "${R2_BUCKET}/${key}" --file "$tmp" --remote >/dev/null
  [[ -s "$tmp" ]] || die "${label}: downloaded R2 result is empty"
  log "${label}: R2 artifact round-trip verified ($(wc -c < "$tmp" | tr -d ' ') bytes)"
  rm -f "$tmp"
}

check_queue_exclusive() {
  local response count lease
  response="$(cf_queue_call '/pull' '{"visibility_timeout_ms":1000,"batch_size":1}')"
  count="$(printf '%s' "$response" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.result?.messages?.length||0))})")"
  if [[ "$count" != "0" ]]; then
    lease="$(printf '%s' "$response" | json_field 'j.result.messages[0].lease_id')"
    cf_queue_call '/ack' "{\"acks\":[],\"retries\":[{\"lease_id\":\"${lease}\",\"delay_seconds\":0}]}" >/dev/null || true
    die "queue ${CF_QUEUE_NAME} is not empty; refusing an exclusive E2E run"
  fi
  QUEUE_WAS_EMPTY=1
}

main() {
  require curl
  require docker
  require corepack
  require node
  require openssl

  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] \
    || die 'export CLOUDFLARE_API_TOKEN first; the token needs Workers Scripts, D1, R2 and Queues edit access'

  export CF_QUEUES_TOKEN="${CF_QUEUES_TOKEN:-$CLOUDFLARE_API_TOKEN}"

  log "checking deployed control plane"
  curl -fsS --max-time 15 "${CONTROL_PLANE_URL}/health" >/dev/null \
    || die "control plane health check failed: ${CONTROL_PLANE_URL}/health"

  log "checking that the verification queue is empty"
  check_queue_exclusive

  BOOTSTRAP_TOKEN="$(random_secret)"
  NODE_SECRET="$(random_secret)"
  ADMIN_TOKEN="frt_e2e_$(openssl rand -hex 32)"
  export BOOTSTRAP_TOKEN NODE_SECRET ADMIN_TOKEN

  log "installing a temporary bootstrap credential in the Worker"
  put_worker_secret BOOTSTRAP_TOKEN "$BOOTSTRAP_TOKEN"
  BOOTSTRAP_INSTALLED=1

  log "creating a temporary admin API key through the bootstrap endpoint"
  local key_response
  key_response="$(curl -fsS --max-time 30 \
    -X POST "${CONTROL_PLANE_URL}/internal/bootstrap/api-keys" \
    -H "X-Bootstrap-Token: ${BOOTSTRAP_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "{\"name\":\"feather-e2e\",\"token\":\"${ADMIN_TOKEN}\",\"scopes\":[\"admin\",\"tasks:read\",\"tasks:write\",\"artifacts:read\"],\"userId\":null}")"
  ADMIN_KEY_ID="$(printf '%s' "$key_response" | json_field 'j.id')"

  log "building current Agent image"
  docker build -f infra/docker/Dockerfile.agent -t "$AGENT_IMAGE" . >/dev/null

  docker network create "$NETWORK_NAME" >/dev/null
  docker run -d --name "$LIGHTPANDA_CONTAINER" \
    --network "$NETWORK_NAME" \
    "$LIGHTPANDA_IMAGE" >/dev/null

  export CONTROL_PLANE_URL CF_ACCOUNT_ID CF_QUEUE_ID NODE_ID
  export NODE_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN"
  export LIGHTPANDA_CDP_URL="http://${LIGHTPANDA_CONTAINER}:9222"
  export CHROMIUM_NO_SANDBOX=1

  log "starting Agent; secrets are passed by environment name, not command-line value"
  docker run -d --name "$AGENT_CONTAINER" \
    --network "$NETWORK_NAME" \
    --memory 1536m \
    --pids-limit 256 \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    -e CONTROL_PLANE_URL \
    -e NODE_ID \
    -e NODE_SECRET \
    -e NODE_BOOTSTRAP_TOKEN \
    -e CF_ACCOUNT_ID \
    -e CF_QUEUE_ID \
    -e CF_QUEUES_TOKEN \
    -e LIGHTPANDA_CDP_URL \
    -e CHROMIUM_NO_SANDBOX \
    -e MAX_CHROMIUM_CONCURRENCY=1 \
    -e MAX_LIGHTPANDA_CONCURRENCY=3 \
    -e MAX_TOTAL_CONCURRENCY=4 \
    "$AGENT_IMAGE" >/dev/null

  wait_for_agent || die 'Agent failed before agent.started; see logs printed above'
  docker exec "$AGENT_CONTAINER" curl -fsS http://127.0.0.1:8788/health >/dev/null \
    || die 'Agent local health endpoint failed'
  log "Agent registration + signed heartbeat path is alive"

  local http_task lightpanda_task chromium_task
  create_scrape 'https://developers.cloudflare.com/queues/configuration/pull-consumers/' 'http'
  http_task="$CREATED_TASK_ID"
  create_scrape 'https://todomvc.com/examples/react/dist/' 'auto'
  lightpanda_task="$CREATED_TASK_ID"
  create_scrape 'https://example.com/' 'chromium'
  chromium_task="$CREATED_TASK_ID"

  wait_for_task "$http_task" http 'HTTP fast path'
  wait_for_task "$lightpanda_task" lightpanda 'Lightpanda SPA path'
  wait_for_task "$chromium_task" chromium 'Chromium on-demand path'

  verify_result_artifact "$http_task" 'HTTP fast path'
  verify_result_artifact "$lightpanda_task" 'Lightpanda SPA path'
  verify_result_artifact "$chromium_task" 'Chromium on-demand path'

  local node_state
  node_state="$(wrangler d1 execute "$D1_DATABASE" --remote --json \
    --command "SELECT id,status,last_seen,agent_version FROM nodes WHERE id='${NODE_ID}';")"
  printf '%s' "$node_state" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const r=j[0]?.results?.[0];if(!r||r.id!=='${NODE_ID}'||r.status!=='online')process.exit(5)})" \
    || die 'registered node was not persisted as online in D1'
  log "D1 node registry + HMAC-signed Agent lifecycle verified"

  E2E_SUCCEEDED=1
  log 'PASS: signed Agent E2E verified across HTTP, Lightpanda, Chromium, D1, R2 and Queue delivery'
}

main "$@"
