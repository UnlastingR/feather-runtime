import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { D1TaskRepository } from '@feather/database';
import { InternalTaskSchema, TaskCreateSchema } from '@feather/protocol';
import type { Env } from './env.js';
import { internalHmacAuth, publicAuth, requireScope, sealNodeSecret, sha256Hex } from './security.js';
import { createTaskAndQueue, queueRetry } from './tasks.js';

type Variables = { actorId: string; userId: string | null; scopes: string[] };
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function canAccessTask(
  c: AppContext,
  taskId: string,
): Promise<boolean> {
  if ((c.get('scopes') ?? []).includes('admin')) return true;
  const userId = c.get('userId');
  if (!userId) return false;
  const row = await c.env.DB.prepare('SELECT id FROM tasks WHERE id=? AND user_id=?')
    .bind(taskId, userId)
    .first<{ id: string }>();
  return row !== null;
}

app.get('/health', (c) => c.json({ status: 'ok', service: 'feather-runtime-control-plane', time: Date.now() }));

app.post('/internal/nodes/register', async (c) => {
  if (c.req.header('x-bootstrap-token') !== c.env.BOOTSTRAP_TOKEN) return c.json({ error: 'unauthorized' }, 401);
  const input = z.object({
    nodeId: z.string().min(3), secret: z.string().min(24), hostname: z.string().min(1), agentVersion: z.string().min(1), architecture: z.string().min(1), cpuCount: z.number().int().positive(), memoryMb: z.number().int().positive(), capabilities: z.record(z.string(), z.unknown()).default({}),
  }).parse(await c.req.json());
  const sealed = await sealNodeSecret(input.secret, c.env.NODE_KEY_ENCRYPTION_KEY);
  const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO nodes(id,hostname,agent_version,architecture,cpu_count,memory_mb,last_seen,status,capabilities_json,hmac_key_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET hostname=excluded.hostname,agent_version=excluded.agent_version,architecture=excluded.architecture,cpu_count=excluded.cpu_count,memory_mb=excluded.memory_mb,last_seen=excluded.last_seen,capabilities_json=excluded.capabilities_json,hmac_key_enc=excluded.hmac_key_enc,updated_at=excluded.updated_at`).bind(input.nodeId, input.hostname, input.agentVersion, input.architecture, input.cpuCount, input.memoryMb, now, 'online', JSON.stringify(input.capabilities), sealed, now, now).run();
  return c.json({ ok: true, nodeId: input.nodeId });
});

app.post('/internal/bootstrap/api-keys', async (c) => {
  if (c.req.header('x-bootstrap-token') !== c.env.BOOTSTRAP_TOKEN) return c.json({ error: 'unauthorized' }, 401);
  const input = z.object({
    name: z.string().min(1).max(100),
    token: z.string().min(24),
    scopes: z.array(z.enum(['tasks:read', 'tasks:write', 'artifacts:read', 'admin'])).min(1),
    userId: z.string().min(1).nullable().default(null),
  }).parse(await c.req.json());
  if (input.userId === null && !input.scopes.includes('admin')) {
    return c.json({ error: 'user_required_for_non_admin_key' }, 400);
  }
  if (input.userId !== null) {
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(input.userId).first<{ id: string }>();
    if (!user) return c.json({ error: 'user_not_found' }, 404);
  }
  const keyId = `key_${crypto.randomUUID().replaceAll('-', '')}`;
  const tokenHash = await sha256Hex(`${c.env.API_HASH_PEPPER}:${input.token}`);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO api_keys(id,user_id,name,token_hash,scopes,created_at) VALUES(?,?,?,?,?,?)')
      .bind(keyId, input.userId, input.name, tokenHash, input.scopes.join(' '), now),
    c.env.DB.prepare('INSERT INTO audit_logs(user_id,actor_type,actor_id,action,target_type,target_id,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(input.userId, 'bootstrap', null, 'api_key.created', 'api_key', keyId, JSON.stringify({ name: input.name, scopes: input.scopes }), now),
  ]);
  return c.json({ id: keyId, userId: input.userId, name: input.name, scopes: input.scopes }, 201);
});

app.use('/internal/*', internalHmacAuth);

app.post('/internal/nodes/heartbeat', async (c) => {
  const input = z.object({ nodeId: z.string(), status: z.enum(['online', 'draining']).default('online'), cpuLoad: z.number().nonnegative(), memoryUsedMb: z.number().nonnegative(), activeTasks: z.number().int().nonnegative(), lightpandaHealthy: z.boolean(), chromiumRunning: z.number().int().nonnegative(), version: z.string() }).parse(await c.req.json());
  if (input.nodeId !== c.get('actorId')) return c.json({ error: 'node_mismatch' }, 403);
  await c.env.DB.prepare('UPDATE nodes SET last_seen=?,status=?,agent_version=?,capabilities_json=?,updated_at=? WHERE id=?').bind(Date.now(), input.status, input.version, JSON.stringify({ cpuLoad: input.cpuLoad, memoryUsedMb: input.memoryUsedMb, activeTasks: input.activeTasks, lightpandaHealthy: input.lightpandaHealthy, chromiumRunning: input.chromiumRunning }), Date.now(), input.nodeId).run();
  return c.json({ ok: true });
});

app.get('/internal/tasks/:id', async (c) => {
  const repo = new D1TaskRepository(c.env.DB);
  const task = await repo.get(c.req.param('id'));
  if (!task) return c.json({ error: 'not_found' }, 404);
  const hostname = task.url ? new URL(task.url).hostname.toLowerCase() : null;
  const policy = hostname ? await c.env.DB.prepare('SELECT * FROM domain_policies WHERE domain=?').bind(hostname).first<Record<string, unknown>>() : null;
  const hint = hostname ? await c.env.CACHE.get(`engine:v1:${hostname}`, 'json') : null;
  return c.json({ task: InternalTaskSchema.parse(task), policy, hint });
});

app.post('/internal/tasks/:id/start', async (c) => {
  const taskId = c.req.param('id');
  const input = z.object({ attemptId: z.string(), idempotencyKey: z.string(), engine: z.enum(['http','document','lightpanda','chromium','ocr']) }).parse(await c.req.json());
  const task = await c.env.DB.prepare('SELECT status,destructive,cancel_requested FROM tasks WHERE id=?').bind(taskId).first<{ status: string; destructive: number; cancel_requested: number }>();
  if (!task) return c.json({ error: 'not_found' }, 404);
  if (task.cancel_requested === 1 || task.status === 'cancelled') return c.json({ execute: false, reason: 'cancelled' });
  if (task.status === 'created') return c.json({ execute: false, reason: 'not_queued_yet', retry: true });
  const attempt = await c.env.DB.prepare('SELECT status,idempotency_key FROM task_attempts WHERE id=? AND task_id=?').bind(input.attemptId, taskId).first<{ status: string; idempotency_key: string }>();
  if (!attempt || attempt.idempotency_key !== input.idempotencyKey) return c.json({ error: 'invalid_attempt' }, 409);
  if (attempt.status !== 'queued' || task.status !== 'queued') return c.json({ execute: false, reason: 'already_leased' });
  const now = Date.now();
  if (task.destructive === 1) {
    try {
      await c.env.DB.prepare('INSERT INTO destructive_idempotency(idempotency_key,task_id,attempt_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(input.idempotencyKey, taskId, input.attemptId, 'reserved', now, now).run();
    } catch {
      return c.json({ execute: false, reason: 'destructive_idempotency_reserved' });
    }
  }
  const leased = await c.env.DB.prepare("UPDATE tasks SET status='leased' WHERE id=? AND status='queued'").bind(taskId).run();
  if ((leased.meta.changes ?? 0) !== 1) return c.json({ execute: false, reason: 'lease_lost' });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tasks SET status='running',started_at=COALESCE(started_at,?),selected_engine=?,attempt_count=attempt_count+1 WHERE id=? AND status='leased'").bind(now, input.engine, taskId),
    c.env.DB.prepare("UPDATE task_attempts SET status='running',node_id=?,engine=?,started_at=? WHERE id=? AND status='queued'").bind(c.get('actorId'), input.engine, now, input.attemptId),
    c.env.DB.prepare('INSERT INTO task_events(task_id,attempt_id,node_id,event,data_json,created_at) VALUES(?,?,?,?,?,?)').bind(taskId, input.attemptId, c.get('actorId'), 'task.started', JSON.stringify({ engine: input.engine }), now),
  ]);
  return c.json({ execute: true });
});

app.post('/internal/tasks/:id/event', async (c) => {
  const taskId = c.req.param('id');
  const input = z.object({ attemptId: z.string().optional(), event: z.string().min(1), data: z.record(z.string(), z.unknown()).default({}) }).parse(await c.req.json());
  await c.env.DB.prepare('INSERT INTO task_events(task_id,attempt_id,node_id,event,data_json,created_at) VALUES(?,?,?,?,?,?)').bind(taskId, input.attemptId ?? null, c.get('actorId'), input.event, JSON.stringify(input.data), Date.now()).run();
  return c.json({ ok: true });
});

app.post('/internal/tasks/:id/attempts/:attemptId/artifacts', async (c) => {
  const taskId = c.req.param('id');
  const attemptId = c.req.param('attemptId');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > 100 * 1024 * 1024) return c.json({ error: 'artifact_too_large' }, 413);
  const mime = c.req.header('x-artifact-mime') ?? 'application/octet-stream';
  const kind = c.req.header('x-artifact-kind') ?? 'result';
  const filename = (c.req.header('x-artifact-name') ?? 'artifact.bin').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const artifactId = `art_${crypto.randomUUID().replaceAll('-', '')}`;
  const owner = await c.env.DB.prepare('SELECT user_id FROM tasks WHERE id=?').bind(taskId).first<{ user_id: string | null }>();
  if (!owner) return c.json({ error: 'task_not_found' }, 404);
  const key = `users/${owner.user_id ?? 'system'}/tasks/${taskId}/attempts/${attemptId}/${artifactId}-${filename}`;
  const hash = await sha256Hex(bytes);
  await c.env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: mime }, customMetadata: { taskId, attemptId, artifactId, sha256: hash } });
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO artifacts(id,task_id,attempt_id,kind,r2_key,sha256,size,mime,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(artifactId, taskId, attemptId, kind, key, hash, bytes.byteLength, mime, Date.now()),
    c.env.DB.prepare('INSERT INTO task_events(task_id,attempt_id,node_id,event,data_json,created_at) VALUES(?,?,?,?,?,?)').bind(taskId, attemptId, c.get('actorId'), 'artifact.created', JSON.stringify({ artifactId, kind, size: bytes.byteLength, mime }), Date.now()),
  ]);
  return c.json({ id: artifactId, key, mime, size: bytes.byteLength, sha256: hash });
});

app.get('/internal/artifacts/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key,mime,sha256,size FROM artifacts WHERE id=?').bind(c.req.param('id')).first<{ r2_key: string; mime: string; sha256: string; size: number }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const object = await c.env.ARTIFACTS.get(row.r2_key);
  if (!object) return c.json({ error: 'object_missing' }, 404);
  const headers = new Headers({ 'content-type': row.mime, 'x-artifact-sha256': row.sha256, 'content-length': String(row.size) });
  return new Response(object.body, { headers });
});

app.post('/internal/tasks/:id/complete', async (c) => {
  const taskId = c.req.param('id');
  const input = z.object({ attemptId: z.string(), engine: z.enum(['http','document','lightpanda','chromium','ocr']), resultArtifactId: z.string().optional(), durationMs: z.number().int().nonnegative(), memoryPeakMb: z.number().nonnegative().optional(), confidence: z.number().min(0).max(1).optional(), fallbackChain: z.array(z.string()).default([]) }).parse(await c.req.json());
  const now = Date.now();
  const updated = await c.env.DB.prepare("UPDATE tasks SET status='completed',selected_engine=?,finished_at=?,result_artifact_id=?,error_code=NULL,error_message=NULL WHERE id=? AND status='running'").bind(input.engine, now, input.resultArtifactId ?? null, taskId).run();
  if ((updated.meta.changes ?? 0) !== 1) {
    const current = await c.env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind(taskId).first<{ status: string }>();
    return c.json({ ok: current?.status === 'completed', status: current?.status ?? 'missing' }, current?.status === 'completed' ? 200 : 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE task_attempts SET status='completed',finished_at=?,duration_ms=?,memory_peak_mb=?,result_artifact_id=? WHERE id=? AND task_id=?").bind(now, input.durationMs, input.memoryPeakMb ?? null, input.resultArtifactId ?? null, input.attemptId, taskId),
    c.env.DB.prepare('INSERT INTO task_events(task_id,attempt_id,node_id,event,data_json,created_at) VALUES(?,?,?,?,?,?)').bind(taskId, input.attemptId, c.get('actorId'), 'task.completed', JSON.stringify({ engine: input.engine, durationMs: input.durationMs, confidence: input.confidence, fallbackChain: input.fallbackChain }), now),
    c.env.DB.prepare("UPDATE destructive_idempotency SET state='completed',updated_at=? WHERE task_id=? AND attempt_id=?").bind(now, taskId, input.attemptId),
  ]);
  return c.json({ ok: true });
});

app.post('/internal/tasks/:id/fail', async (c) => {
  const taskId = c.req.param('id');
  const input = z.object({ attemptId: z.string(), errorCode: z.string(), errorMessage: z.string().max(2000), retryable: z.boolean(), durationMs: z.number().int().nonnegative(), memoryPeakMb: z.number().nonnegative().optional() }).parse(await c.req.json());
  const task = await c.env.DB.prepare('SELECT status,destructive,attempt_count,max_attempts FROM tasks WHERE id=?').bind(taskId).first<{ status: string; destructive: number; attempt_count: number; max_attempts: number }>();
  if (!task) return c.json({ error: 'not_found' }, 404);
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return c.json({ ok: true, status: task.status });
  const now = Date.now();
  const canRetry = task.status === 'running' && input.retryable && task.destructive === 0 && task.attempt_count < task.max_attempts;
  const nextStatus = canRetry ? 'retrying' : 'failed';
  const changed = await c.env.DB.prepare(`UPDATE tasks SET status=?,finished_at=${canRetry ? 'NULL' : '?'},error_code=?,error_message=? WHERE id=? AND status='running'`).bind(...(canRetry ? [nextStatus, input.errorCode, input.errorMessage, taskId] : [nextStatus, now, input.errorCode, input.errorMessage, taskId])).run();
  if ((changed.meta.changes ?? 0) !== 1) return c.json({ error: 'invalid_state', status: task.status }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE task_attempts SET status='failed',finished_at=?,duration_ms=?,error_code=?,error_message=?,memory_peak_mb=? WHERE id=? AND task_id=?").bind(now, input.durationMs, input.errorCode, input.errorMessage, input.memoryPeakMb ?? null, input.attemptId, taskId),
    c.env.DB.prepare('INSERT INTO task_events(task_id,attempt_id,node_id,event,data_json,created_at) VALUES(?,?,?,?,?,?)').bind(taskId, input.attemptId, c.get('actorId'), canRetry ? 'task.retrying' : 'task.failed', JSON.stringify({ errorCode: input.errorCode, retryable: input.retryable }), now),
    c.env.DB.prepare("UPDATE destructive_idempotency SET state='unknown',updated_at=? WHERE task_id=? AND attempt_id=? AND state='reserved'").bind(now, taskId, input.attemptId),
  ]);
  if (canRetry) {
    const retry = await queueRetry(c.env, taskId);
    return c.json({ ok: true, status: 'queued', retryAttemptId: retry.attemptId });
  }
  return c.json({ ok: true, status: 'failed' });
});

app.use('/v1/*', publicAuth);

app.post('/v1/tasks', requireScope('tasks:write'), async (c) => {
  const task = TaskCreateSchema.parse(await c.req.json());
  const created = await createTaskAndQueue(c.env, task, c.get('userId'));
  return c.json(created, 202);
});

app.post('/v1/scrape', requireScope('tasks:write'), async (c) => {
  const input = z.object({ url: z.url(), format: z.literal('markdown').default('markdown'), engine: z.enum(['auto','http','lightpanda','chromium']).default('auto'), selectors: z.array(z.string()).default([]) }).parse(await c.req.json());
  const task = TaskCreateSchema.parse({ type: 'scrape', url: input.url, engine: input.engine, selectors: input.selectors });
  const created = await createTaskAndQueue(c.env, task, c.get('userId'));
  return c.json(created, 202);
});

app.post('/v1/documents', requireScope('tasks:write'), async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 100 * 1024 * 1024) return c.json({ error: 'invalid_document_size' }, 413);
  const taskId = `tsk_${crypto.randomUUID().replaceAll('-', '')}`;
  const artifactId = `art_${crypto.randomUUID().replaceAll('-', '')}`;
  const mime = c.req.header('content-type') ?? 'application/octet-stream';
  const filename = (c.req.header('x-file-name') ?? 'document.bin').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const key = `users/${c.get('userId') ?? 'system'}/tasks/${taskId}/source/${artifactId}-${filename}`;
  const hash = await sha256Hex(bytes);
  await c.env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: mime } });
  // Source artifacts still belong to a task row for referential integrity; create the task immediately after object upload.
  const task = TaskCreateSchema.parse({ type: 'document', engine: 'document', sourceArtifactId: artifactId, metadata: { filename, mime } });
  const now = Date.now();
  const repo = new D1TaskRepository(c.env.DB);
  await repo.create({ id: taskId, userId: c.get('userId'), task, now });
  await c.env.DB.prepare('INSERT INTO artifacts(id,task_id,attempt_id,kind,r2_key,sha256,size,mime,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(artifactId, taskId, null, 'source', key, hash, bytes.byteLength, mime, now).run();
  const attemptId = `att_${crypto.randomUUID().replaceAll('-', '')}`;
  const idempotencyKey = `idem_${crypto.randomUUID().replaceAll('-', '')}`;
  await c.env.DB.prepare('INSERT INTO task_attempts(id,task_id,attempt_number,idempotency_key,status,created_at) VALUES(?,?,?,?,?,?)').bind(attemptId, taskId, 1, idempotencyKey, 'queued', now).run();
  await c.env.JOBS.send({ version: 1, taskId, attemptId, idempotencyKey, priority: 0, createdAt: now }, { contentType: 'json' });
  await repo.transition(taskId, 'created', 'queued', { queued_at: Date.now() });
  return c.json({ taskId, sourceArtifactId: artifactId, attemptId }, 202);
});

app.get('/v1/tasks/:id', requireScope('tasks:read'), async (c) => {
  if (!(await canAccessTask(c, c.req.param('id')!))) return c.json({ error: 'not_found' }, 404);
  const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(c.req.param('id')).first<Record<string, unknown>>();
  return row ? c.json(row) : c.json({ error: 'not_found' }, 404);
});

app.post('/v1/tasks/:id/cancel', requireScope('tasks:write'), async (c) => {
  const taskId = c.req.param('id')!;
  if (!(await canAccessTask(c, taskId))) return c.json({ error: 'not_found' }, 404);
  const row = await c.env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind(taskId).first<{ status: string }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (['completed','failed','cancelled','expired'].includes(row.status)) return c.json({ ok: true, status: row.status });
  if (row.status === 'running' || row.status === 'leased') {
    await c.env.DB.prepare('UPDATE tasks SET cancel_requested=1 WHERE id=?').bind(taskId).run();
    return c.json({ ok: true, status: row.status, cancelRequested: true });
  }
  await c.env.DB.prepare("UPDATE tasks SET status='cancelled',cancel_requested=1,finished_at=? WHERE id=? AND status IN ('created','queued','retrying')").bind(Date.now(), taskId).run();
  return c.json({ ok: true, status: 'cancelled' });
});

app.get('/v1/tasks/:id/events', requireScope('tasks:read'), async (c) => {
  if (!(await canAccessTask(c, c.req.param('id')!))) return c.json({ error: 'not_found' }, 404);
  const rows = await c.env.DB.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY id ASC').bind(c.req.param('id')).all();
  return c.json(rows.results);
});

app.get('/v1/tasks/:id/artifacts', requireScope('artifacts:read'), async (c) => {
  if (!(await canAccessTask(c, c.req.param('id')!))) return c.json({ error: 'not_found' }, 404);
  const rows = await c.env.DB.prepare('SELECT id,task_id,attempt_id,kind,r2_key,sha256,size,mime,created_at FROM artifacts WHERE task_id=? ORDER BY created_at ASC').bind(c.req.param('id')).all();
  return c.json(rows.results);
});

app.get('/v1/nodes', requireScope('admin'), async (c) => {
  const rows = await c.env.DB.prepare('SELECT id,hostname,agent_version,architecture,cpu_count,memory_mb,last_seen,status,capabilities_json,created_at,updated_at FROM nodes ORDER BY last_seen DESC').all();
  return c.json(rows.results);
});

app.onError((error, c) => {
  console.error(JSON.stringify({ level: 'error', event: 'request.error', path: new URL(c.req.url).pathname, message: error instanceof Error ? error.message : String(error) }));
  if (error instanceof z.ZodError) return c.json({ error: 'invalid_input', issues: error.issues }, 400);
  return c.json({ error: 'internal_error' }, 500);
});

export default app;
