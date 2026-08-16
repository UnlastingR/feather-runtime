import type { Env } from './env.js';
import { D1TaskRepository } from '@feather/database';
import { QueueMessageSchema, type QueueMessage, type TaskCreate } from '@feather/protocol';

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export interface QueuedAttempt {
  attemptId: string;
  idempotencyKey: string;
  message: QueueMessage;
}

export async function createTaskAndQueue(
  env: Env,
  task: TaskCreate,
  userId: string | null,
): Promise<{ taskId: string; attemptId: string }> {
  const now = Date.now();
  const taskId = id('tsk');
  const attemptId = id('att');
  const idempotencyKey = id('idem');
  const repo = new D1TaskRepository(env.DB);
  await repo.create({ id: taskId, userId, task, now });
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO task_attempts(id,task_id,attempt_number,idempotency_key,status,created_at) VALUES(?,?,?,?,?,?)',
    ).bind(attemptId, taskId, 1, idempotencyKey, 'queued', now),
    env.DB.prepare(
      'INSERT INTO task_events(task_id,attempt_id,event,data_json,created_at) VALUES(?,?,?,?,?)',
    ).bind(taskId, attemptId, 'task.created', '{}', now),
  ]);
  const message = QueueMessageSchema.parse({
    version: 1,
    taskId,
    attemptId,
    idempotencyKey,
    priority: task.priority,
    createdAt: now,
  });
  await env.JOBS.send(message, { contentType: 'json' });
  const transitioned = await repo.transition(taskId, 'created', 'queued', {
    queued_at: Date.now(),
  });
  if (!transitioned) throw new Error('Failed to transition task to queued after publishing');
  await env.DB.prepare(
    'INSERT INTO task_events(task_id,attempt_id,event,data_json,created_at) VALUES(?,?,?,?,?)',
  )
    .bind(taskId, attemptId, 'task.queued', '{}', Date.now())
    .run();
  return { taskId, attemptId };
}

export async function queueRetry(env: Env, taskId: string): Promise<QueuedAttempt> {
  const task = await env.DB.prepare(
    'SELECT priority,attempt_count,max_attempts,status FROM tasks WHERE id=?',
  )
    .bind(taskId)
    .first<{ priority: number; attempt_count: number; max_attempts: number; status: string }>();
  if (!task) throw new Error('Task not found');
  if (task.attempt_count >= task.max_attempts) throw new Error('Task exhausted max attempts');
  const attemptNumber = task.attempt_count + 1;
  const attemptId = id('att');
  const idempotencyKey = id('idem');
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO task_attempts(id,task_id,attempt_number,idempotency_key,status,created_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(attemptId, taskId, attemptNumber, idempotencyKey, 'queued', now)
    .run();
  const message = QueueMessageSchema.parse({
    version: 1,
    taskId,
    attemptId,
    idempotencyKey,
    priority: task.priority,
    createdAt: now,
  });
  await env.JOBS.send(message, { contentType: 'json' });
  await env.DB.prepare(
    "UPDATE tasks SET status='queued',queued_at=? WHERE id=? AND status='retrying'",
  )
    .bind(now, taskId)
    .run();
  await env.DB.prepare(
    'INSERT INTO task_events(task_id,attempt_id,event,data_json,created_at) VALUES(?,?,?,?,?)',
  )
    .bind(taskId, attemptId, 'task.queued', JSON.stringify({ retry: true }), now)
    .run();
  return { attemptId, idempotencyKey, message };
}
