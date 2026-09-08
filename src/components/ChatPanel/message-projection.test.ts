import { describe, expect, test } from 'bun:test';
import { isProjectedRemnant } from './message-projection';

describe('projected assistant remnants', () => {
  test('keeps an error shell whose only segment is private thinking', () => {
    expect(isProjectedRemnant({
      status: 'error',
      segmentCount: 1,
      projectedSegmentCount: 0,
      projectedText: '',
      projectedToolCount: 0,
      subAgentCount: 0,
      ownsProcess: false,
    })).toBe(false);
  });

  test('still drops an otherwise empty completed shell', () => {
    expect(isProjectedRemnant({
      status: 'complete',
      segmentCount: 1,
      projectedSegmentCount: 0,
      projectedText: '',
      projectedToolCount: 0,
      subAgentCount: 0,
      ownsProcess: false,
    })).toBe(true);
  });
});
