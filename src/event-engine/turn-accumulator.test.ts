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
