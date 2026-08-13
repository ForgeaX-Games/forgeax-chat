import { describe, expect, it } from 'bun:test';
import { formatEvent } from './event-formatter';
import { buildMainCallbacks, makeInMemEffects, rendererToolCallToLegacy } from './message-builder';
import { mergeToolResult, stringifyToolResult, TOOL_RESULT_DISPLAY_LIMIT } from './tool-result';
import { TurnAccumulator } from './turn-accumulator';
import { readDeliver } from '../task-flow/deliver';
import type { StoredEvent } from './types';
import type { ToolCall } from '@forgeax/interface/store';

function makeLargeResult(): { ok: true; summary: { outcome: string; files: string[] } } {
  return {
    ok: true,
    summary: {
      outcome: 'completed',
      files: Array.from({ length: 80 }, (_, i) => ({
        path: `src/generated/file-${i}.ts`,
        change: 'edit' as const,
      })),
    },
  };
}

describe('structured tool results', () => {
  it('normalizes deferred MCP tools and infers generic result names', () => {
    const call = formatEvent({
      type: 'hook:toolCall',
      emitterId: 'codebuddy',
      ts: 1,
      payload: {
        name: 'DeferExecuteTool',
        callId: 'deferred-1',
        args: {
          toolName: 'mcp__fxt__deliver_summary',
          params: { outcome: 'done' },
        },
      },
    }) as { kind: string; name: string; args: unknown };
    expect(call.name).toBe('deliver_summary');
    expect(call.args).toEqual({ outcome: 'done' });

    const result = formatEvent({
      type: 'hook:toolResult',
      emitterId: 'kimi-code',
      ts: 2,
      payload: {
        name: 'tool',
        callId: 'generic-1',
        result: JSON.stringify({ ok: true, summary: { outcome: 'done' } }),
      },
    }) as { kind: string; name: string; resultData: unknown };
    expect(result.name).toBe('deliver_summary');
    expect(result.resultData).toEqual({ ok: true, summary: { outcome: 'done' } });
  });

  it('keeps a >2000-character result intact in live and replay shapes', () => {
    const result = makeLargeResult();
    const resultText = stringifyToolResult(result);
    expect(resultText.length).toBeGreaterThan(TOOL_RESULT_DISPLAY_LIMIT);

    const initial: ToolCall = {
      callId: 'call-1',
      name: 'deliver_summary',
      args: {},
      status: 'running',
    };
    const live = mergeToolResult(initial, { result });
    expect(live.resultData).toEqual(result);
    expect(live.result).toBe(resultText.slice(0, TOOL_RESULT_DISPLAY_LIMIT) + '\n…');
    expect(live.fullResultContent).toBe(resultText);
    expect(readDeliver(live)?.files).toHaveLength(result.summary.files.length);

    const events: StoredEvent[] = [
      {
        type: 'hook:toolCall',
        emitterId: 'forge',
        ts: 1,
        payload: { name: 'deliver_summary', toolCall: { id: 'call-1' }, args: {} },
      },
      {
        type: 'hook:toolResult',
        emitterId: 'forge',
        ts: 2,
        payload: { name: 'deliver_summary', callId: 'call-1', result },
      },
    ];
    const messages: import('@forgeax/interface/store').ChatMessage[] = [];
    const effects = makeInMemEffects(messages, (() => {
      let nextId = 0;
      return () => `message-${nextId++}`;
    })());
    const callbacks = buildMainCallbacks(effects);
    const acc = new TurnAccumulator(callbacks);
    for (const event of events) acc.feed(event);
    acc.flush();

    const replayed = messages[0]?.toolCalls[0];
    expect(replayed?.resultData).toEqual(result);
    expect(replayed?.result).toBe(resultText.slice(0, TOOL_RESULT_DISPLAY_LIMIT) + '\n…');
    expect(replayed?.fullResultContent).toBe(resultText);
    expect(readDeliver(replayed!)?.files).toHaveLength(result.summary.files.length);
    expect(formatEvent(events[1]!)?.kind).toBe('tool_result');
    expect(rendererToolCallToLegacy({
      kind: 'tool_call',
      id: 'legacy-call',
      name: 'deliver_summary',
      status: 'done',
      args: {},
      resultContent: resultText.slice(0, TOOL_RESULT_DISPLAY_LIMIT) + '\n…',
      fullResultContent: resultText,
      agent: 'forge',
      timestamp: 2,
    }).resultData).toEqual(result);
  });
});
