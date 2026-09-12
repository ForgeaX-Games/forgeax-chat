import { expect, test } from 'bun:test';
import { gateSessionEvent, noteAppliedSeq } from './session-bridge';

test('replaying the parent must not discard the child terminal event', () => {
  const sid = 'parent-replay-child-terminal';
  expect(gateSessionEvent(sid, 'generation', 10, 'child')).toBe(true);
  noteAppliedSeq(sid, 'generation', 30, 'parent');
  expect(gateSessionEvent(sid, 'generation', 20, 'child')).toBe(true);
  expect(gateSessionEvent(sid, 'generation', 30, 'parent')).toBe(false);
  expect(gateSessionEvent(sid, 'generation', 31, 'parent')).toBe(true);
});

test('agent replay watermarks stay isolated across sessions and generations', () => {
  noteAppliedSeq('one', 'old', 100, 'agent');
  expect(gateSessionEvent('two', 'old', 1, 'agent')).toBe(true);
  expect(gateSessionEvent('one', 'new', 1, 'agent')).toBe(true);
  expect(gateSessionEvent('one', 'new', 1, 'agent')).toBe(false);
  expect(gateSessionEvent('one', 'new', 2, 'agent')).toBe(true);
});
