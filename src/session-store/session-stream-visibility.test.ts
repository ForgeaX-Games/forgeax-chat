import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useShellStore } from '@forgeax/interface/store';
import { dispatchSessionEvent } from './session-stream';
import { useChatStore } from './store';
import type { SessionEvent } from '../session-bridge';

const initialChat = useChatStore.getState();
const initialShell = useShellStore.getState();
const sid = 'internal-event-visibility';
const secret = 'INTERNAL_EVENT_CANARY';
function dispatch(type: string, payload: Record<string, unknown>, source = 'kernel:forgeax-core') {
  dispatchSessionEvent({ type: 'session-event', sid, emitterId: 'forge', event: { type, source, payload, ts: 1 } } satisfies SessionEvent);
}
beforeEach(() => {
  useChatStore.setState({ ...initialChat, bySid: {}, queuedMessages: {} }, true);
  useShellStore.setState({ ...initialShell, tabs: [{ sid, agentId: 'forge', displayName: 'test' }], activeSid: sid }, true);
});
afterEach(() => {
  useChatStore.setState(initialChat, true);
  useShellStore.setState(initialShell, true);
});

describe('live session stream visibility', () => {
  it('inserts a resumed request before its running reply and deduplicates by identity', () => {
    useChatStore.getState().patchMessages(sid, 'forge', () => [{
      id: 'running', role: 'assistant', text: 'working', toolCalls: [], status: 'streaming', ts: 20,
    }]);
    const event: SessionEvent = { type: 'session-event', sid, emitterId: 'forge', event: {
      type: 'user_input', source: 'user', ts: 10,
      payload: { content: 'original request', msgId: 'request-1', clientMsgId: 'request-1' },
    } };
    dispatchSessionEvent({ ...event, event: { ...event.event, sgen: 'resume-generation', seq: 10 } });
    dispatchSessionEvent({ ...event, event: { ...event.event, sgen: 'resume-generation', seq: 11 } });
    expect(useChatStore.getState().readMessages(sid, 'forge').map(m => m.role)).toEqual(['user', 'assistant']);
    expect(useChatStore.getState().readMessages(sid, 'forge')[1]?.id).toBe('running');
  });

  it('retains repeated prompt text with distinct IDs and supports client-only IDs', () => {
    for (const id of ['first', 'first', 'second']) {
      dispatch('user_input', { content: 'same prompt', clientMsgId: id }, 'user');
    }
    expect(useChatStore.getState().readMessages(sid, 'forge').map(m => m.msgId)).toEqual(['first', 'second']);
  });

  it('places a request before a reply with the same timestamp', () => {
    useChatStore.getState().patchMessages(sid, 'forge', () => [{
      id: 'reply', role: 'assistant', text: '', toolCalls: [], status: 'streaming', ts: 1,
    }]);
    dispatch('user_input', { content: 'request', msgId: 'same-time' }, 'user');
    expect(useChatStore.getState().readMessages(sid, 'forge').map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('keeps identical prompts in distinct sessions while switching and stopping', () => {
    const otherSid = 'stopped-session';
    useShellStore.setState({ tabs: [
      { sid, agentId: 'forge', displayName: 'old' },
      { sid: otherSid, agentId: 'forge', displayName: 'new' },
    ], activeSid: otherSid });
    for (const target of [sid, otherSid]) {
      dispatchSessionEvent({ type: 'session-event', sid: target, emitterId: 'forge', event: {
        type: 'user_input', source: 'user', ts: target === sid ? 10 : 30,
        payload: { content: 'same prompt', msgId: target + '-request' },
      } });
    }
    useShellStore.setState({ activeSid: sid });
    dispatchSessionEvent({ type: 'session-event', sid: otherSid, emitterId: 'forge', event: {
      type: 'hook:turnEnd', source: 'agent:forge', ts: 40, payload: { aborted: true },
    } });
    for (const target of [sid, otherSid]) {
      expect(useChatStore.getState().readMessages(target, 'forge').filter(m => m.role === 'user').map(m => m.msgId))
        .toEqual([target + '-request']);
    }
  });

  it('never turns internal payload fields into chat messages', () => {
    for (const type of ['compact_boundary', 'partial_boundary', 'compaction.post', 'compaction.failed', 'kernel_history_dispatching', 'turn.usage', 'inbound_message', 'tick', 'agent_log', 'future_internal_event']) {
      for (const key of ['summary', 'content', 'text', 'message', 'visual_display', 'error', 'warning']) {
        dispatch(type, { [key]: secret });
        // The producer source is not a visibility opt-in either.
        dispatch(type, { [key]: secret }, 'user');
      }
    }
    expect(useChatStore.getState().readMessages(sid, 'forge')).toEqual([]);
  });

  it('preserves metadata updates even when their payload contains diagnostics', () => {
    dispatch('agent_added', { path: 'audio-designer', display: 'Audio', summary: secret, warning: secret });
    expect(useShellStore.getState().liveAgents[sid].some(a => a.path === 'audio-designer')).toBe(true);
    expect(useChatStore.getState().readMessages(sid, 'forge')).toEqual([]);
  });

  it('continues a normal turn around an invisible compaction boundary', () => {
    dispatch('user_input', { content: '创建游戏' }, 'user');
    dispatch('hook:turnStart', { turnId: 't1' });
    dispatch('compact_boundary', { summary: secret });
    dispatch('hook:assistantMessage', { llmMessage: { role: 'assistant', content: '已完成游戏' } });
    dispatch('hook:turnEnd', { turnId: 't1', aborted: false });
    const messages = useChatStore.getState().readMessages(sid, 'forge');
    expect(messages.some(m => m.role === 'user' && m.text === '创建游戏')).toBe(true);
    expect(messages.some(m => m.role === 'assistant' && m.text === '已完成游戏')).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(secret);
  });

  it('keeps explicit user-facing notifications and turn errors', () => {
    dispatch('message', { content: '任务已完成' }, 'agent');
    dispatch('hook:llmRetry', { warning: '正在重试' });
    dispatch('agent_crash', { error: '服务暂时不可用' });
    const text = JSON.stringify(useChatStore.getState().readMessages(sid, 'forge'));
    expect(text).toContain('任务已完成');
    expect(text).toContain('正在重试');
    expect(text).toContain('服务暂时不可用');
  });
});


it('keeps runtime occupancy separate per agent and session, including after stop', () => {
  useChatStore.getState().patchMessages(sid, 'forge', () => []);
  for (const [owner, inputTokens] of [['forge', 156884], ['child', 63920]] as const) {
    dispatchSessionEvent({ type: 'session-event', sid, emitterId: owner, event: {
      type: 'context.usage', ts: 10, payload: { inputTokens, outputTokens: 292, contextWindow: 258400 },
    } });
  }
  dispatch('hook:turnEnd', { aborted: true });
  expect(useChatStore.getState().bySid[sid]?.contextByAgent.forge?.pct).toBe(61);
  expect(useChatStore.getState().bySid[sid]?.contextByAgent.child?.pct).toBe(25);
  expect(useChatStore.getState().readMessages(sid, 'forge')).toEqual([]);
});
