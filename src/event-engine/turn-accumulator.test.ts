import { describe, expect, it } from 'bun:test';
import { replayEvents } from './event-replay';
import { ratioFromUsage } from './turn-accumulator';
import type { StoredEvent } from './types';

describe('chat context usage ratio', () => {
  it('resolves GPT-5.6 provider variants to the long context window', () => {
    const usage = { inputTokens: 735_000, outputTokens: 0 };
    expect(ratioFromUsage(usage, 'gpt-5.6-sol')).toBe(70);
    expect(ratioFromUsage(usage, 'gpt-5.6-terra')).toBe(70);
    expect(ratioFromUsage(usage, 'GPT-5.6-LUNA')).toBe(70);
  });

  it('matches suffix variants without letting a shorter model key win', () => {
    const usage = { inputTokens: 735_000, outputTokens: 0 };
    expect(ratioFromUsage(usage, 'gpt-5.5-medium')).toBe(70);
    expect(ratioFromUsage({ inputTokens: 300_000, outputTokens: 0 }, 'gpt-5.4-mini-medium')).toBe(75);
    expect(ratioFromUsage(usage, 'claude-opus-4-8-thinking-high')).toBe(74);
  });

  it('keeps the conservative fallback for genuinely unknown models', () => {
    expect(ratioFromUsage({ inputTokens: 200_000, outputTokens: 0 }, 'custom-model')).toBe(100);
    expect(ratioFromUsage({ inputTokens: 200_000, outputTokens: 0 }, 123)).toBe(100);
  });

  it('clamps invalid and over-limit usage to the UI range', () => {
    expect(ratioFromUsage({ inputTokens: 2_000_000, outputTokens: 0 }, 'gpt-5.6-sol')).toBe(100);
    expect(ratioFromUsage({ inputTokens: -10, outputTokens: Number.NaN }, 'gpt-5.6-sol')).toBe(0);
  });

  it('keeps the last positive context percentage through replay', () => {
    const event = (ts: number, inputTokens: number): StoredEvent => ({
      type: 'hook:assistantMessage',
      emitterId: 'forge',
      ts,
      payload: {
        model: 'gpt-5.6-sol',
        usage: { inputTokens, outputTokens: 0 },
        llmMessage: { role: 'assistant', content: `message-${ts}` },
      },
    });

    expect(replayEvents([event(1, 735_000), event(2, 0)]).contextPct).toBe(70);
  });
});


describe('runtime context occupancy replay', () => {
  const native = (ts: number, inputTokens: number, emitterId = 'forge'): StoredEvent => ({
    type: 'context.usage', emitterId, ts,
    payload: { inputTokens, outputTokens: 292, contextWindow: 258400 },
  });
  it('preserves actual native occupancy through cancellation and ignores cumulative-model estimates', () => {
    expect(replayEvents([
      native(10, 156884),
      { type: 'hook:assistantMessage', emitterId: 'forge', ts: 11, payload: {
        model: 'gpt-5.6-luna', usage: { inputTokens: 4_600_000, outputTokens: 10000 },
        llmMessage: { role: 'assistant', content: 'done' },
      } },
      { type: 'hook:turnEnd', emitterId: 'forge', ts: 12, payload: { aborted: true } },
    ], 'forge').contextPct).toBe(61);
  });
  it('isolates child occupancy and accepts a reduced value after compaction', () => {
    expect(replayEvents([native(10, 156884), native(11, 63920, 'child')], 'forge').contextPct).toBe(61);
    expect(replayEvents([native(10, 156884), native(12, 0)], 'forge').contextPct).toBe(0);
  });
  it('rejects malformed windows and stale occupancy', () => {
    expect(replayEvents([
      native(10, 156884), native(9, 0),
      { ...native(11, 10), payload: { inputTokens: 10, outputTokens: 1, contextWindow: 0 } },
    ], 'forge').contextPct).toBe(61);
  });
});

describe('context occupancy across kernel switches', () => {
  const codex = (ts: number): StoredEvent => ({ type: 'context.usage', emitterId: 'forge', ts,
    payload: { kernelId: 'codex', inputTokens: 156884, outputTokens: 292, contextWindow: 258400 } });
  const estimate = (ts: number, kernelId: string): StoredEvent => ({ type: 'hook:assistantMessage', emitterId: 'forge', ts,
    payload: { kernelId, model: 'deepseek-v4-flash', usage: { inputTokens: 26641, outputTokens: 116 },
      llmMessage: { role: 'assistant', content: 'continued' } } });
  it('replaces Codex occupancy with the new core estimate and accepts Codex again', () => {
    expect(replayEvents([codex(1), estimate(2, 'forgeax-core')], 'forge').contextPct).toBe(3);
    expect(replayEvents([codex(1), estimate(2, 'forgeax-core'), codex(3)], 'forge').contextPct).toBe(61);
  });
  it('keeps authoritative occupancy within one kernel and rejects stale other-kernel events', () => {
    expect(replayEvents([codex(2), estimate(3, 'codex')], 'forge').contextPct).toBe(61);
    expect(replayEvents([codex(2), estimate(1, 'forgeax-core')], 'forge').contextPct).toBe(61);
  });
});
