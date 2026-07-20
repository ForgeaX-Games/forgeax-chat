import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '@forgeax/interface/store';
import type { LedgerBlob } from '@forgeax/types';
import { hydrateLedgerBlobs } from './ledger-blob-hydration';
import { buildMainCallbacks, makeInMemEffects } from './message-builder';
import { TurnAccumulator } from './turn-accumulator';
import type { StoredEvent } from './types';

const blob = (sha256: string, enc: LedgerBlob['enc'] = 'utf8'): LedgerBlob => ({
  __ledger_blob__: true,
  sha256,
  enc,
  len: 72_501,
});

function replay(events: StoredEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let seq = 0;
  const effects = makeInMemEffects(messages, () => `m${seq++}`);
  const callbacks = buildMainCallbacks(effects);
  const accumulator = new TurnAccumulator(callbacks, 'forge');
  for (const event of events) accumulator.feed(event);
  accumulator.flush();
  return messages;
}

describe('ledger blob history hydration', () => {
  test('restores large thinking before replay', async () => {
    const thinking = 'reasoning '.repeat(8_100);
    const ref = blob('d81f3a3be86b31ef');
    const events: StoredEvent[] = [{
      type: 'hook:assistantMessage',
      emitterId: 'forge',
      ts: 1,
      payload: { llmMessage: { role: 'assistant', content: 'done', thinking: ref } },
    }];

    await hydrateLedgerBlobs(events, async () => new TextEncoder().encode(thinking));

    const messages = replay(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.thinking).toBe(thinking.trim());
    expect(messages[0]!.text).toBe('done');
  });

  test('walks nested payloads and resolves each sha once', async () => {
    const utf8 = blob('aaaaaaaaaaaaaaaa');
    const base64 = blob('bbbbbbbbbbbbbbbb', 'base64');
    const events: StoredEvent[] = [{
      type: 'custom',
      payload: {
        repeated: [utf8, utf8],
        nested: { result: base64 },
      },
    }];
    const calls: string[] = [];

    await hydrateLedgerBlobs(events, async (ref) => {
      calls.push(ref.sha256);
      return ref.enc === 'base64'
        ? Uint8Array.from([0, 1, 2, 255])
        : new TextEncoder().encode('hydrated');
    });

    expect(calls.sort()).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
    expect(events[0]!.payload!.repeated).toEqual(['hydrated', 'hydrated']);
    expect((events[0]!.payload!.nested as { result: string }).result).toBe('AAEC/w==');
  });

  test('resolver failure leaves the sentinel but replay still degrades safely', async () => {
    const ref = blob('cccccccccccccccc');
    const events: StoredEvent[] = [{
      type: 'hook:assistantMessage',
      emitterId: 'forge',
      ts: 1,
      payload: { llmMessage: { role: 'assistant', content: 'visible answer', thinking: ref } },
    }];
    const failures: string[] = [];

    await hydrateLedgerBlobs(
      events,
      async () => { throw new Error('missing'); },
      { onError: (failed) => failures.push(failed.sha256) },
    );

    expect(failures).toEqual(['cccccccccccccccc']);
    expect(() => replay(events)).not.toThrow();
    expect(replay(events)[0]!.text).toBe('visible answer');
    expect(replay(events)[0]!.thinking).toBeUndefined();
  });
});
