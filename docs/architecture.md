# Architecture

## Responsibility split

```mermaid
flowchart TB
  subgraph CF[Cloudflare control plane]
    API[Worker API / Hono]
    D1[(D1 authoritative state)]
    KV[(KV hints/cache)]
    R2[(R2 bytes)]
    Q[Queues delivery]
    API --> D1
    API --> KV
    API --> R2
    API --> Q
  end

  subgraph VPS[Debian execution plane]
    Agent[Execution Agent]
    HTTP[HTTP Fast Path]
    Doc[Document Router]
    LP[Lightpanda service]
    Chrome[Headless Shell on demand]
    Agent --> HTTP
    Agent --> Doc
    Agent --> LP
    Agent --> Chrome
  end

  Q -->|HTTP pull / lease| Agent
  Agent -->|signed HTTPS| API
```

D1 is truth. KV is disposable. R2 stores bytes. Queues delivers work. The VPS may be destroyed without losing task definitions, event history, or primary artifacts.

## Task lifecycle

```mermaid
stateDiagram-v2
  [*] --> created
  created --> queued
  created --> cancelled
  queued --> leased
  queued --> cancelled
  queued --> expired
  leased --> running
  leased --> queued
  leased --> cancelled
  running --> completed
  running --> retrying
  running --> failed
  running --> cancelled
  retrying --> queued
  retrying --> failed
  retrying --> cancelled
```

The queue message carries only task/attempt identity. The agent retrieves the task body from the Worker so queue messages stay small and task state remains centralized.

## Attempt and duplicate semantics

Every queue delivery references a `task_attempts` row and unique `idempotency_key`. Starting work performs a conditional D1 lease. A duplicate delivery that arrives after a lease was won gets `execute: false` and is safe to acknowledge.

For destructive work, `destructive_idempotency` is reserved before execution. Destructive failures are not automatically retried. If completion is uncertain, the row can remain/transition to `unknown` and requires reconciliation rather than a second click/payment/submit.

## Engine routing

```mermaid
flowchart LR
  T[Web Task] --> C{Auth/payment/destructive/<br/>force Chromium?}
  C -->|yes| CH[Chromium]
  C -->|no| H[HTTP]
  H --> HC{confidence >= threshold?}
  HC -->|yes| R[Result]
  HC -->|no| LP[Lightpanda]
  LP --> LC{render confidence >= threshold?}
  LC -->|yes| R
  LC -->|no| CH
  CH --> R
```

Domain policy can disable an engine or force one. KV may supply a high-confidence engine hint, but policy and authoritative task flags win.

## Document routing

```mermaid
flowchart LR
  D[Document] --> R[DocumentRouter]
  R --> T[TXT/Markdown]
  R --> H[HTML -> Turndown]
  R --> A[AnyDoc]
  A --> P{PDF?}
  P -->|no| M[Markdown]
  P -->|yes| I[pdf-inspector classify]
  I -->|text based| M
  I -->|scanned/mixed pages| O[OCR_REQUIRED]
```

The OCR-required branch is a deliberate interface boundary in MVP. A future adapter should run as a resource-limited subprocess and terminate after the job.

## Artifacts

Large bodies never live in D1. R2 keys are grouped by task/attempt. D1 stores only metadata, hashes, MIME, byte count, and R2 key. Current internal upload keys follow:

```text
users/{userId|system}/tasks/{taskId}/attempts/{attemptId}/{artifactId}-{filename}
users/{userId|system}/tasks/{taskId}/source/{artifactId}-{filename}
```

## Queue ordering and acknowledgement

The agent uses the current Cloudflare HTTP pull endpoints:

```text
POST /accounts/{account}/queues/{queue}/messages/pull
POST /accounts/{account}/queues/{queue}/messages/ack
```

Pulled messages are leased by `lease_id`. The agent acknowledges only after D1/R2 reporting succeeds. Reporting failure causes explicit retry or natural redelivery when the visibility timeout expires.

## Resource guards

The 2C2G default has independent limits for total work, Lightpanda, Chromium, and OCR. Chromium concurrency defaults to one. The agent also inspects system free memory before pulling and before Chromium startup.

## Future-compatible boundaries

Repositories isolate D1-specific persistence from task/domain logic. `BrowserEngine` isolates browser CDP implementation. `DocumentParser` isolates AnyDoc/PDF/OCR choices. These are intended extension points for Supabase/Postgres, remote Chromium, Playwright/WebKit/Firefox, GPU OCR nodes, or Cloudflare Workflows without adding those dependencies to MVP.
