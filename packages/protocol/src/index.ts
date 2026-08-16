import { z } from 'zod';

export const EngineSchema = z.enum(['auto', 'http', 'document', 'lightpanda', 'chromium', 'ocr']);
export type Engine = z.infer<typeof EngineSchema>;

export const ExecutedEngineSchema = z.enum(['http', 'document', 'lightpanda', 'chromium', 'ocr']);
export type ExecutedEngine = z.infer<typeof ExecutedEngineSchema>;

export const TaskStatusSchema = z.enum([
  'created',
  'queued',
  'leased',
  'running',
  'retrying',
  'completed',
  'failed',
  'cancelled',
  'expired',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ['queued', 'cancelled'],
  queued: ['leased', 'cancelled', 'expired'],
  leased: ['running', 'queued', 'cancelled', 'expired'],
  running: ['completed', 'retrying', 'failed', 'cancelled'],
  retrying: ['queued', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export const BrowserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goto'), url: z.url().optional() }),
  z.object({ type: z.literal('click'), selector: z.string().min(1) }),
  z.object({ type: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
  z.object({
    type: z.literal('wait'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('extract'), selector: z.string().min(1).optional() }),
  z.object({ type: z.literal('screenshot'), fullPage: z.boolean().default(true) }),
  z.object({ type: z.literal('evaluate'), expression: z.string().min(1) }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const TaskCreateSchema = z
  .object({
    type: z.enum(['scrape', 'browser', 'document']),
    url: z.url().optional(),
    engine: EngineSchema.default('auto'),
    requiresAuth: z.boolean().default(false),
    requiresPayment: z.boolean().default(false),
    destructive: z.boolean().default(false),
    priority: z.number().int().min(-100).max(100).default(0),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    selectors: z.array(z.string().min(1)).default([]),
    actions: z.array(BrowserActionSchema).default([]),
    sourceArtifactId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((value, ctx) => {
    if ((value.type === 'scrape' || value.type === 'browser') && !value.url) {
      ctx.addIssue({ code: 'custom', message: 'url is required for web tasks', path: ['url'] });
    }
    if (value.type === 'document' && !value.sourceArtifactId) {
      ctx.addIssue({
        code: 'custom',
        message: 'sourceArtifactId is required for document tasks',
        path: ['sourceArtifactId'],
      });
    }
  });
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

export const QueueMessageSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  priority: z.number().int(),
  createdAt: z.number().int(),
});
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

export const ArtifactRefSchema = z.object({
  id: z.string(),
  key: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ExecutionResultSchema = z.object({
  taskId: z.string(),
  attemptId: z.string(),
  engine: ExecutedEngineSchema,
  success: z.boolean(),
  content: z
    .object({
      markdown: z.string().optional(),
      text: z.string().optional(),
      htmlArtifactId: z.string().optional(),
    })
    .optional(),
  artifacts: z.array(ArtifactRefSchema),
  timing: z.object({
    totalMs: z.number().nonnegative(),
    navigationMs: z.number().nonnegative().optional(),
    extractionMs: z.number().nonnegative().optional(),
  }),
  confidence: z.number().min(0).max(1).optional(),
  fallbackChain: z.array(z.string()),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const InternalTaskSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  type: z.enum(['scrape', 'browser', 'document']),
  status: TaskStatusSchema,
  url: z.string().nullable(),
  preferredEngine: EngineSchema,
  selectedEngine: ExecutedEngineSchema.nullable(),
  requiresAuth: z.boolean(),
  destructive: z.boolean(),
  priority: z.number().int(),
  payload: TaskCreateSchema,
  maxAttempts: z.number().int(),
  attemptCount: z.number().int(),
  timeoutMs: z.number().int().nullable(),
  cancelRequested: z.boolean(),
});
export type InternalTask = z.infer<typeof InternalTaskSchema>;

export const ErrorCodeSchema = z.enum([
  'TRANSIENT_NETWORK',
  'TIMEOUT',
  'RATE_LIMIT',
  'ENGINE_CRASH',
  'PAGE_ERROR',
  'AUTH_REQUIRED',
  'CHALLENGE',
  'INVALID_INPUT',
  'DESTRUCTIVE_UNKNOWN',
  'SSRF_BLOCKED',
  'OCR_REQUIRED',
  'CANCELLED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
