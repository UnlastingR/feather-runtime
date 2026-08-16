import { extname } from 'node:path';
import { freemem } from 'node:os';
import { z } from 'zod';
import {
  ChromiumEngine,
  extractHtml,
  fallbackAfter,
  httpFastPath,
  LightpandaEngine,
  routeEngine,
  type BrowserEngine,
  type DomainPolicy,
  type EngineHint,
} from '@feather/browser-core';
import { DocumentRouter } from '@feather/document-core';
import {
  InternalTaskSchema,
  type ArtifactRef,
  type BrowserAction,
  type ExecutedEngine,
  type InternalTask,
} from '@feather/protocol';
import { assertPublicUrl, classifyError, RuntimeError } from '@feather/shared';
import type { AgentConfig } from './config.js';
import { ControlPlaneClient } from './api-client.js';
import { Semaphore } from './resource-gate.js';

const startResponseSchema = z.object({
  execute: z.boolean(),
  reason: z.string().optional(),
  retry: z.boolean().optional(),
});

interface RunResult {
  engine: ExecutedEngine;
  markdown: string;
  text?: string;
  confidence?: number;
  rawHtml?: string;
  artifacts: ArtifactRef[];
  fallbackChain: string[];
}

function mapPolicy(raw: Record<string, unknown> | null): DomainPolicy | undefined {
  if (!raw) return undefined;
  const engine = (value: unknown): 'http' | 'lightpanda' | 'chromium' | undefined =>
    value === 'http' || value === 'lightpanda' || value === 'chromium' ? value : undefined;
  const preferred = engine(raw['preferred_engine']);
  const force = engine(raw['force_engine']);
  return {
    ...(preferred ? { preferredEngine: preferred } : {}),
    ...(force ? { forceEngine: force } : {}),
    allowHttp: raw['allow_http'] !== 0,
    allowLightpanda: raw['allow_lightpanda'] !== 0,
    allowChromium: raw['allow_chromium'] !== 0,
    requiresChromium: raw['requires_chromium'] === 1,
  };
}

function mapHint(raw: Record<string, unknown> | null): EngineHint | undefined {
  if (!raw) return undefined;
  const preferred = raw['preferred'];
  const confidence = raw['confidence'];
  if (
    (preferred !== 'http' && preferred !== 'lightpanda' && preferred !== 'chromium') ||
    typeof confidence !== 'number'
  )
    return undefined;
  const fallback = raw['fallback'];
  return {
    preferred,
    confidence,
    ...(fallback === 'http' || fallback === 'lightpanda' || fallback === 'chromium'
      ? { fallback }
      : {}),
  };
}

export class TaskRunner {
  private readonly documents = new DocumentRouter();
  private readonly lightpandaGate: Semaphore;
  private readonly chromiumGate: Semaphore;

  constructor(
    private readonly config: AgentConfig,
    private readonly api: ControlPlaneClient,
  ) {
    this.lightpandaGate = new Semaphore(config.MAX_LIGHTPANDA_CONCURRENCY);
    this.chromiumGate = new Semaphore(config.MAX_CHROMIUM_CONCURRENCY);
  }

  get chromiumActive(): number {
    return this.chromiumGate.inUse;
  }

  async run(taskId: string, attemptId: string, idempotencyKey: string): Promise<'ack' | 'retry'> {
    const startedAt = Date.now();
    let peakMemoryMb = Math.ceil(process.memoryUsage().rss / 1024 / 1024);
    let startAccepted = false;
    try {
      const envelope = await this.api.getTask(taskId);
      const task = InternalTaskSchema.parse(envelope.task);
      const policy = mapPolicy(envelope.policy);
      const hint = mapHint(envelope.hint);
      const firstEngine = routeEngine({
        actionType: task.type,
        requiresAuthentication: task.requiresAuth,
        requiresPayment: task.payload.requiresPayment,
        destructive: task.destructive,
        preferredEngine: task.preferredEngine,
        ...(policy ? { policy } : {}),
        ...(hint ? { hint } : {}),
      });
      const start = startResponseSchema.parse(
        await this.api.request('POST', `/internal/tasks/${taskId}/start`, {
          attemptId,
          idempotencyKey,
          engine: firstEngine,
        }),
      );
      if (!start.execute) return start.retry ? 'retry' : 'ack';
      startAccepted = true;
      const result =
        task.type === 'document'
          ? await this.runDocument(task, attemptId)
          : await this.runWeb(
              task,
              attemptId,
              firstEngine === 'document' ? 'http' : firstEngine,
              policy,
            );
      peakMemoryMb = Math.max(peakMemoryMb, Math.ceil(process.memoryUsage().rss / 1024 / 1024));
      const resultArtifact = await this.api.uploadArtifact(task.id, attemptId, {
        bytes: new TextEncoder().encode(result.markdown),
        mime: 'text/markdown; charset=utf-8',
        kind: 'result',
        name: 'result.md',
      });
      result.artifacts.push(resultArtifact);
      await this.api.complete(task.id, {
        attemptId,
        engine: result.engine,
        resultArtifactId: resultArtifact.id,
        durationMs: Date.now() - startedAt,
        memoryPeakMb: peakMemoryMb,
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        fallbackChain: result.fallbackChain,
      });
      return 'ack';
    } catch (error) {
      if (!startAccepted) return 'retry';
      const runtimeError = classifyError(error);
      peakMemoryMb = Math.max(peakMemoryMb, Math.ceil(process.memoryUsage().rss / 1024 / 1024));
      try {
        await this.api.fail(taskId, {
          attemptId,
          errorCode: runtimeError.code,
          errorMessage: runtimeError.message.slice(0, 2000),
          retryable: runtimeError.retryable,
          durationMs: Date.now() - startedAt,
          memoryPeakMb: peakMemoryMb,
        });
        return 'ack';
      } catch {
        return 'retry';
      }
    }
  }

  private async runDocument(task: InternalTask, attemptId: string): Promise<RunResult> {
    const sourceId = task.payload.sourceArtifactId;
    if (!sourceId)
      throw new RuntimeError(
        'INVALID_INPUT',
        'Document task lacks sourceArtifactId',
        false,
        'document',
      );
    const source = await this.api.getArtifact(sourceId);
    const filename =
      typeof task.payload.metadata['filename'] === 'string'
        ? task.payload.metadata['filename']
        : 'document.bin';
    const extension = extname(filename).slice(1).toLowerCase();
    const parsed = await this.documents.parse(source.bytes, { mime: source.mime, extension });
    await this.api.event(task.id, attemptId, 'document.parsed', {
      parser: parsed.parser,
      confidence: parsed.confidence,
    });
    return {
      engine: 'document',
      markdown: parsed.markdown,
      confidence: parsed.confidence,
      artifacts: [],
      fallbackChain: ['document'],
    };
  }

  private async runWeb(
    task: InternalTask,
    attemptId: string,
    firstEngine: 'http' | 'lightpanda' | 'chromium',
    policy?: DomainPolicy,
  ): Promise<RunResult> {
    if (!task.url) throw new RuntimeError('INVALID_INPUT', 'Web task lacks URL', false);
    assertPublicUrl(task.url);
    let engine: 'http' | 'lightpanda' | 'chromium' = firstEngine;
    const chain: string[] = [];
    while (true) {
      chain.push(engine);
      if (engine === 'http') {
        try {
          const result = await httpFastPath(task.url, {
            timeoutMs: task.timeoutMs ?? this.config.HTTP_TIMEOUT_MS,
            maxBytes: this.config.MAX_DOWNLOAD_MB * 1024 * 1024,
            selectors: task.payload.selectors,
          });
          if (result.confidence.score >= this.config.HTTP_CONFIDENCE_THRESHOLD) {
            const raw = await this.api.uploadArtifact(task.id, attemptId, {
              bytes: new TextEncoder().encode(result.rawHtml),
              mime: 'text/html; charset=utf-8',
              kind: 'debug',
              name: 'page.html',
            });
            return {
              engine: 'http',
              markdown: result.markdown,
              text: result.text,
              confidence: result.confidence.score,
              rawHtml: result.rawHtml,
              artifacts: [raw],
              fallbackChain: chain,
            };
          }
          await this.api.event(task.id, attemptId, 'http.failed', {
            reason: 'low_confidence',
            confidence: result.confidence.score,
            reasons: result.confidence.reasons,
          });
        } catch (error) {
          const classified = classifyError(error);
          await this.api.event(task.id, attemptId, 'http.failed', {
            errorCode: classified.code,
            message: classified.message.slice(0, 300),
          });
          if (classified.code === 'SSRF_BLOCKED') throw classified;
        }
      } else {
        try {
          return await this.runBrowser(task, attemptId, engine, chain);
        } catch (error) {
          const classified = classifyError(error);
          await this.api.event(task.id, attemptId, `${engine}.failed`, {
            errorCode: classified.code,
            message: classified.message.slice(0, 300),
          });
          if (
            classified.code === 'SSRF_BLOCKED' ||
            classified.code === 'AUTH_REQUIRED' ||
            classified.code === 'CHALLENGE'
          )
            throw classified;
        }
      }
      const next = fallbackAfter(engine, policy);
      if (!next)
        throw new RuntimeError(
          'PAGE_ERROR',
          `All permitted engines failed: ${chain.join(' -> ')}`,
          false,
          engine,
        );
      engine = next;
    }
  }

  private async runBrowser(
    task: InternalTask,
    attemptId: string,
    engineName: 'lightpanda' | 'chromium',
    chain: string[],
  ): Promise<RunResult> {
    const freeMb = Math.floor(freemem() / 1024 / 1024);
    if (engineName === 'chromium' && freeMb < this.config.MIN_FREE_MEMORY_MB)
      throw new RuntimeError(
        'ENGINE_CRASH',
        `Insufficient free memory for Chromium: ${freeMb} MB`,
        true,
        'chromium',
      );
    const gate = engineName === 'chromium' ? this.chromiumGate : this.lightpandaGate;
    const release = await gate.acquire();
    const browser: BrowserEngine =
      engineName === 'chromium'
        ? new ChromiumEngine(
            this.config.CHROMIUM_BIN,
            task.timeoutMs ?? this.config.BROWSER_TIMEOUT_MS,
            this.config.CHROMIUM_NO_SANDBOX,
          )
        : new LightpandaEngine(
            this.config.LIGHTPANDA_CDP_URL,
            task.timeoutMs ?? this.config.BROWSER_TIMEOUT_MS,
          );
    const artifacts: ArtifactRef[] = [];
    try {
      await this.api.event(task.id, attemptId, `${engineName}.started`, {});
      await browser.launch();
      await browser.goto(task.url ?? 'about:blank');
      if (task.type === 'browser') {
        for (const action of task.payload.actions) {
          const fresh = InternalTaskSchema.parse((await this.api.getTask(task.id)).task);
          if (fresh.cancelRequested)
            throw new RuntimeError('CANCELLED', 'Task cancellation requested', false, engineName);
          await this.performAction(browser, action, task, attemptId, artifacts);
        }
      }
      const html = await browser.getContent();
      const extracted = extractHtml(html, {
        statusCode: 200,
        contentType: 'text/html',
        selectors: task.payload.selectors,
      });
      if (
        extracted.confidence.score < this.config.LIGHTPANDA_CONFIDENCE_THRESHOLD &&
        engineName === 'lightpanda'
      ) {
        throw new RuntimeError(
          'PAGE_ERROR',
          `Lightpanda render confidence ${extracted.confidence.score} below threshold`,
          false,
          'lightpanda',
        );
      }
      const raw = await this.api.uploadArtifact(task.id, attemptId, {
        bytes: new TextEncoder().encode(html),
        mime: 'text/html; charset=utf-8',
        kind: 'debug',
        name: `${engineName}-page.html`,
      });
      artifacts.push(raw);
      return {
        engine: engineName,
        markdown: extracted.markdown,
        text: extracted.text,
        confidence: extracted.confidence.score,
        rawHtml: html,
        artifacts,
        fallbackChain: [...chain],
      };
    } finally {
      await browser.close().catch(() => undefined);
      release();
    }
  }

  private async performAction(
    browser: BrowserEngine,
    action: BrowserAction,
    task: InternalTask,
    attemptId: string,
    artifacts: ArtifactRef[],
  ): Promise<void> {
    switch (action.type) {
      case 'goto': {
        const target = action.url ?? task.url;
        if (!target) throw new RuntimeError('INVALID_INPUT', 'goto action lacks URL', false);
        assertPublicUrl(target);
        await browser.goto(target);
        break;
      }
      case 'click':
        await browser.click(action.selector);
        break;
      case 'fill':
        await browser.fill(action.selector, action.value);
        break;
      case 'wait':
        await browser.waitFor(action.selector, action.timeoutMs);
        break;
      case 'extract':
        if (action.selector) await browser.waitFor(action.selector);
        break;
      case 'evaluate':
        await browser.evaluate(action.expression);
        break;
      case 'screenshot': {
        const bytes = await browser.screenshot(action.fullPage);
        artifacts.push(
          await this.api.uploadArtifact(task.id, attemptId, {
            bytes,
            mime: 'image/webp',
            kind: 'screenshot',
            name: 'screenshot.webp',
          }),
        );
        break;
      }
    }
  }
}
