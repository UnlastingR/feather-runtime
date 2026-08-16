# MVP Verification Report

Verification date: 2026-08-16

This document records commands that were actually executed against the current source tree and the isolated Cloudflare resources created for Feather Runtime. It intentionally distinguishes verified behavior from code that merely exists.

## Build and static checks

| Check                  | Result     | Evidence                                                                                            |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| ESLint                 | **passed** | `corepack pnpm lint` exited 0                                                                       |
| strict TypeScript      | **passed** | all 7 workspace projects typechecked successfully                                                   |
| unit tests             | **passed** | 5 files, 13 tests passed                                                                            |
| execution-agent bundle | **passed** | esbuild produced `dist/index.js` successfully                                                       |
| Worker dry-run bundle  | **passed** | 651.58 KiB upload / 103.98 KiB gzip; D1/KV/R2/Queue bindings detected                               |
| Prettier enforcement   | **passed** | `bash scripts/format-source.sh` completed Prettier check, ESLint, and strict typecheck successfully |

The project pins TypeScript 6.0.3 because the current `typescript-eslint` peer range does not yet accept TypeScript 7.0.x. This was discovered by executing the lint toolchain rather than assumed from model knowledge.

## Cloudflare control plane

Created and verified against the real Cloudflare account:

```text
D1     feather-runtime-db
KV     feather-runtime-cache
R2     feather-runtime-artifacts
Queue  feather-runtime-jobs
DLQ    feather-runtime-jobs-dlq
```

Remote D1 migration `0001_init.sql` executed successfully. The Worker was deployed to:

```text
https://feather-runtime-control-plane.kp946440.workers.dev
```

`GET /health` returned `status=ok` after deployment.

The main Queue has a real HTTP pull consumer configured with:

```text
batch size:          4
message retries:     3
dead letter queue:   feather-runtime-jobs-dlq
visibility timeout:  300 seconds
retry delay:         5 seconds
```

## Required runtime scenarios

### 1. Static/readable HTML -> HTTP

**passed**

`HTTP Fast Path` fetched the Cloudflare Queues pull-consumer documentation directly:

```text
HTTP status:       200
confidence:        0.98
markdown bytes:    14188
routing decision:  http
```

No browser was required.

### 2. JavaScript SPA -> Lightpanda

**passed**

TodoMVC React was used as a real public SPA. Its server response contains an empty React root:

```html
<section class="todoapp" id="root"></section>
```

Observed:

```text
HTTP confidence:       0.58
Lightpanda DOM bytes:  3274
rendered todo input:   yes ("What needs to be done")
```

The HTTP score is below the 0.80 default threshold, while Lightpanda executed the JavaScript and produced the interactive DOM.

### 3. Lightpanda failure -> Chromium

**passed**

Lightpanda was intentionally pointed at an unavailable CDP endpoint. The test then invoked the same Chromium adapter used by the agent:

```json
{
  "chain": ["lightpanda", "chromium"],
  "status": 200,
  "success": true
}
```

### 4. Native PDF -> local parser

**passed**

The test suite generates a valid native-text PDF in memory, sends it through `DocumentRouter`, `pdf-inspector`, and AnyDoc, and verifies the extracted Markdown contains the expected text. No parser mock is used.

### 5. Duplicate Queue delivery / idempotency

**passed for delivery and authoritative idempotency primitives; full signed Agent task delivery is covered by scenario 11**

A real message was pushed to `feather-runtime-jobs`, pulled with a one-second lease, deliberately left unacknowledged, and pulled again after expiry:

```text
first pull:   same message ID, attempts=0
second pull:  same message ID, attempts=1
final ack:    success=true
```

Separately, the real remote D1 database was given a destructive idempotency reservation. A second insert of the same idempotency key was rejected with:

```text
SQLITE_CONSTRAINT_PRIMARYKEY
UNIQUE constraint failed: destructive_idempotency.idempotency_key
```

The verification rows were removed immediately afterward.

### 6. Execution interruption

**passed for process cleanup + Queue redelivery mechanism; full signed task recovery not executed**

A final Agent image container launched Chromium, completed navigation, emitted a readiness marker, and was then killed mid-task. After container termination:

```text
chrome-headless-shell processes remaining: 0
```

Queue lease-expiry redelivery was independently verified in scenario 5.

### 7. Chromium concurrency=1 stress

**passed**

Two real Chromium navigation jobs were submitted concurrently through `Semaphore(1)`:

```json
{
  "configured": 1,
  "maxActive": 1,
  "results": [
    { "id": 1, "status": 200 },
    { "id": 2, "status": 200 }
  ]
}
```

### 8. Memory pressure guard

**passed as deterministic guard/failure-injection test; host OOM pressure was not induced**

The production pull loop now calls the tested `decidePullGuard()` function. Tests verify:

```text
free=199 MiB, critical=200 MiB -> critical-memory (do not pull)
active=4, max=4                -> at-capacity (do not pull)
free=350 MiB, active=1         -> pull
```

This verifies the guard decision without intentionally destabilizing the DevSpace host with artificial OOM pressure.

### 9. R2 artifact upload/download

**passed**

A verification object was uploaded to the real `feather-runtime-artifacts` bucket, downloaded, compared byte-for-byte, hashed, and then deleted. The round trip was identical.

### 10. D1 state recovery/persistence

**passed**

Task/attempt/destructive-idempotency verification rows were inserted into the remote D1 database. A separate Wrangler invocation read back:

```text
task:               tsk_mvp_verify
status:             running
destructive:        1
idempotency state:  reserved
```

The rows were then cleaned from the remote database.

## Browser implementation findings discovered during real tests

Several issues were found and fixed only because the binaries were actually run:

1. Lightpanda 0.3.7 `/json/version` advertises its internal `ws://127.0.0.1:9222/` endpoint and rejects a Docker service name in the WebSocket `Host` header. `LightpandaEngine` now builds the endpoint from the configured CDP address and sends the loopback Host header.
2. The reference Chrome Headless Shell runtime needed `libXfixes.so.3`; `libxfixes3` was added to Docker/native dependencies.
3. The standalone install script now supports Python's `zipfile` module when `unzip` is absent and restores executable bits after extraction.
4. The tested Docker host disables the user-namespace mechanism Chromium expects for its inner sandbox. Native/systemd keeps Chromium sandboxing enabled; the hardened reference Docker container explicitly uses `CHROMIUM_NO_SANDBOX=1` while remaining non-root with `no-new-privileges` and resource limits.
5. Browser shutdown was checked after successful navigation and after forced container interruption; no Headless Shell processes remained.

### 11. Full signed Agent E2E

**passed**

`bash scripts/verify-agent-e2e.sh` completed against the deployed Worker using a temporary bootstrap credential and the Node.js 24 Agent image. The run verified:

```text
Agent registration + signed HMAC heartbeat: passed
Queue pull/ack:                            passed
HTTP fast path:                            completed via http
React SPA:                                 completed via lightpanda
Chromium on-demand path:                   completed via chromium
D1 node registry:                           online
R2 result artifacts:                        downloaded successfully
```

The script removed the three temporary tasks, artifacts, API key, and node, stopped its containers, confirmed the Queue was empty, and rotated the temporary bootstrap credential during cleanup.

Also intentionally deferred to phase two:

- persistent encrypted browser-profile synchronization;
- a real isolated OCR subprocess (MVP currently returns `OCR_REQUIRED` for scanned/image PDFs);
- learned `domain_engine_stats` writeback / KV hint generation;
- metrics/dashboard export;
- multi-node drain orchestration.

## Cleanup

Verification R2 objects, remote D1 verification rows, Queue messages, and full-E2E task/node/API-key state were deleted or acknowledged after testing. The Cloudflare `feather-runtime-*` resources and deployed Worker remain because they are the actual project deployment, not temporary test infrastructure.
