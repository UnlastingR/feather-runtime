import { lookup as lookupCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { Agent, fetch } from 'undici';
import { assertPublicUrl, isBlockedIp, RuntimeError } from '@feather/shared';
import { extractHtml, type ExtractedPage } from './extract.js';

export interface HttpFastPathOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  selectors?: string[];
}

export interface HttpFastPathResult extends ExtractedPage {
  url: string;
  statusCode: number;
  contentType: string;
  rawHtml: string;
}

async function assertResolvedPublic(hostname: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0)
    throw new RuntimeError('TRANSIENT_NETWORK', 'DNS returned no addresses', true, 'http');
  for (const { address } of addresses) {
    if (isBlockedIp(address))
      throw new RuntimeError(
        'SSRF_BLOCKED',
        `DNS resolved to blocked IP ${address}`,
        false,
        'http',
      );
  }
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookupCallback(hostname, options, (error, address, family) => {
    if (error) {
      callback(error, address, family);
      return;
    }
    if (typeof address === 'string' && isBlockedIp(address)) {
      const blocked = Object.assign(new Error(`Blocked DNS result for ${hostname}: ${address}`), {
        code: 'EACCES',
      });
      callback(blocked, address, family);
      return;
    }
    callback(null, address, family);
  });
};

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RuntimeError('PAGE_ERROR', `Response exceeds ${maxBytes} bytes`, false, 'http');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export async function httpFastPath(
  rawUrl: string,
  options: HttpFastPathOptions,
): Promise<HttpFastPathResult> {
  let url = assertPublicUrl(rawUrl);
  const maxRedirects = options.maxRedirects ?? 10;
  const dispatcher = new Agent({
    connect: { timeout: Math.min(options.timeoutMs, 10_000), lookup: safeLookup },
  });
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      await assertResolvedPublic(url.hostname);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          dispatcher,
          headers: {
            'user-agent': 'FeatherRuntime/0.1 (+https://example.invalid/runtime)',
            accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          },
        });
      } catch (error) {
        if (controller.signal.aborted)
          throw new RuntimeError(
            'TIMEOUT',
            `HTTP timeout after ${options.timeoutMs}ms`,
            true,
            'http',
          );
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location)
          throw new RuntimeError('PAGE_ERROR', 'Redirect without Location header', false, 'http');
        if (redirects === maxRedirects)
          throw new RuntimeError('PAGE_ERROR', 'Too many redirects', false, 'http');
        url = assertPublicUrl(new URL(location, url).toString());
        continue;
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const rawHtml = await readLimitedBody(response as unknown as Response, options.maxBytes);
      if (!contentType.includes('html') && !contentType.startsWith('text/')) {
        throw new RuntimeError(
          'PAGE_ERROR',
          `HTTP fast path unsupported content-type: ${contentType}`,
          false,
          'http',
        );
      }
      const extracted = extractHtml(rawHtml, {
        statusCode: response.status,
        contentType,
        ...(options.selectors !== undefined ? { selectors: options.selectors } : {}),
      });
      return {
        ...extracted,
        url: url.toString(),
        statusCode: response.status,
        contentType,
        rawHtml,
      };
    }
  } finally {
    await dispatcher.close();
  }
  throw new RuntimeError('PAGE_ERROR', 'Redirect loop exhausted', false, 'http');
}
