import { describe, expect, it } from 'bun:test';
import { formatEvent } from './event-formatter';
import { replayEvents, trimToCompactBoundary } from './event-replay';
import type { StoredEvent } from './types';

const INTERNAL_EVENTS = [
  'compact_boundary', 'partial_boundary', 'compaction.applied', 'compaction.post',
  'compaction.failed', 'kernel_history_dispatching', 'kernel_lane_bound',
  'turn.usage', 'inbound_message', 'tick', 'hook:internalDiagnostic',
  '_debug', 'agent_log', 'future_internal_event',
];

const secret = 'INTERNAL_EVENT_CANARY';
const event = (type: string, payload: Record<string, unknown> = {}): StoredEvent => ({
  type, ts: 1, source: 'kernel:forgeax-core', emitterId: 'forge', payload,
});

describe('chat event visibility', () => {
  for (const type of INTERNAL_EVENTS) {
    it(`does not render ${type}, even through text/error/public-label fallbacks`, () => {
      for (const key of ['summary', 'content', 'text', 'visual_display', 'error', 'warning']) {
        const payload = { [key]: secret };
        expect(formatEvent(event(type, payload), 'forge')).toBeNull();
        if (type !== 'agent_log') {
          expect(formatEvent(event(type, { ...payload, visibility: 'public_summary' }))).toBeNull();
        }
        expect(JSON.stringify(replayEvents([event(type, payload)], 'forge'))).not.toContain(secret);
      }
    });
  }

  it('keeps the canonical boundary in history without showing its summary', () => {
    const boundary = event('compact_boundary', { summary: secret, replacement: { role: 'user', content: secret }, keepCount: 0 });
    const answer = event('hook:assistantMessage', { llmMessage: { role: 'assistant', content: '已完成游戏' } });
    const history = [event('user_input', { content: '创建游戏' }), boundary, answer];
    const before = JSON.stringify(history);
    const trimmed = trimToCompactBoundary(history);
    expect(trimmed[0]).toBe(boundary);
    const replay = JSON.stringify(replayEvents(trimmed, 'forge'));
    expect(replay).not.toContain(secret);
    expect(replay).toContain('已完成游戏');
    expect(JSON.stringify(history)).toBe(before);
  });

  it('retains user messages, public progress, tool cards and actionable failures', () => {
    expect(formatEvent(event('user_input', { content: '创建游戏' }))?.kind).toBe('user_input');
    expect(formatEvent(event('agent_log', { visibility: 'public_summary', summary: '正在检查项目' })))
      .toMatchObject({ publicSummary: '正在检查项目' });
    expect(formatEvent(event('hook:toolCall', { name: 'read_file', callId: 't1', args: { file_path: 'main.ts' } }))?.kind).toBe('tool_call');
    expect(formatEvent(event('agent_crash', { error: '服务暂时不可用' })))
      .toMatchObject({ kind: 'system', level: 'error', text: '服务暂时不可用' });
    expect(formatEvent(event('hook:llmRetry', { warning: '请求失败，正在重试' })))
      .toMatchObject({ level: 'warning' });
    expect(formatEvent(event('message', { content: '任务已完成' }))?.kind).toBe('system');
    expect(formatEvent(event('agent_log', { visibility: 'private_reasoning', error: secret }))).toBeNull();
  });
});
