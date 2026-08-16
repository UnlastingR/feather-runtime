import {
  assertTaskTransition,
  TaskStatusSchema,
  type InternalTask,
  type TaskCreate,
  type TaskStatus,
} from '@feather/protocol';

export interface TaskRepository {
  create(input: {
    id: string;
    userId: string | null;
    task: TaskCreate;
    now: number;
  }): Promise<void>;
  get(id: string): Promise<InternalTask | null>;
  transition(
    id: string,
    from: TaskStatus,
    to: TaskStatus,
    patch?: Record<string, string | number | null>,
  ): Promise<boolean>;
}

interface TaskRow {
  id: string;
  user_id: string | null;
  type: 'scrape' | 'browser' | 'document';
  status: string;
  url: string | null;
  preferred_engine: InternalTask['preferredEngine'];
  selected_engine: InternalTask['selectedEngine'];
  requires_auth: number;
  destructive: number;
  priority: number;
  payload_json: string;
  max_attempts: number;
  attempt_count: number;
  timeout_ms: number | null;
  cancel_requested: number;
}

export class D1TaskRepository implements TaskRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: {
    id: string;
    userId: string | null;
    task: TaskCreate;
    now: number;
  }): Promise<void> {
    const task = input.task;
    await this.db
      .prepare(
        `INSERT INTO tasks (id,user_id,type,status,url,preferred_engine,requires_auth,destructive,priority,payload_json,max_attempts,timeout_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        input.id,
        input.userId,
        task.type,
        'created',
        task.url ?? null,
        task.engine,
        task.requiresAuth ? 1 : 0,
        task.destructive ? 1 : 0,
        task.priority,
        JSON.stringify(task),
        task.maxAttempts,
        task.timeoutMs ?? null,
        input.now,
      )
      .run();
  }

  async get(id: string): Promise<InternalTask | null> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      status: TaskStatusSchema.parse(row.status),
      url: row.url,
      preferredEngine: row.preferred_engine,
      selectedEngine: row.selected_engine,
      requiresAuth: row.requires_auth === 1,
      destructive: row.destructive === 1,
      priority: row.priority,
      payload: JSON.parse(row.payload_json) as TaskCreate,
      maxAttempts: row.max_attempts,
      attemptCount: row.attempt_count,
      timeoutMs: row.timeout_ms,
      cancelRequested: row.cancel_requested === 1,
    };
  }

  async transition(
    id: string,
    from: TaskStatus,
    to: TaskStatus,
    patch: Record<string, string | number | null> = {},
  ): Promise<boolean> {
    assertTaskTransition(from, to);
    const allowedColumns = new Set([
      'queued_at',
      'started_at',
      'finished_at',
      'selected_engine',
      'result_artifact_id',
      'error_code',
      'error_message',
      'cancel_requested',
      'attempt_count',
    ]);
    const entries = Object.entries(patch).filter(([key]) => allowedColumns.has(key));
    if (entries.length !== Object.keys(patch).length)
      throw new Error('Attempted to patch an unsupported task column');
    const assignments = ['status = ?', ...entries.map(([key]) => `${key} = ?`)];
    const values = [to, ...entries.map(([, value]) => value), id, from];
    const result = await this.db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND status = ?`)
      .bind(...values)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }
}
