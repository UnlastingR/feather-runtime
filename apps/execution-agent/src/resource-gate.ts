export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

export type PullGuardDecision = 'pull' | 'critical-memory' | 'at-capacity';

export function decidePullGuard(
  freeMemoryMb: number,
  criticalFreeMemoryMb: number,
  activeTasks: number,
  maxTotalConcurrency: number,
): PullGuardDecision {
  if (freeMemoryMb < criticalFreeMemoryMb) return 'critical-memory';
  if (activeTasks >= maxTotalConcurrency) return 'at-capacity';
  return 'pull';
}
