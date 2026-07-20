/**
 * Regression test for the chat-history restore ordering bug.
 *
 * Symptom (reported twice — "之前修复过，现在又坏了"): switching away from a
 * session and back made the inter-agent (崽崽) cards pile at the TAIL and every
 * forge turn's text merge into ONE bubble, instead of interleaving the cards
 * with forge's turns at their real event time.
 *
 * Root cause: the replay path's `makeInMemEffects.applyMain` reused the
 * most-recent assistant bubble (`findCurrentAsstIdx`). A forge thread that
 * takes MULTIPLE LLM turns around a sub-agent delegation therefore merged all
 * its text into the first bubble, while `applySystem` appended the inter-agent
 * cards to the tail — so the second forge turn landed BEFORE the cards even
 * though it spoke after them. The live WS path (session-stream.ts) spawns a
 * fresh streaming bubble per `hook:turnStart`, so live read correctly and only
 * the restore diverged.
 *
 * Fix: seal the main bubble at each real agent turn boundary so the next turn's
 * `applyMain` opens a fresh bubble AFTER the appended cards. This test wires the
 * accumulator EXACTLY as store.ts::loadSession does (the onTurn → sealMain
 * bridge) and asserts the restored order matches live.
 */

import { describe, it, expect } from 'bun:test';
import { TurnAccumulator } from './turn-accumulator';
import { buildMainCallbacks, makeInMemEffects } from './message-builder';
import type { StoredEvent } from './types';
import type { ChatMessage } from '@forgeax/interface/store';

/** Mirror store.ts::loadSession's replay wiring (minus the segments/meta
 *  bookkeeping that doesn't affect message ordering). */
function replay(events: StoredEvent[], viewerId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let seq = 0;
  const newId = () => `m${seq++}`;
  const eff = makeInMemEffects(messages, newId);
  const mainCbs = buildMainCallbacks(eff);
  const acc = new TurnAccumulator(
    {
      ...mainCbs,
      onTurn: (turn) => {
        mainCbs.onTurn?.(turn);
        // The fix: seal at every real agent turn boundary.
        if (turn.agent && turn.agent !== 'user') eff.sealMain?.();
      },
    },
    viewerId,
  );
  for (const ev of [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) acc.feed(ev);
  acc.flush();
  return messages;
}

const asstMsg = (emitter: string, ts: number, text: string): StoredEvent => ({
  type: 'hook:assistantMessage',
  emitterId: emitter,
  ts,
  payload: { llmMessage: { role: 'assistant', content: text } },
});

describe('replay ordering — inter-agent cards interleave with multi-turn forge text', () => {
  it('keeps each forge turn in its own bubble, cards interleaved at event time', () => {
    // forge: speaks → delegates to iori → iori replies → forge speaks again.
    const events: StoredEvent[] = [
      { type: 'user_input', source: 'user', ts: 1, payload: { content: 'make a game' } },
      { type: 'hook:turnStart', emitterId: 'forge', ts: 2 },
      asstMsg('forge', 3, 'I will ask iori to build the arena.'),
      { type: 'hook:turnEnd', emitterId: 'forge', ts: 4 },
      // inter-agent traffic (forge→iori, iori→forge) — reshaped to system rows.
      { type: 'user_input', source: 'agent', emitterId: 'forge', to: 'iori', ts: 5, payload: { content: 'build the arena' } },
      { type: 'user_input', source: 'agent', emitterId: 'iori', to: 'forge', ts: 6, payload: { content: 'arena done' } },
      { type: 'hook:turnStart', emitterId: 'forge', ts: 7 },
      asstMsg('forge', 8, 'Iori finished — here is the result.'),
      { type: 'hook:turnEnd', emitterId: 'forge', ts: 9 },
    ];

    const msgs = replay(events, 'forge');

    // Exactly: user, forge-turn-1, forge→iori card, iori→forge card, forge-turn-2.
    expect(msgs.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'system',
      'system',
      'assistant',
    ]);

    // Forge's two turns are SEPARATE bubbles — not merged into one.
    expect(msgs[1]!.text).toBe('I will ask iori to build the arena.');
    expect(msgs[4]!.text).toBe('Iori finished — here is the result.');
    expect(msgs[1]!.id).not.toBe(msgs[4]!.id);

    // The cards sit BETWEEN the two forge turns (real event-time order), not
    // piled at the tail.
    expect(msgs[2]!.direction).toBe('outgoing');
    expect(msgs[2]!.to).toBe('iori');
    expect(msgs[3]!.direction).toBe('incoming');
    expect(msgs[3]!.from).toBe('iori');

    // Render order is strictly ts-ascending (ChatPanel renders in array order).
    const tss = msgs.map((m) => m.ts);
    expect([...tss].sort((a, b) => a - b)).toEqual(tss);
  });

  it('does not merge a second forge turn into the first when no turnEnd fires', () => {
    // Some providers omit hook:turnEnd; the turnStart commitPending boundary
    // must still seal the prior turn.
    const events: StoredEvent[] = [
      { type: 'user_input', source: 'user', ts: 1, payload: { content: 'go' } },
      { type: 'hook:turnStart', emitterId: 'forge', ts: 2 },
      asstMsg('forge', 3, 'first'),
      { type: 'user_input', source: 'agent', emitterId: 'forge', to: 'mochi', ts: 4, payload: { content: 'do X' } },
      { type: 'hook:turnStart', emitterId: 'forge', ts: 5 },
      asstMsg('forge', 6, 'second'),
    ];

    const msgs = replay(events, 'forge');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'assistant']);
    expect(msgs[1]!.text).toBe('first');
    expect(msgs[3]!.text).toBe('second');
  });
});
