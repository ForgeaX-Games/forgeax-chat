import { expect, test } from 'bun:test';
import type { ChatMessage } from '../../session-store';
import { isAgentHandoff, handoffNavigationTarget, hasRunningHandoff } from './handoff-messages';
import { messageReadSnapshot, unreadMessageCount } from './unread-messages';

const handoff = (from: string, to: string) => ({
  id: `${from}-${to}`, role: 'system', from, to, text: 'Long brief\nDetails',
} as ChatMessage);

test('both main-to-child and child-to-main routine messages belong to the feed', () => {
  expect(isAgentHandoff(handoff('forge', 'suzu'))).toBe(true);
  expect(isAgentHandoff(handoff('suzu', 'forge'))).toBe(true);
});

test('errors, warnings, assistant output and ordinary system events remain in the main timeline', () => {
  for (const change of [{level:'error'}, {level:'warning'}, {role:'assistant'}, {from:undefined}, {to:undefined}]) {
    expect(isAgentHandoff({...handoff('forge', 'suzu'), ...change} as ChatMessage)).toBe(false);
  }
});

test('handoffs do not create unread main messages; agent errors still do', () => {
  const message = handoff('forge', 'suzu');
  expect(messageReadSnapshot([message]).size).toBe(0);
  expect(unreadMessageCount([message], new Map())).toBe(0);
  expect(unreadMessageCount([{...message, level:'error'}], new Map())).toBe(1);
});

test('each handoff links its own counterpart for dispatch, completion and child views', () => {
  expect(handoffNavigationTarget(handoff('forge', 'suzu'), 'forge')).toBe('suzu');
  expect(handoffNavigationTarget(handoff('audio-designer', 'forge'), 'forge')).toBe('audio-designer');
  expect(handoffNavigationTarget(handoff('forge', 'suzu'), 'suzu')).toBe('forge');
  expect(handoffNavigationTarget(handoff('/root/forge#1', '/root/suzu#2'), 'forge')).toBe('suzu');
});
test('self messages and messages outside the visible thread offer no navigation', () => {
  expect(handoffNavigationTarget(handoff('forge', 'forge'), 'forge')).toBeNull();
  expect(handoffNavigationTarget(handoff('forge', 'suzu'), null)).toBeNull();
  expect(handoffNavigationTarget(handoff('forge', 'suzu'), 'audio-designer')).toBeNull();
  expect(handoffNavigationTarget({...handoff('forge', 'suzu'), level:'error'}, 'forge')).toBeNull();
});

test('Stop remains available for a live outgoing handoff, not unrelated or completed work', () => {
  const sent = handoff('forge', 'suzu');
  const returned = handoff('suzu', 'forge');
  expect(hasRunningHandoff([sent], 'forge', { suzu: true })).toBe(true);
  expect(hasRunningHandoff([sent], 'forge', { suzu: false })).toBe(false);
  expect(hasRunningHandoff([sent], 'forge', { rin: true })).toBe(false);
  expect(hasRunningHandoff([sent], 'suzu', { forge: true })).toBe(false);
  expect(hasRunningHandoff([sent, returned], 'forge', { suzu: true })).toBe(false);
  expect(hasRunningHandoff([sent, returned, sent], 'forge', { suzu: true })).toBe(true);
  expect(hasRunningHandoff([sent], null, { suzu: true })).toBe(false);
});
