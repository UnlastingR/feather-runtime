import { describe, expect, it } from 'vitest';
import { decidePullGuard, Semaphore } from './resource-gate.js';

describe('Semaphore', () => {
  it('does not exceed configured concurrency', async () => {
    const semaphore = new Semaphore(1);
    const releaseFirst = await semaphore.acquire();
    let secondAcquired = false;
    const second = semaphore.acquire().then((release) => {
      secondAcquired = true;
      release();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquired).toBe(false);
    releaseFirst();
    await second;
    expect(secondAcquired).toBe(true);
  });
});

describe('memory/capacity pull guard', () => {
  it('stops queue intake under critical memory pressure', () => {
    expect(decidePullGuard(199, 200, 0, 4)).toBe('critical-memory');
    expect(decidePullGuard(200, 200, 4, 4)).toBe('at-capacity');
    expect(decidePullGuard(350, 200, 1, 4)).toBe('pull');
  });
});
