import { z } from 'zod';
import { QueueMessageSchema, type QueueMessage } from '@feather/protocol';
import type { AgentConfig } from './config.js';

const pullResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({
    message_backlog_count: z.number().optional(),
    messages: z.array(
      z.object({
        body: z.unknown(),
        id: z.string(),
        timestamp_ms: z.number(),
        attempts: z.number(),
        lease_id: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  }),
});

export interface PulledMessage {
  id: string;
  leaseId: string;
  attempts: number;
  body: QueueMessage;
}

function decodeMessageBody(raw: unknown, metadata?: Record<string, unknown>): QueueMessage {
  const contentType = metadata?.['CF-Content-Type'];
  if (contentType === 'json' && typeof raw === 'string') {
    try {
      return QueueMessageSchema.parse(JSON.parse(raw));
    } catch {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      return QueueMessageSchema.parse(JSON.parse(decoded));
    }
  }
  if (typeof raw === 'string') {
    try {
      return QueueMessageSchema.parse(JSON.parse(raw));
    } catch {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      return QueueMessageSchema.parse(JSON.parse(decoded));
    }
  }
  return QueueMessageSchema.parse(raw);
}

export class QueueClient {
  private readonly baseUrl: string;

  constructor(private readonly config: AgentConfig) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.CF_ACCOUNT_ID}/queues/${config.CF_QUEUE_ID}/messages`;
  }

  async pull(batchSize: number): Promise<PulledMessage[]> {
    const response = await this.call('/pull', {
      visibility_timeout_ms: this.config.QUEUE_VISIBILITY_TIMEOUT_MS,
      batch_size: batchSize,
    });
    const parsed = pullResponseSchema.parse(response);
    if (!parsed.success) throw new Error('Cloudflare queue pull returned success=false');
    return parsed.result.messages.map((message) => ({
      id: message.id,
      leaseId: message.lease_id,
      attempts: message.attempts,
      body: decodeMessageBody(message.body, message.metadata),
    }));
  }

  async acknowledge(leaseIds: string[]): Promise<void> {
    if (leaseIds.length === 0) return;
    await this.call('/ack', { acks: leaseIds.map((lease_id) => ({ lease_id })), retries: [] });
  }

  async retry(leaseIds: string[], delaySeconds?: number): Promise<void> {
    if (leaseIds.length === 0) return;
    await this.call('/ack', {
      acks: [],
      retries: leaseIds.map((lease_id) => ({
        lease_id,
        ...(delaySeconds !== undefined ? { delay_seconds: delaySeconds } : {}),
      })),
    });
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.CF_QUEUES_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(
        `Cloudflare Queue API ${path} failed: ${response.status} ${await response.text()}`,
      );
    return response.json();
  }
}
