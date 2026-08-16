import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { ErrorCode, ExecutedEngine } from '@feather/protocol';

export class RuntimeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly engine?: ExecutedEngine;

  constructor(code: ErrorCode, message: string, retryable: boolean, engine?: ExecutedEngine) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.retryable = retryable;
    if (engine !== undefined) this.engine = engine;
  }
}

export function classifyError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout/i.test(message)) return new RuntimeError('TIMEOUT', message, true);
  if (/ECONN|ENET|EAI_AGAIN|fetch failed|socket/i.test(message)) {
    return new RuntimeError('TRANSIENT_NETWORK', message, true);
  }
  return new RuntimeError('INTERNAL', message, false);
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface HmacInput {
  method: string;
  path: string;
  bodyHash: string;
  timestamp: string;
  nonce: string;
}

export function canonicalHmacInput(input: HmacInput): string {
  return [input.method.toUpperCase(), input.path, input.bodyHash, input.timestamp, input.nonce].join('\n');
}

export function signHmac(secret: string, input: HmacInput): string {
  return createHmac('sha256', secret).update(canonicalHmacInput(input)).digest('hex');
}

export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

const redactedKeys = /authorization|cookie|set-cookie|password|token|secret|api[_-]?key/i;

export function redact<T>(value: T): T {
  return redactInner(value, new WeakSet<object>()) as T;
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactInner(entry, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactedKeys.test(key) ? '[REDACTED]' : redactInner(entry, seen);
  }
  return result;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(ip: string, network: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, bits]) => inV4Range(ip, network as string, bits as number));
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

export function assertPublicUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new RuntimeError('SSRF_BLOCKED', 'Only HTTP(S) URLs are allowed', false);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new RuntimeError('SSRF_BLOCKED', `Blocked hostname: ${hostname}`, false);
  }
  if (isIP(hostname) && isBlockedIp(hostname)) throw new RuntimeError('SSRF_BLOCKED', `Blocked IP: ${hostname}`, false);
  return url;
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}
