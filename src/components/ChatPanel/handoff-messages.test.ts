import { expect, test } from 'bun:test';
import type { ChatMessage } from '../../session-store';
import { isAgentHandoff } from './handoff-messages';
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
