import type { QueueMessage } from '@feather/protocol';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;
  JOBS: Queue<QueueMessage>;
  BOOTSTRAP_TOKEN: string;
  NODE_KEY_ENCRYPTION_KEY: string;
  API_HASH_PEPPER: string;
  AUTH_DISABLED: string;
}
