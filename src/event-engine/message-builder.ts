/**
 * Message builder — pure callback factories that drive a TurnAccumulator and
 * mutate the ChatMessage[] model through an injected effect interface.
 *
 * Used identically by:
 *  - Live SSE (store.sendMessage) — effects bound to store mutators
 *    (patchAsst / patchSub) so the active tab's messages update per event.
 *  - WAL replay (store.loadSession) — effects bound to an in-memory
 *    ChatMessage[] which is then committed via patchTabMessages once.
 *
 * The callbacks are byte-byte identical between live and replay; only the
 * effect implementation differs. This guarantees rendering parity, in
 * particular for `tc.at` (the tool-chip's anchor character position in the
 * assistant text): both paths feed events in arrival order, so onMessage
 * fires with the same `m.text.length` snapshot at the moment tool_call
 * lands.
 */

import type { CompletedTurn, RendererMessage, SystemMessage, ToolCallMessage } from './types';
import type { TurnAccCallbacks } from './turn-accumulator';
import type { ChatMessage, SubAgentRun, ToolCall } from '@forgeax/interface/store';

// ── Effect interface ──────────────────────────────────────────────────────

/**
 * Abstract over "modify the message model". The two live mutators
 * (`patchAsst` / `patchSub`) and the in-memory replay variants share this
 * shape, so callback bodies don't care which mode they run in.
 *
 * `onUserInput` is fired by TurnAccumulator's onTurn handler when a user
 * message arrives. Live mode ignores it (sendMessage manually pushes the
 * user bubble before SSE starts); replay mode uses it to commit a user
 * ChatMessage and spawn a fresh assistant skeleton for the next agent turn.
 */
export interface MessageEffects {
  /** Mutate the active main-agent assistant ChatMessage. */
  applyMain: (mut: (m: ChatMessage) => ChatMessage) => void;
  /** Mutate (or create on first reference) the SubAgentRun keyed by emitterId. */
  applySub: (emitterId: string, mut: (r: SubAgentRun) => SubAgentRun) => void;
  /** Optional: commit a user_input event as its own user ChatMessage.
   *  msgId = checkpoint 回退点外键(可能 undefined,旧事件)。 */
  onUserInput?: (text: string, ts: number, msgId?: string) => void;
  /**
   * Optional: commit a `kind:'system'` RendererMessage from the formatter
   * (warnings / errors / inter-agent traffic) as its own `role:'system'`
   * ChatMessage. Replay path (`makeInMemEffects`) implements this so the
   * WAL ledger surfaces `hook:llmRetry` / `agent_log` / `payload.warning|error`
   * etc. as banner rows in the chat thread, matching live WS path
   * (`session-stream.ts::pushSystemMessage`) and ink-renderer SystemLine.
   *
   * Skipping this (live path's `patchAsst` doesn't define it) means system
   * messages produced by the formatter are dropped — useful when the caller
   * has its own system-banner channel that runs in parallel.
   */
  applySystem?: (msg: SystemMessage) => void;
  /**
   * Optional: seal the current main assistant bubble at a turn boundary so the
   * NEXT `applyMain` opens a fresh bubble. The replay path (`makeInMemEffects`)
   * implements this to mirror the live WS path (`session-stream.ts` spawns a
   * fresh streaming bubble per `hook:turnStart`): without it, a forge agent
   * that takes multiple LLM turns around sub-agent delegations would merge
   * every turn's text into ONE bubble, leaving the inter-agent (崽崽) cards —
   * which `applySystem` appends to the tail in between — piled AFTER all the
   * text instead of interleaved at their real event time. Live binds this to a
   * no-op (it spawns bubbles itself), so it only changes replay ordering.
   */
  sealMain?: () => void;
}

// ── ToolCallMessage → legacy ToolCall adapter ────────────────────────────

/**
 * Convert renderer-side ToolCallMessage (event-engine shape) into the
 * legacy ToolCall shape consumed by ForgeCard. Moved out of store.ts so
 * both live and replay can call it (P6 colocate to event-engine).
 *
 * `at` is set by the caller — it depends on the current main bubble's
 * m.text.length at the moment the tool_call event arrives.
 */
export function rendererToolCallToLegacy(msg: ToolCallMessage): ToolCall {
  const status: 'running' | 'done' | 'error' =
    msg.status === 'pending' || msg.status === 'running'
      ? 'running'
      : msg.status === 'error'
        ? 'error'
        : 'done';
  return {
    callId: msg.id,
    name: msg.name,
    args: msg.args,
    status,
    result: msg.resultContent,
    error: msg.status === 'error' ? msg.resultContent : undefined,
    subagentId: msg.subagentId,
  };
}

// ── Callbacks for the main agent ─────────────────────────────────────────

/**
 * Build the TurnAccumulator callback bundle for the main agent of a turn.
 * Mutates the main assistant ChatMessage via `eff.applyMain`.
 *
 * Event handling:
 *  - onStreamText / onThinkingText: append to m.text / m.thinking
 *  - onMessage(tool_call): push tool to m.toolCalls with `at` = current
 *    m.text.length — this is THE place where streaming-position matters.
 *  - onMessage(assistant_complete): sync thinking from formatter (text was
 *    already filled via onStreamText)
 *  - onUpdateMessage(tool_call): merge tool_result into the existing call
 *  - onTurn(turn.agent==='user'): forward to eff.onUserInput so replay can
 *    commit it as a user bubble. Live ignores (manual push pre-SSE).
 */
export function buildMainCallbacks(eff: MessageEffects): TurnAccCallbacks {
  return {
    onStreamText: (text) => {
      eff.applyMain((m) => ({ ...m, text: m.text + text }));
    },
    onThinkingText: (text) => {
      eff.applyMain((m) => ({ ...m, thinking: (m.thinking ?? '') + text }));
    },
    onMessage: (msg) => {
      if (msg.kind === 'tool_call') {
        eff.applyMain((m) => {
          const tc = rendererToolCallToLegacy(msg as ToolCallMessage);
          tc.at = m.text.length;
          return { ...m, toolCalls: [...m.toolCalls, tc] };
        });
      } else if (msg.kind === 'assistant_complete') {
        // assistant_complete carries the canonical text + thinking from
        // hook:assistantMessage's llmMessage payload. Two regimes:
        //  - Live: m.text has already been built incrementally via
        //    onStreamText (stream:llm chunks). msg.text equals the same
        //    final text, so overwriting is idempotent (the chunk-by-chunk
        //    UI animation already happened).
        //  - Replay: stream:llm is transient and never persisted to WAL
        //    (Principle: WAL is Truth, but stream:* is the documented
        //    exception). m.text is empty until this fires. We must set it
        //    from msg.text or the bubble stays blank.
        // Fallback to m.text when msg.text is empty handles the live abort
        // path where the stream cuts off before hook:assistantMessage.
        eff.applyMain((m) => ({
          ...m,
          text: msg.text || m.text,
          thinking: msg.thinking || m.thinking || undefined,
        }));
      } else if (msg.kind === 'system') {
        // System banner — warnings / errors / inter-agent traffic. Forwarded
        // to the effects layer if it provides applySystem (replay path does;
        // live path's patchAsst leaves it undefined since session-stream.ts
        // has its own pushSystemMessage channel that runs in parallel).
        eff.applySystem?.(msg as SystemMessage);
      }
      // 'tool_result' messages skipped — handled by onUpdateMessage instead.
    },
    onUpdateMessage: (callId, merged) => {
      if (merged.kind !== 'tool_call') return;
      const tc = rendererToolCallToLegacy(merged as ToolCallMessage);
      eff.applyMain((m) => ({
        ...m,
        toolCalls: m.toolCalls.map((t) =>
          t.callId === callId ? { ...t, ...tc, at: t.at ?? m.text.length } : t,
        ),
      }));
    },
    onTurn: (turn) => {
      // user_input fires as a one-shot onTurn (agent='user', single msg).
      // Replay binds eff.onUserInput to commit it; live ignores (user bubble
      // was pushed manually before SSE started).
      //
      // Inter-agent user_input is reshaped by formatEvent into a SystemMessage
      // (kind='system' with direction=incoming/outgoing). Route it through
      // applySystem so it renders as a 来信/出信 line in the appropriate slot
      // instead of a plain user-bubble that would be visually confused with
      // the human's own input.
      if (turn.agent === 'user') {
        const first = turn.messages[0];
        if (!first) return;
        if (first.kind === 'user_input') {
          eff.onUserInput?.(first.text, first.timestamp, first.msgId);
        } else if (first.kind === 'system') {
          eff.applySystem?.(first as SystemMessage);
        }
      }
    },
  };
}

// ── Callbacks for a sub-agent ────────────────────────────────────────────

/**
 * Build the TurnAccumulator callback bundle for a single sub-agent
 * identified by emitterId. Mutates `subAgents[emitterId]` via `eff.applySub`.
 *
 * Symmetric to buildMainCallbacks — including `at` positioning on tool_call
 * messages. The previous design (sub bubbles not snap-aligned) was reversed
 * because the user requirement is that default insertion order follows
 * event time. Sub bubble's `at` snaps against the sub-text's own length
 * (r.text.length), not the main text. SubAgentCard's interleave then renders
 * tool chips inline with sub text just like ForgeCard does for main.
 */
export function buildSubCallbacks(
  emitterId: string,
  eff: MessageEffects,
): TurnAccCallbacks {
  return {
    onStreamText: (text) => {
      eff.applySub(emitterId, (r) => ({ ...r, text: r.text + text }));
    },
    onThinkingText: (text) => {
      eff.applySub(emitterId, (r) => ({ ...r, thinking: (r.thinking ?? '') + text }));
    },
    onMessage: (msg) => {
      if (msg.kind === 'tool_call') {
        eff.applySub(emitterId, (r) => ({
          ...r,
          toolCalls: [
            ...r.toolCalls,
            { ...rendererToolCallToLegacy(msg as ToolCallMessage), at: r.text.length },
          ],
        }));
      } else if (msg.kind === 'assistant_complete') {
        // Same rationale as buildMainCallbacks: replay sees only the
        // final assistantMessage payload (stream:llm is not persisted),
        // so text must come from msg.text. Live overrides with identical
        // content, idempotent.
        eff.applySub(emitterId, (r) => ({
          ...r,
          text: msg.text || r.text,
          thinking: msg.thinking || r.thinking || undefined,
        }));
      } else if (msg.kind === 'system') {
        // Sub-agent system banner — same channel as the main, scoped to
        // this sub's bubble owner. applySystem is shared with the main
        // bubble so warnings/errors emitted on the sub's ledger surface
        // alongside the chat thread instead of being silently dropped.
        eff.applySystem?.(msg as SystemMessage);
      }
    },
    onUpdateMessage: (callId, merged) => {
      if (merged.kind !== 'tool_call') return;
      const tc = rendererToolCallToLegacy(merged as ToolCallMessage);
      eff.applySub(emitterId, (r) => ({
        ...r,
        toolCalls: r.toolCalls.map((t) =>
          t.callId === callId ? { ...t, ...tc, at: t.at ?? r.text.length } : t,
        ),
      }));
    },
    onTurn: () => {
      // Sub-agent's per-turn boundary doesn't drive any UI state here —
      // status flips happen via finalizeStreamingStatus in replay or
      // sendMessage's finally block in live. Required by TurnAccCallbacks.
    },
  };
}

// ── In-memory effects (used by replay) ───────────────────────────────────

/**
 * Build effects that mutate an in-memory ChatMessage[] for replay.
 * Caller passes the array and a unique-id factory; after all events are
 * fed through TurnAccumulators, the array is committed to the store with
 * a single patchTabMessages call.
 *
 * Semantics:
 *  - applyMain: find the most-recent assistant ChatMessage; create one if
 *    no assistant bubble exists yet (e.g. an event arrives before any
 *    user_input was processed). Replace in place.
 *  - applySub: same, but mutates messages[N].subAgents[emitterId]. Lazily
 *    materialises the SubAgentRun on first reference.
 *  - onUserInput: push a user ChatMessage AND a fresh assistant skeleton
 *    so subsequent main-agent events have a target.
 */
export function makeInMemEffects(
  messages: ChatMessage[],
  newId: () => string,
): MessageEffects {
  const findCurrentAsstIdx = (): number => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'assistant') return i;
    }
    return -1;
  };
  const ensureAsst = (ts: number): number => {
    let idx = findCurrentAsstIdx();
    if (idx === -1) {
      messages.push({
        id: newId(),
        role: 'assistant',
        text: '',
        toolCalls: [],
        status: 'streaming',
        ts,
      });
      idx = messages.length - 1;
    }
    return idx;
  };

  // When set, the previous main-agent turn ended (sealMain) — the next
  // applyMain must open a FRESH bubble rather than reuse the most-recent
  // assistant. This is what interleaves a multi-turn forge thread with the
  // inter-agent cards `applySystem` appended in between, matching live.
  let mainSealed = false;

  return {
    applyMain: (mut) => {
      if (mainSealed) {
        messages.push({
          id: newId(),
          role: 'assistant',
          text: '',
          toolCalls: [],
          status: 'streaming',
          ts: Date.now(),
        });
        mainSealed = false;
      }
      const idx = ensureAsst(Date.now());
      messages[idx] = mut(messages[idx]!);
    },
    sealMain: () => {
      mainSealed = true;
    },
    applySub: (emitterId, mut) => {
      const idx = ensureAsst(Date.now());
      const host = messages[idx]!;
      const subAgents = { ...(host.subAgents ?? {}) };
      const prev: SubAgentRun = subAgents[emitterId] ?? {
        emitterId,
        text: '',
        toolCalls: [],
        status: 'streaming',
        startedAt: Date.now(),
      };
      subAgents[emitterId] = mut(prev);
      messages[idx] = { ...host, subAgents };
    },
    onUserInput: (text, ts, msgId) => {
      // Commit any open assistant bubble before starting a new turn — the
      // streaming → done flip happens here because hook:turnEnd of the
      // previous turn is what closed it. We finalize the last assistant
      // and prepare a fresh skeleton for whatever events arrive next.
      // This pushes its own assistant skeleton, so clear any pending seal to
      // avoid the next applyMain spawning a second, blank bubble.
      mainSealed = false;
      const lastIdx = findCurrentAsstIdx();
      if (lastIdx !== -1 && messages[lastIdx]!.status === 'streaming') {
        messages[lastIdx] = { ...messages[lastIdx]!, status: 'done' };
      }
      messages.push({
        id: newId(),
        role: 'user',
        text,
        toolCalls: [],
        status: 'done',
        ts,
        ...(msgId ? { msgId } : {}),
      });
      // Pre-allocate the assistant bubble for this turn so applyMain has
      // a target without each callback having to ensureAsst.
      messages.push({
        id: newId(),
        role: 'assistant',
        text: '',
        toolCalls: [],
        status: 'streaming',
        ts,
      });
    },
    applySystem: (msg) => {
      // System banner messages from the formatter (warnings / errors /
      // inter-agent traffic). APPEND to the tail — byte-for-byte parity with
      // the live path (session-stream.ts pushSystemMessage), which also
      // appends. The previous "splice before the trailing streaming assistant"
      // diverged from live and mis-ordered cross-turn inter-agent traffic: the
      // forge bubble stays `streaming` across the sub-agent round-trip, so each
      // forge→sub / sub→forge line spliced ABOVE it kept pushing the forge card
      // to the bottom (it ended up after a sub-agent's completion report even
      // though forge spoke first). Appending preserves real event-time order.
      //
      // Adjacent dedupe: identical text + level + direction collapses with the
      // previous system row (also matches session-stream.ts).
      const text = msg.text;
      if (!text) return;
      const last = messages[messages.length - 1];
      if (
        last &&
        last.role === 'system' &&
        last.text === text &&
        last.level === msg.level &&
        last.direction === msg.direction
      ) {
        return;
      }
      messages.push({
        id: newId(),
        role: 'system',
        text,
        toolCalls: [],
        status: 'done',
        ts: msg.timestamp,
        level: msg.level,
        direction: msg.direction,
        source: msg.source,
        from: msg.from,
        to: msg.to,
      });
    },
  };
}

/**
 * After all events are fed, flip any still-streaming assistant / sub-agent
 * runs to 'done'. Called by replay caller after mainAcc.flush() / each
 * subAcc.flush(). Live mode handles this in its own finally block.
 */
export function finalizeStreamingStatus(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    let changed = false;
    let next = m;
    if (m.role === 'assistant' && m.status === 'streaming') {
      next = { ...next, status: 'done' };
      changed = true;
    }
    if (m.subAgents) {
      const subAgents: Record<string, SubAgentRun> = {};
      let subChanged = false;
      for (const [eid, r] of Object.entries(m.subAgents)) {
        if (r.status === 'streaming') {
          subAgents[eid] = { ...r, status: 'done' };
          subChanged = true;
        } else {
          subAgents[eid] = r;
        }
      }
      if (subChanged) {
        next = { ...next, subAgents };
        changed = true;
      }
    }
    if (changed) messages[i] = next;
  }
}
