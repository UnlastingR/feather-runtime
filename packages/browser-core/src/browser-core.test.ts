import { describe, expect, it } from 'vitest';
import { extractHtml, fallbackAfter, routeEngine, scoreExtraction } from './index.js';

describe('confidence scoring', () => {
  it('scores substantial static content highly', () => {
    const result = scoreExtraction({ statusCode: 200, contentType: 'text/html', bodySize: 8000, title: 'Article', textLength: 2000, mainContentLength: 1500 });
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('penalizes JS-required challenge pages', () => {
    const result = scoreExtraction({ statusCode: 200, textLength: 30, antiBotMarkers: 1, jsRequiredMarkers: 1 });
    expect(result.score).toBeLessThan(0.5);
  });
});

describe('router', () => {
  it('routes authentication directly to Chromium', () => {
    expect(routeEngine({ actionType: 'browser', requiresAuthentication: true, requiresPayment: false, destructive: false, preferredEngine: 'auto' })).toBe('chromium');
  });

  it('defaults ordinary scraping to HTTP and falls forward', () => {
    expect(routeEngine({ actionType: 'scrape', requiresAuthentication: false, requiresPayment: false, destructive: false, preferredEngine: 'auto' })).toBe('http');
    expect(fallbackAfter('http')).toBe('lightpanda');
    expect(fallbackAfter('lightpanda')).toBe('chromium');
  });
});

describe('HTML extraction', () => {
  it('extracts readable markdown', () => {
    const paragraph = 'Feather runtime chooses the least expensive capable engine. '.repeat(20);
    const result = extractHtml(`<html><head><title>Runtime</title></head><body><main><h1>Runtime</h1><p>${paragraph}</p></main></body></html>`, { statusCode: 200, contentType: 'text/html' });
    expect(result.markdown).toContain('# Runtime');
    expect(result.confidence.score).toBeGreaterThan(0.7);
  });
});
