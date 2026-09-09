import { describe, expect, it } from 'bun:test';
import { defaultProcessOpen } from './process-visibility';
import { defaultStepOpen, defaultTaskOpen, defaultTodoExecutionOpen, effectiveStepOpen, formatDuration } from './process-display';

describe('execution phase default visibility', () => {
  it('folds the whole phase only after an artifact is presented', () => {
    expect(defaultProcessOpen(true, false)).toBe(true);
    expect(defaultProcessOpen(false, false)).toBe(true);
    expect(defaultProcessOpen(false, true)).toBe(false);
  });

  it('folds a failed or aborted execution by default even without an artifact', () => {
    expect(defaultProcessOpen(false, false, true)).toBe(false);
  });
});

describe('execution lifecycle defaults', () => {
  it('never renders a zero worked duration', () => {
    expect(formatDuration(0)).toBe('0.1s');
    expect(formatDuration(Number.NaN)).toBe('0.1s');
    expect(formatDuration(41_000)).toBe('41s');
  });

  it('formats elapsed time across minute and hour boundaries', () => {
    expect(formatDuration(59_499)).toBe('59s');
    expect(formatDuration(59_500)).toBe('1m00s');
    expect(formatDuration(2_142_000)).toBe('35m42s');
    expect(formatDuration(3_599_500)).toBe('1h00m00s');
    expect(formatDuration(3_661_000)).toBe('1h01m01s');
    expect(formatDuration(90_061_000)).toBe('25h01m01s');
  });

  it('opens Todo only while work is active by default', () => {
    expect(defaultTodoExecutionOpen(true)).toBe(true);
    expect(defaultTodoExecutionOpen(false)).toBe(false);
  });

  it('opens only the currently running child task by default', () => {
    expect(defaultTaskOpen({ defaultOpen: false, archive: false, running: true })).toBe(true);
    expect(defaultTaskOpen({ defaultOpen: false, archive: false, running: false })).toBe(false);
    expect(defaultTaskOpen({ defaultOpen: false, archive: true, running: true })).toBe(false);
  });

  it('keeps failed tool detail folded and lets explicit state control it', () => {
    expect(defaultStepOpen({ status: 'error' })).toBe(false);
    expect(defaultStepOpen({ status: 'error', parentRunning: true, latest: true })).toBe(false);
    expect(effectiveStepOpen(false, 'error')).toBe(false);
    expect(effectiveStepOpen(true, 'error')).toBe(true);
    expect(effectiveStepOpen(false, 'running')).toBe(true);
  });
});
