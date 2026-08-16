import { z } from 'zod';

const numberFromEnv = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  CONTROL_PLANE_URL: z.url(),
  NODE_ID: z.string().min(3),
  NODE_SECRET: z.string().min(24),
  NODE_BOOTSTRAP_TOKEN: z.string().min(8),
  CF_ACCOUNT_ID: z.string().min(1),
  CF_QUEUE_ID: z.string().min(1),
  CF_QUEUES_TOKEN: z.string().min(1),
  LIGHTPANDA_CDP_URL: z.url().default('http://lightpanda:9222'),
  CHROMIUM_BIN: z.string().default('/opt/chrome-headless-shell/chrome-headless-shell'),
  CHROMIUM_NO_SANDBOX: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
  QUEUE_VISIBILITY_TIMEOUT_MS: numberFromEnv(300_000),
  QUEUE_BATCH_SIZE: numberFromEnv(4),
  QUEUE_IDLE_POLL_MS: numberFromEnv(2_000),
  HEARTBEAT_MS: numberFromEnv(25_000),
  MAX_TOTAL_CONCURRENCY: numberFromEnv(4),
  MAX_LIGHTPANDA_CONCURRENCY: numberFromEnv(3),
  MAX_CHROMIUM_CONCURRENCY: numberFromEnv(1),
  MAX_OCR_CONCURRENCY: numberFromEnv(1),
  MIN_FREE_MEMORY_MB: numberFromEnv(350),
  CRITICAL_FREE_MEMORY_MB: numberFromEnv(200),
  HTTP_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  LIGHTPANDA_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  HTTP_TIMEOUT_MS: numberFromEnv(20_000),
  BROWSER_TIMEOUT_MS: numberFromEnv(45_000),
  MAX_DOWNLOAD_MB: numberFromEnv(20),
  HEALTH_PORT: numberFromEnv(8788),
});

export type AgentConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return schema.parse(env);
}
