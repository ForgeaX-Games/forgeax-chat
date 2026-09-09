import { describe, expect, test } from 'bun:test';
import { isProjectedRemnant } from './message-projection';
import { projectWorkTimeline } from '../../task-flow/project';
import type { TaskFlowMessage } from '../../task-flow/model';

describe('projected assistant remnants', () => {
  test('retains the live card throughout private-only updates without exposing reasoning', () => {
    for (const text of ['', 'private reasoning', 'private reasoning continues']) {
      const message: TaskFlowMessage = {
        id: 'reply', role: 'assistant', text: '', status: 'streaming',
        toolCalls: [], ts: 1,
        segments: text ? [{ kind: 'thinking', text, ts: 2 }] : [],
      };
      const projection = projectWorkTimeline([message]);
      const item = projection.timeline.find((entry) => entry.kind === 'message');
      expect(item?.kind).toBe('message');
      if (item?.kind !== 'message') throw new Error('Missing live reply');
      expect(item.segmentIndexes).toEqual([]);
      expect(Object.keys(projection.processesById)).toHaveLength(0);
      expect(isProjectedRemnant({
        status: message.status, segmentCount: message.segments!.length,
        projectedSegmentCount: item.segmentIndexes.length, projectedText: '',
        projectedToolCount: 0, subAgentCount: 0, ownsProcess: false,
      })).toBe(false);
    }
  });

  test('keeps the running response visible while private reasoning is filtered out', () => {
    expect(isProjectedRemnant({
      status: 'streaming',
      segmentCount: 1,
      projectedSegmentCount: 0,
      projectedText: '',
      projectedToolCount: 0,
      subAgentCount: 0,
      ownsProcess: false,
    })).toBe(false);
  });

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
