# Troubleshooting

## Agent cannot pull Queue messages

Verify `CF_ACCOUNT_ID`, `CF_QUEUE_ID`, and `CF_QUEUES_TOKEN`. HTTP pull requires both read and write permissions because acknowledgement mutates queue state. Confirm the queue has an HTTP pull consumer; current Wrangler uses:

```bash
wrangler queues consumer http add feather-runtime-jobs
```

Do not add an old `type = "http_pull"` consumer stanza to Wrangler configuration.

## Messages keep redelivering

The most common reasons are: the agent did not report completion to the Worker, reporting HMAC failed, or execution exceeded `QUEUE_VISIBILITY_TIMEOUT_MS`. Inspect `task_events`, agent JSON logs, and Queue attempt count. Increase visibility timeout for long browser workloads.

## HMAC returns 401

Check node ID and secret on the agent, clock skew (five-minute limit), `NODE_KEY_ENCRYPTION_KEY` on the Worker, and whether the node was re-registered with a new secret. Replayed nonces intentionally return 401.

## Lightpanda unhealthy

Check its CDP endpoint locally:

```bash
curl http://127.0.0.1:9222/json/version
```

For Compose use `docker compose ... exec lightpanda` or inspect container logs. The CDP port should not be public.

## Chromium never starts

The default binary is `/opt/chrome-headless-shell/chrome-headless-shell`. Verify:

```bash
/opt/chrome-headless-shell/chrome-headless-shell --version
```

Also inspect free memory. The agent refuses Chromium below `MIN_FREE_MEMORY_MB`.

If stderr reports `No usable sandbox!`, the host is preventing Chromium's Linux user-namespace sandbox. For the provided Docker Compose deployment set `CHROMIUM_NO_SANDBOX=1` (already the reference default in Compose) and retain the non-root/no-new-privileges container controls. For native/systemd deployment, leave `CHROMIUM_NO_SANDBOX=0` and fix the host sandbox/user-namespace configuration instead of disabling it.

## Chromium crashes under load

Keep `MAX_CHROMIUM_CONCURRENCY=1` on 2C2G. Avoid artificially tiny container memory caps. Check host `dmesg`/OOM logs and task event timing. Chromium is intentionally on-demand and should return to zero idle processes after cleanup.

## Static pages fall back to Lightpanda

Inspect the `http.failed` event. Confidence reasons can include short text, missing selectors, challenge markers, or JavaScript-required markers. Adjust `HTTP_CONFIDENCE_THRESHOLD` only after checking extraction quality.

## AnyDoc says OCR required

`pdf-inspector` classified the document as scanned/image-based/mixed or flagged pages for OCR. MVP returns `OCR_REQUIRED`; it does not silently emit incomplete native text as success.

## D1 migration fails locally

Run from the control-plane package so Wrangler finds the binding:

```bash
cd apps/control-plane
corepack pnpm exec wrangler d1 migrations apply feather-runtime-db --local
```

The placeholder remote database ID must be replaced before remote deployment.

## Worker deploy fails on resources

Run `scripts/provision-cloudflare.sh`, copy the returned D1/KV IDs into `wrangler.jsonc`, set Worker secrets, then rerun `scripts/deploy-cloudflare.sh`.

## Task stuck in `created`

This means publishing or the post-publish state transition failed. Do not fabricate a queued state. Inspect Worker logs and Queue existence, then retry task creation. Production reconciliation can later scan old `created` rows.

## Task stuck in `retrying`

The retry attempt may have failed to publish. Inspect Worker error logs and latest `task_attempts`. Because the original queue message is not acknowledged until failure reporting succeeds, delivery can recover; a future reconciler can make this stronger.
