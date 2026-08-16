# Security Model

## Trust boundaries

There are three primary boundaries: public client to Worker, Worker to Cloudflare bindings, and external execution node to Worker/Queues. The execution node is not exposed as a public API.

## Public API authentication

Public API keys are bearer tokens. D1 stores only `SHA256(API_HASH_PEPPER + ":" + token)`. Scopes are explicit (`tasks:read`, `tasks:write`, `artifacts:read`, `admin`). `AUTH_DISABLED=1` is only for isolated local development.

Initial administrator keys can be seeded through `POST /internal/bootstrap/api-keys`, protected by the same high-entropy bootstrap secret used for node enrollment. The plaintext API token is supplied by the operator and is never returned or stored by the Worker. After initial enrollment, rotate the bootstrap secret if the environment requires a tighter enrollment window.

## Node authentication

Nodes register using a bootstrap token and then sign internal requests using:

```text
HMAC-SHA256(
  METHOD + "\n" +
  PATH + "\n" +
  SHA256(BODY) + "\n" +
  TIMESTAMP + "\n" +
  NONCE
)
```

Signatures expire after five minutes. Nonces are stored in D1 with a primary key per node so replay is rejected. Node HMAC keys are AES-256-GCM encrypted before storage in D1; the encryption key remains a Worker secret.

Future deployments may replace this layer with Cloudflare Access service tokens or mTLS without changing task protocol.

## Secret handling

Do not place passwords, cookies, OAuth tokens, API tokens, session material, or profile secrets in task payloads. Structured logs redact keys matching authorization/cookie/password/token/secret/api-key patterns. Debug screenshots and HTML may themselves contain sensitive page content; treat the R2 bucket as private.

## SSRF

The HTTP path rejects non-HTTP(S), localhost, RFC1918, loopback, link-local, carrier-grade NAT, benchmark networks, multicast/reserved IPv4, IPv6 loopback/link-local/ULA, and the Google metadata hostname. DNS answers are checked before connection and redirects are validated again.

Browser actions validate every top-level `goto`. A hardened production deployment should additionally enforce an outbound egress proxy/firewall or per-request CDP interception because browsers independently resolve subresources. Treat network-level egress policy as the final SSRF boundary for Chromium/Lightpanda.

## Destructive actions

Destructive tasks include payment, purchase, booking, sending, deletion, irreversible submission, and account changes. Before executing, the control plane reserves a D1 idempotency key. Duplicate queue deliveries cannot win a second reservation. Automatic failure retry is disabled for destructive tasks. An uncertain outcome must be reconciled, not repeated.

## Challenge policy

CAPTCHA, MFA, Cloudflare Challenge, and similar identity/security challenges are stop/escalation conditions. The runtime is not designed to defeat website security measures.

## Remote code execution boundary

The public task schema contains browser actions only. It does not expose shell, Bash, exec, arbitrary process spawn, or filesystem command execution. `evaluate` runs a JavaScript expression inside the page execution context; it is not a host shell primitive.

## R2 and profiles

R2 is intended to stay private. Persistent browser profile synchronization is not implemented in MVP. When added, profile bundles must be encrypted client-side/node-side before upload and versioned to prevent concurrent profile corruption.

## Recommended deployment hardening

- Run the agent as an unprivileged user.
- Keep Lightpanda CDP on loopback/Compose-only networking.
- Deny inbound VPS traffic by default.
- Restrict the Queues API token to Queues read+write only.
- Use a private R2 bucket.
- Rotate bootstrap/API/node keys on compromise.
- Add host egress firewall rules or a validating outbound proxy for high-assurance browser SSRF control.
- Keep Chromium and Lightpanda pinned and routinely updated after compatibility tests.

### Chromium sandbox in containers

`CHROMIUM_NO_SANDBOX=0` is the default and is required for the native/systemd reference deployment. Some Docker hosts disable unprivileged user namespaces, causing Headless Shell to exit with `No usable sandbox!`; the reference Compose deployment therefore sets `CHROMIUM_NO_SANDBOX=1` explicitly. This is acceptable only inside the hardened, non-root container boundary used here. Do not run the native agent as root with this option enabled, and do not weaken the container's `no-new-privileges`, PID/memory limits, or host isolation to compensate.
