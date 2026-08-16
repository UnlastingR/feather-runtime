import { describe, expect, it } from 'vitest';
import { assertTaskTransition, canTransitionTask } from './index.js';

describe('TaskStateMachine', () => {
  it('allows only legal transitions', () => {
    expect(canTransitionTask('created', 'queued')).toBe(true);
    expect(canTransitionTask('queued', 'running')).toBe(false);
    expect(canTransitionTask('completed', 'queued')).toBe(false);
    expect(() => assertTaskTransition('running', 'completed')).not.toThrow();
    expect(() => assertTaskTransition('created', 'completed')).toThrow();
  });
});
