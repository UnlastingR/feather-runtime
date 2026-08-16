import { cpus, freemem, hostname, loadavg, totalmem } from 'node:os';
import Fastify from 'fastify';
import pino from 'pino';
import { redact } from '@feather/shared';
import { loadConfig } from './config.js';
import { ControlPlaneClient } from './api-client.js';
import { QueueClient, type PulledMessage } from './queue-client.js';
import { decidePullGuard, Semaphore } from './resource-gate.js';
import { TaskRunner } from './runner.js';

const VERSION = '0.1.0';
const config = loadConfig();
const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      '*.authorization',
      '*.token',
      '*.secret',
      '*.password',
      'config.CF_QUEUES_TOKEN',
      'config.NODE_SECRET',
      'config.NODE_BOOTSTRAP_TOKEN',
    ],
    censor: '[REDACTED]',
  },
});
const api = new ControlPlaneClient(config);
const queue = new QueueClient(config);
const runner = new TaskRunner(config, api);
const totalGate = new Semaphore(config.MAX_TOTAL_CONCURRENCY);
let draining = false;
let lightpandaHealthy = false;
const active = new Set<Promise<void>>();

async function checkLightpanda(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/json/version', config.LIGHTPANDA_CDP_URL), {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function register(): Promise<void> {
  await api.register({
    nodeId: config.NODE_ID,
    secret: config.NODE_SECRET,
    hostname: hostname(),
    agentVersion: VERSION,
    architecture: process.arch,
    cpuCount: cpus().length,
    memoryMb: Math.floor(totalmem() / 1024 / 1024),
    capabilities: { http: true, document: true, lightpanda: true, chromium: true, ocr: false },
  });
}

async function heartbeat(): Promise<void> {
  lightpandaHealthy = await checkLightpanda();
  const memoryUsedMb = Math.floor((totalmem() - freemem()) / 1024 / 1024);
  await api.heartbeat({
    nodeId: config.NODE_ID,
    version: VERSION,
    status: draining ? 'draining' : 'online',
    cpuLoad: loadavg()[0] ?? 0,
    memoryUsedMb,
    activeTasks: totalGate.inUse,
    lightpandaHealthy,
    chromiumRunning: runner.chromiumActive,
  });
}

async function processMessage(message: PulledMessage): Promise<void> {
  const release = await totalGate.acquire();
  try {
    const disposition = await runner.run(
      message.body.taskId,
      message.body.attemptId,
      message.body.idempotencyKey,
    );
    if (disposition === 'ack') await queue.acknowledge([message.leaseId]);
    else await queue.retry([message.leaseId], 5);
  } catch (error) {
    logger.error(
      redact({
        event: 'message.process.failed',
        messageId: message.id,
        taskId: message.body.taskId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await queue
      .retry([message.leaseId], 5)
      .catch((retryError) =>
        logger.error({ event: 'queue.retry.failed', error: String(retryError) }),
      );
  } finally {
    release();
  }
}

async function pollLoop(): Promise<void> {
  while (!draining) {
    const freeMb = Math.floor(freemem() / 1024 / 1024);
    if (
      decidePullGuard(
        freeMb,
        config.CRITICAL_FREE_MEMORY_MB,
        totalGate.inUse,
        config.MAX_TOTAL_CONCURRENCY,
      ) !== 'pull'
    ) {
      await new Promise((resolve) => setTimeout(resolve, config.QUEUE_IDLE_POLL_MS));
      continue;
    }
    try {
      const capacity = Math.max(0, config.MAX_TOTAL_CONCURRENCY - totalGate.inUse);
      const messages = await queue.pull(Math.min(config.QUEUE_BATCH_SIZE, capacity));
      if (messages.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, config.QUEUE_IDLE_POLL_MS));
        continue;
      }
      for (const message of messages) {
        const promise = processMessage(message).finally(() => active.delete(promise));
        active.add(promise);
      }
    } catch (error) {
      logger.error(
        redact({
          event: 'queue.pull.failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

const health = Fastify({ logger: false });
health.get('/health', async () => ({
  status: draining ? 'draining' : 'ok',
  queue: !draining,
  lightpanda: lightpandaHealthy,
  chromium: { active: runner.chromiumActive, max: config.MAX_CHROMIUM_CONCURRENCY },
  activeTasks: totalGate.inUse,
  freeMemoryMb: Math.floor(freemem() / 1024 / 1024),
}));

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  logger.info({ event: 'agent.draining', signal, activeTasks: active.size });
  await heartbeat().catch(() => undefined);
  await Promise.allSettled([...active]);
  await health.close();
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
  await register();
  lightpandaHealthy = await checkLightpanda();
  await health.listen({ host: '127.0.0.1', port: config.HEALTH_PORT });
  const heartbeatTimer = setInterval(
    () =>
      void heartbeat().catch((error) =>
        logger.warn({ event: 'heartbeat.failed', error: String(error) }),
      ),
    config.HEARTBEAT_MS,
  );
  heartbeatTimer.unref();
  logger.info({
    event: 'agent.started',
    nodeId: config.NODE_ID,
    version: VERSION,
    lightpandaHealthy,
  });
  await pollLoop();
  clearInterval(heartbeatTimer);
}

main().catch((error) => {
  logger.fatal(
    redact({
      event: 'agent.fatal',
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
  );
  process.exitCode = 1;
});
