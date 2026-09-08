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
