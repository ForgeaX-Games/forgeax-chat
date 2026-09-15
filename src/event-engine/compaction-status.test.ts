import { afterEach, beforeEach, expect, test } from 'bun:test';
import { useShellStore, type ChatMessage } from '@forgeax/interface/store';
import { getLocale, setLocale, t } from '@/i18n';
import { useChatStore } from '../session-store/store';
import { dispatchSessionEvent } from '../session-store/session-stream';
import { buildMainCallbacks, makeInMemEffects } from './message-builder';
import { TurnAccumulator } from './turn-accumulator';
import { formatEvent } from './event-formatter';
import { trimToCompactBoundary } from './event-replay';
import type { StoredEvent } from './types';

const sid = 'compaction-parity';
const chat = useChatStore.getState();
const shell = useShellStore.getState();
beforeEach(() => {
  useChatStore.setState({ ...chat, bySid: {}, queuedMessages: {} }, true);
  useShellStore.setState({ ...shell, tabs: [{ sid, agentId: 'forge', displayName: 'test' }], activeSid: sid }, true);
});
afterEach(() => { useChatStore.setState(chat, true); useShellStore.setState(shell, true); });
const status = (phase: string, count: number, ts: number): StoredEvent => ({ type: 'compaction.status', emitterId: 'forge', ts,
  payload: { id: 'turn-a', phase, count, durationMs: phase === 'started' ? undefined : 2500,
    summary: 'SECRET', error: 'SECRET', visual_display: 'SECRET' } });
function replay(events: StoredEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let id = 0;
  const acc = new TurnAccumulator(buildMainCallbacks(makeInMemEffects(messages, () => String(id++))), 'forge');
  for (const event of events) acc.feed(event);
  acc.flush();
  return messages;
}

test('live and replay update one row through start, repeated compactions, completion and failure', () => {
  const events = [status('started', 1, 1), status('completed', 1, 2), status('started', 2, 3), status('failed', 2, 4)];
  for (let i = 0; i < events.length; i++) {
    dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'forge', event: events[i]! });
    const live = useChatStore.getState().readMessages(sid, 'forge');
    const restored = replay(events.slice(0, i + 1));
    expect(live).toHaveLength(1);
    expect(restored).toHaveLength(1);
    expect(live[0]!.text).toBe(restored[0]!.text);
    expect(live[0]!.level).toBe(restored[0]!.level);
    expect(live[0]!.id).toBe(restored[0]!.id);
    expect(JSON.stringify(live)).not.toContain('SECRET');
  }
  expect(useChatStore.getState().readMessages(sid, 'forge')[0]!.text).toContain('2');
});

test('restoring after a raw compact boundary retains public completion and count', () => {
  const events = [status('started', 3, 1), { type: 'compact_boundary', ts: 2, payload: { summary: 'SECRET' } }, status('completed', 3, 3)];
  const messages = replay(trimToCompactBoundary(events));
  expect(messages).toHaveLength(1);
  expect(messages[0]!.text).toContain('3');
  expect(JSON.stringify(messages)).not.toContain('SECRET');
});

test('invalid or private public-status envelopes cannot use generic error fallbacks', () => {
  for (const payload of [{ phase: 'invented' }, { count: -1 }, { id: '' }, { visibility: 'private_reasoning' }]) {
    const event = status('failed', 1, 1);
    event.payload = { ...event.payload, ...payload };
    expect(formatEvent(event)).toBeNull();
    dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'forge', event });
  }
  expect(useChatStore.getState().readMessages(sid, 'forge')).toHaveLength(0);
});


test('independent turns with identical start labels keep separate identities', () => {
  const first = status('started', 1, 1);
  const second = status('started', 1, 2);
  second.payload = { ...second.payload, id: 'turn-b' };
  for (const event of [first, second]) dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'forge', event });
  expect(useChatStore.getState().readMessages(sid, 'forge')).toHaveLength(2);
  expect(replay([first, second])).toHaveLength(2);
});


test('an older Studio locale catalog still renders chat-owned Chinese labels', () => {
  const previousLocale = getLocale();
  try {
    setLocale('zh');
    expect(t('compaction.completed')).toBe('compaction.completed');
    const message = formatEvent(status('completed', 3, 100));
    expect(message).toMatchObject({ text: '上下文已整理（第 3 次） · 3 秒' });
  } finally {
    setLocale(previousLocale);

  }
});

test('cancelled compaction replaces its working row in live and replay without a warning', () => {
  const events = [status('started', 1, 1), status('cancelled', 1, 2)];
  for (const event of events) dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'forge', event });
  const live = useChatStore.getState().readMessages(sid, 'forge');
  expect(live).toHaveLength(1);
  expect(live[0]!.text).toBe(replay(events)[0]!.text);
  expect(live[0]!.text).toMatch(/stopped|已停止/);
  expect(live[0]!.level).toBe('info');
});

test('live and replay retain the owning turn for inline process placement', () => {
  const event = status('completed', 2, 100);
  event.payload = { ...event.payload, turnId: 'owner-turn' };
  dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'forge', event });
  expect(useChatStore.getState().readMessages(sid, 'forge')[0]?.turnId).toBe('owner-turn');
  expect(replay([event])[0]?.turnId).toBe('owner-turn');
});

test('history acknowledgements stay diagnostic in live and replay, including first-turn snapshots', () => {
  for (const epoch of [1, 2]) {
    const event: StoredEvent = { type: 'kernel_history_applied', emitterId: 'forge', ts: 22,
      payload: { mode: 'snapshot', epoch, patchId: `history-${epoch}`, summary: 'SECRET' } };
    expect(formatEvent(event)).toBeNull();
    expect(replay([event]).some(m => m.id?.startsWith('context-reload:'))).toBe(false);
    dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'forge', event: { ...event, source: 'runtime' } });
    expect(useChatStore.getState().bySid[sid]?.messagesByAgent.forge?.some(m => m.id?.startsWith('context-reload:')) ?? false).toBe(false);
  }
});

test('live kernel switching replaces old occupancy even when the new estimate rounds to zero', () => {
  const send = (type: string, ts: number, payload: Record<string, unknown>) => dispatchSessionEvent({
    type: 'session-event', sid, emitterId: 'forge', event: { type, emitterId: 'forge', ts, payload },
  });
  send('context.usage', 1, { kernelId: 'codex', inputTokens: 35000, outputTokens: 100, contextWindow: 258400 });
  send('hook:assistantMessage', 2, { kernelId: 'forgeax-core', model: 'deepseek-v4-flash',
    usage: { inputTokens: 405, outputTokens: 245 }, llmMessage: { role: 'assistant', content: 'continued' } });
  expect(useChatStore.getState().bySid[sid]?.contextByAgent.forge).toMatchObject({ kernelId: 'forgeax-core', source: 'estimate', pct: 0 });
  send('hook:assistantMessage', 3, { kernelId: 'forgeax-core', model: 'deepseek-v4-flash',
    usage: { inputTokens: 405, outputTokens: 245, cacheReadTokens: 29952 }, llmMessage: { role: 'assistant', content: 'cached' } });
  expect(useChatStore.getState().bySid[sid]?.contextByAgent.forge).toMatchObject({ source: 'estimate', pct: 3 });
  send('context.usage', 4, { kernelId: 'codex', inputTokens: 36000, outputTokens: 100, contextWindow: 258400 });
  expect(useChatStore.getState().bySid[sid]?.contextByAgent.forge).toMatchObject({ kernelId: 'codex', source: 'runtime', pct: 14 });
});
