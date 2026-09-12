import { expect, test } from 'bun:test';
import { formatEvent } from './event-formatter';
import { setLocale } from '@/i18n';

test('stopping delegation and late result preserve separate lifecycle and recovery guidance', () => {
  setLocale('en');
  const stopping = formatEvent({ type: 'delegation:state', emitterId: 'forge', ts: 1,
    payload: { delegationId: 'd1', agent: 'suzu', ownerTaskId: 't1', status: 'stopping', reason: 'fault_paused', content: 'Saved files retained' } });
  expect(stopping?.kind).toBe('system');
  expect(stopping && 'text' in stopping ? stopping.text : '').toContain('Paused');
  expect(stopping && 'text' in stopping ? stopping.text : '').toContain('finishing');
  const result = formatEvent({ type: 'message', emitterId: 'suzu', to: 'forge', ts: 2,
    payload: { delegationId: 'd1', delegationOwnerTaskId: 't1', fromAgent: 'suzu', resumeRequired: true, content: 'design/hud-notes.md' } });
  expect(result && 'text' in result ? result.text : '').toContain('design/hud-notes.md');
  expect(result && 'text' in result ? result.text : '').toContain('Send a message');
});

test('private or malformed lifecycle data stays hidden', () => {
  for (const payload of [{ status: 'stopping' }, { delegationId: 'd1', agent: 'suzu', status: 'stopping', reason: 'fault_paused', visibility: 'private_reasoning' }]) {
    expect(formatEvent({ type: 'delegation:state', payload })).toBeNull();
  }
});

test('live and ledger replay retain one card per owning task and a separate late result', async () => {
  const { useChatStore } = await import('../session-store/store');
  const { useShellStore } = await import('@forgeax/interface/store');
  const { dispatchSessionEvent } = await import('../session-store/session-stream');
  const { TurnAccumulator } = await import('./turn-accumulator');
  const { buildMainCallbacks, makeInMemEffects } = await import('./message-builder');
  const originalChat = useChatStore.getState();
  const originalShell = useShellStore.getState();
  const sid = 'delegation-parity';
  try {
    useChatStore.setState({ ...originalChat, bySid: {}, queuedMessages: {} }, true);
    useShellStore.setState({ ...originalShell, tabs: [{ sid, agentId: 'forge', displayName: 'test' }], activeSid: sid }, true);
    const events = ['queued', 'running', 'waiting_permission', 'stopping', 'returned'].map((status, i) => ({
      type: 'delegation:state', source: 'host:delegation', emitterId: 'suzu', to: 'forge', ts: i + 1,
      payload: { delegationId: 'd1', ownerTaskId: 'task1', agent: 'suzu', status, reason: 'fault_paused', outcome: 'cancelled', resumeRequired: true },
    }));
    events.push({ ...events[0]!, ts: 6, payload: { ...events[0]!.payload, ownerTaskId: 'task2' } });
    const replay: import('@forgeax/interface/store').ChatMessage[] = [];
    const accumulator = new TurnAccumulator(buildMainCallbacks(makeInMemEffects(replay, () => 'test-id')), 'forge');
    for (const event of events) {
      dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'suzu', event });
      accumulator.feed(event);
    }
    accumulator.flush();
    const live = useChatStore.getState().readMessages(sid, 'forge');
    const snapshot = (messages: typeof replay) => messages.map(m => ({ id: m.id, text: m.text, delegation: (m as import('./delegation-status').DelegationMessage).delegation }));
    expect(snapshot(live)).toEqual(snapshot(replay));
    expect(live).toHaveLength(2);
    expect(snapshot(live)[0]?.delegation?.status).toBe('returned');
    expect(snapshot(live)[1]?.delegation?.ownerTaskId).toBe('task2');
    expect(live[0]?.text).toContain('cancelled');
    expect(live[0]?.text).toContain('Send a message');
    const late = { type: 'message', emitterId: 'suzu', to: 'forge', ts: 7, payload: { fromAgent: 'suzu', delegationId: 'd1', delegationOwnerTaskId: 'task1', resumeRequired: true, content: 'design/hud-notes.md' } };
    dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'suzu', event: late });
    accumulator.feed(late);
    accumulator.flush();
    const withResult = useChatStore.getState().readMessages(sid, 'forge');
    expect(withResult).toHaveLength(3);
    expect(withResult.at(-1)?.text).toContain('design/hud-notes.md');
    expect(withResult.map(m => m.text)).toEqual(replay.map(m => m.text));
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent.forge ?? false).toBe(false);
  } finally {
    useChatStore.setState(originalChat, true);
    useShellStore.setState(originalShell, true);
  }
});
