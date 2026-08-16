import { randomUUID } from 'node:crypto';
import { sha256, signHmac } from '@feather/shared';
import type { ArtifactRef, ExecutedEngine } from '@feather/protocol';
import type { AgentConfig } from './config.js';

export interface TaskEnvelope {
  task: unknown;
  policy: Record<string, unknown> | null;
  hint: Record<string, unknown> | null;
}

export class ControlPlaneClient {
  constructor(private readonly config: AgentConfig) {}

  async register(payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(
      new URL('/internal/nodes/register', this.config.CONTROL_PLANE_URL),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bootstrap-token': this.config.NODE_BOOTSTRAP_TOKEN,
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok)
      throw new Error(`Node registration failed: ${response.status} ${await response.text()}`);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const rawBody =
      body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const response = await this.signedFetch(
      method,
      path,
      rawBody,
      body === undefined ? undefined : 'application/json',
    );
    if (!response.ok)
      throw new Error(
        `Control plane ${method} ${path} failed: ${response.status} ${await response.text()}`,
      );
    return response.json() as Promise<T>;
  }

  async getTask(taskId: string): Promise<TaskEnvelope> {
    return this.request<TaskEnvelope>('GET', `/internal/tasks/${taskId}`);
  }

  async getArtifact(artifactId: string): Promise<{ bytes: Buffer; mime: string }> {
    const path = `/internal/artifacts/${artifactId}`;
    const response = await this.signedFetch('GET', path, new Uint8Array());
    if (!response.ok)
      throw new Error(`Artifact download failed: ${response.status} ${await response.text()}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mime: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async uploadArtifact(
    taskId: string,
    attemptId: string,
    input: { bytes: Uint8Array; mime: string; kind: string; name: string },
  ): Promise<ArtifactRef> {
    const path = `/internal/tasks/${taskId}/attempts/${attemptId}/artifacts`;
    const response = await this.signedFetch('POST', path, input.bytes, input.mime, {
      'x-artifact-mime': input.mime,
      'x-artifact-kind': input.kind,
      'x-artifact-name': input.name,
    });
    if (!response.ok)
      throw new Error(`Artifact upload failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<ArtifactRef>;
  }

  async event(
    taskId: string,
    attemptId: string,
    event: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.request('POST', `/internal/tasks/${taskId}/event`, { attemptId, event, data });
  }

  async complete(
    taskId: string,
    input: {
      attemptId: string;
      engine: ExecutedEngine;
      resultArtifactId?: string;
      durationMs: number;
      memoryPeakMb?: number;
      confidence?: number;
      fallbackChain: string[];
    },
  ): Promise<void> {
    await this.request('POST', `/internal/tasks/${taskId}/complete`, input);
  }

  async fail(
    taskId: string,
    input: {
      attemptId: string;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      durationMs: number;
      memoryPeakMb?: number;
    },
  ): Promise<void> {
    await this.request('POST', `/internal/tasks/${taskId}/fail`, input);
  }

  async heartbeat(input: Record<string, unknown>): Promise<void> {
    await this.request('POST', '/internal/nodes/heartbeat', input);
  }

  private async signedFetch(
    method: string,
    path: string,
    body: Uint8Array,
    contentType?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const bodyHash = sha256(body);
    const signature = signHmac(this.config.NODE_SECRET, {
      method,
      path,
      bodyHash,
      timestamp,
      nonce,
    });
    const headers: Record<string, string> = {
      'x-feather-node-id': this.config.NODE_ID,
      'x-feather-timestamp': timestamp,
      'x-feather-nonce': nonce,
      'x-feather-signature': signature,
      ...extraHeaders,
    };
    if (contentType) headers['content-type'] = contentType;
    return fetch(new URL(path, this.config.CONTROL_PLANE_URL), {
      method,
      headers,
      ...(body.byteLength > 0 ? { body: Buffer.from(body) } : {}),
    });
  }
}
