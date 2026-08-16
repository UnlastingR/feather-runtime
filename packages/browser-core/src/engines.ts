import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { assertPublicUrl, isBlockedIp, RuntimeError } from '@feather/shared';

async function assertBrowserUrlPublic(rawUrl: string): Promise<void> {
  const url = assertPublicUrl(rawUrl);
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  if (answers.length === 0) throw new RuntimeError('TRANSIENT_NETWORK', `DNS returned no addresses for ${url.hostname}`, true);
  for (const answer of answers) {
    if (isBlockedIp(answer.address)) throw new RuntimeError('SSRF_BLOCKED', `Browser DNS resolved to blocked IP ${answer.address}`, false);
  }
}

export interface NavigationResult {
  url: string;
  status?: number;
}

export interface BrowserEngine {
  launch(): Promise<void>;
  goto(url: string): Promise<NavigationResult>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  waitFor(selector: string, timeoutMs?: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  getContent(): Promise<string>;
  screenshot(fullPage?: boolean): Promise<Uint8Array>;
  close(): Promise<void>;
}

abstract class PuppeteerEngineBase implements BrowserEngine {
  protected browser: Browser | undefined;
  protected page: Page | undefined;
  protected readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  abstract launch(): Promise<void>;

  protected requirePage(): Page {
    if (!this.page) throw new RuntimeError('ENGINE_CRASH', 'Browser page is not available', true);
    return this.page;
  }

  async goto(url: string): Promise<NavigationResult> {
    await assertBrowserUrlPublic(url);
    const response = await this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    return { url: this.requirePage().url(), ...(response ? { status: response.status() } : {}) };
  }

  async click(selector: string): Promise<void> {
    await this.requirePage().click(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    const page = this.requirePage();
    await page.focus(selector);
    await page.$eval(selector, (element) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.value = '';
    });
    await page.type(selector, value);
  }

  async waitFor(selector: string, timeoutMs?: number): Promise<void> {
    await this.requirePage().waitForSelector(selector, { timeout: timeoutMs ?? this.timeoutMs });
  }

  async evaluate<T>(expression: string): Promise<T> {
    return this.requirePage().evaluate((source) => {
      // The public API accepts JavaScript expressions, not shell commands. This executes in the page sandbox.
      return globalThis.eval(source) as unknown;
    }, expression) as Promise<T>;
  }

  async getContent(): Promise<string> {
    return this.requirePage().content();
  }

  async screenshot(fullPage = true): Promise<Uint8Array> {
    return this.requirePage().screenshot({ type: 'webp', fullPage, quality: 82 });
  }

  abstract close(): Promise<void>;
}

export class LightpandaEngine extends PuppeteerEngineBase {
  readonly cdpUrl: string;

  constructor(cdpUrl: string, timeoutMs: number) {
    super(timeoutMs);
    this.cdpUrl = cdpUrl;
  }

  async launch(): Promise<void> {
    const endpoint = new URL(this.cdpUrl);
    if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
    else if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
    endpoint.pathname = '/';
    endpoint.search = '';
    endpoint.hash = '';
    this.browser = await puppeteer.connect({ browserWSEndpoint: endpoint.toString() });
    this.page = await this.browser.newPage();
  }

  async close(): Promise<void> {
    try {
      await this.page?.close();
    } finally {
      this.browser?.disconnect();
      this.page = undefined;
      this.browser = undefined;
    }
  }
}

export class ChromiumEngine extends PuppeteerEngineBase {
  private readonly binary: string;
  private readonly noSandbox: boolean;
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private profileDir: string | undefined;

  constructor(binary: string, timeoutMs: number, noSandbox = false) {
    super(timeoutMs);
    this.binary = binary;
    this.noSandbox = noSandbox;
  }

  async launch(): Promise<void> {
    this.profileDir = await mkdtemp(join(tmpdir(), 'feather-chromium-'));
    this.process = spawn(this.binary, [
      '--headless',
      '--no-first-run',
      '--disable-dev-shm-usage',
      ...(this.noSandbox ? ['--no-sandbox'] : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new RuntimeError('ENGINE_CRASH', 'Chromium CDP endpoint timeout', true, 'chromium')), 10_000);
      let stderr = '';
      this.process?.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      this.process?.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.process?.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new RuntimeError('ENGINE_CRASH', `Chromium exited before CDP was ready (${code ?? 'signal'})`, true, 'chromium'));
      });
    });
    this.browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    await this.installRequestGuard(this.page);
  }

  private async installRequestGuard(page: Page): Promise<void> {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      void (async () => {
        try {
          const target = new URL(request.url());
          if (target.protocol === 'data:' || target.protocol === 'blob:') {
            await request.continue();
            return;
          }
          await assertBrowserUrlPublic(target.toString());
          await request.continue();
        } catch {
          await request.abort('blockedbyclient').catch(() => undefined);
        }
      })();
    });
  }

  async close(): Promise<void> {
    try {
      this.browser?.disconnect();
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => this.process?.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
        if (!this.process.killed && this.process.exitCode === null) this.process.kill('SIGKILL');
      }
    } finally {
      if (this.profileDir) await rm(this.profileDir, { recursive: true, force: true });
      this.page = undefined;
      this.browser = undefined;
      this.process = undefined;
      this.profileDir = undefined;
    }
  }
}
