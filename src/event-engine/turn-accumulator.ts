/**
 * TurnAccumulator — pure-logic state machine for building CompletedTurn[]
 * from a stream of StoredEvent records.
 *
 * Runtime context.usage events provide authoritative occupancy. Historical
 * assistant usage falls back to the model table only until native facts arrive.
 *
 * Both replay (batch) and live (incremental) paths use the same instance,
 * differing only in which callbacks they provide:
 *   - Replay: onTurn + onMeta only (batch, no streaming)
 *   - Live:   all callbacks (incremental rendering + streaming)
 *
 * NOTE: thinking/running state is NOT inferred from turnStart/turnEnd here.
 * That stays a UI-layer concern (e.g. a per-agent RUNNING flag). The
 * accumulator only handles message/turn assembly and streaming.
 */

import { contextKernelId, runtimeContextUsage, latestContextUsage, type ContextUsage } from './context-usage';
import type {
  StoredEvent,
  CompletedTurn,
  RendererMessage,
  ToolCallMessage,
  ToolResultMessage,
} from './types';
import { formatEvent } from './event-formatter';
import { SubagentCallIndex, handleSubagentEvent } from './subagent-events';

// ── Inline context-window lookup ──
//
// Legacy fallback for providers and historical ledgers without context.usage.
// Native runtime events always override this estimate; never infer a native
// kernel's active context window from its public model name.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-8': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-opus-4-1': 200000,
  'claude-opus-4-0': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-7-sonnet-20250219': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'gpt-5.5': 1050000,
  'gpt-5.6': 1050000,
  'gpt-5.4': 1050000,
  'gpt-5.4-mini': 400000,
  'gpt-5.2': 400000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gemini-2.5-flash': 1048576,
  'gemini-2.5-pro': 1048576,
  'gemini-aistudio/gemini-2.5-flash': 1048576,
  'deepseek-v4-pro': 1000000,
  'deepseek-v4-flash': 1000000,
  'deepseek/deepseek-chat': 64000,
};

const DEFAULT_CONTEXT_WINDOW = 200000;

const MODEL_CONTEXT_WINDOW_PREFIXES = Object.entries(MODEL_CONTEXT_WINDOWS)
  .sort(([a], [b]) => b.length - a.length);

function contextWindowForModel(model: unknown): number {
  const normalized = typeof model === 'string' ? model.trim().toLowerCase() : undefined;
  if (!normalized) return DEFAULT_CONTEXT_WINDOW;

  const exact = MODEL_CONTEXT_WINDOWS[normalized];
  if (exact !== undefined) return exact;

  return MODEL_CONTEXT_WINDOW_PREFIXES.find(([prefix]) => normalized.startsWith(prefix))?.[1]
    ?? DEFAULT_CONTEXT_WINDOW;
}

function safeTokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Return a UI-safe fill ratio. The ring represents a bounded window, so an
 * over-limit provider report is rendered as full rather than leaking values
 * such as 366% into the composer and SVG dash math. */
function contextRatioFromUsage(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  model: unknown,
): number {
  // Normalized gateway usage reports uncached input separately from cache reads/writes.
  // Driver occupancy, when present, remains authoritative over this estimate.
  const total = safeTokenCount(usage.inputTokens) + safeTokenCount(usage.outputTokens) +
    safeTokenCount(usage.cacheReadTokens) + safeTokenCount(usage.cacheWriteTokens);
  const cw = contextWindowForModel(model);
  if (!(cw > 0)) return 0;
  return Math.min(1, total / cw);
}

export function ratioFromUsage(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  model: unknown,
): number {
  return Math.round(contextRatioFromUsage(usage, model) * 100);
}

function ratioFromAssistantMessage(payload: Record<string, unknown>): number | null {
  const usage = payload.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
  const model = payload.model;
  if (!usage || !model) return null;
  return contextRatioFromUsage(usage, model);
}

// ── Callback interface ──

export interface TurnAccCallbacks {
  /** A complete turn was produced (turnEnd or next turnStart boundary). */
  onTurn(turn: CompletedTurn): void;
  /** A single message is ready for immediate rendering (live mode). */
  onMessage?(msg: RendererMessage): void;
  /** A tool_call was updated in-place with its result (live mode). */
  onUpdateMessage?(callId: string, merged: RendererMessage): void;
  /** Metadata changed (session label, context usage, thinking state). */
  onMeta?(meta: { session?: string; contextPct?: number; contextUsage?: ContextUsage; thinking?: boolean }): void;
  /** Streaming text chunk. */
  onStreamText?(text: string): void;
  /** Streaming thinking chunk. */
  onThinkingText?(text: string): void;
  /** Streaming buffers should be cleared. */
  onResetStreaming?(): void;
}

// ── State machine ──

interface StreamLlmChunk {
  chunk: { type: 'text' | 'thinking'; text: string };
}

export class TurnAccumulator {
  private cb: TurnAccCallbacks;

  /** Ledger owner — drives viewer-aware direction (to===viewer → incoming). */
  private viewerId?: string;

  private currentAgent = '';
  private currentMessages: RendererMessage[] = [];
  private turnTs = 0;
  private streamText = '';
  private thinkingText = '';
  private contextUsage?: ContextUsage;

  /** subagentId → callId mapping for background subagent result merging. */
  private subagentCallIndex = new SubagentCallIndex();

  /**
   * callId → index in currentMessages. Tracks tool calls that have received
   * hook:toolCall but not yet hook:toolResult. Used for:
   *   1. O(1) result merge (replaces mergeToolResult backward scan)
   *   2. Orphan detection at turn boundaries (normalizeToolTimeline pattern)
   */
  private pendingToolCalls = new Map<string, number>();

  constructor(callbacks: TurnAccCallbacks, viewerId?: string) {
    this.cb = callbacks;
    this.viewerId = viewerId;
  }

  /** Process one event. Handles turn boundaries, streaming, tool merge, etc. */
  feed(event: StoredEvent): void {
    if (typeof event.type !== 'string') return;
    if (event.type.startsWith('_')) return;

    if (event.type === 'user_input') {
      const msg = formatEvent(event, this.viewerId);
      // Delegation traffic is a system card inside the open parent turn.
      // Only actual human input commits that turn and finalizes its tools.
      if (msg?.kind === 'user_input') this.commitPending();
      if (msg) {
        this.cb.onTurn({
          agent: 'user',
          messages: [msg],
          timestamp: (event.ts as number) ?? Date.now(),
        });
      }
      return;
    }

    const emitter = event.emitterId ?? event.source ?? '';
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === 'context.usage') {
      if (this.viewerId && event.emitterId && event.emitterId !== this.viewerId) return;
      const usage = runtimeContextUsage(payload, event.ts ?? 0);
      if (usage) {
        this.contextUsage = latestContextUsage(this.contextUsage, usage);
        this.cb.onMeta?.({ contextPct: this.contextUsage.pct, contextUsage: this.contextUsage });
      }
      return;
    }

    switch (event.type) {
      case 'hook:turnStart':
        this.commitPending();
        this.currentAgent = emitter;
        this.turnTs = (event.ts as number) ?? Date.now();
        this.streamText = '';
        this.thinkingText = '';
        this.cb.onResetStreaming?.();
        {
          const sess = (payload.session ?? payload.sessionId ?? '') as string;
          if (sess) this.cb.onMeta?.({ session: sess });
        }
        if (emitter && emitter !== 'user') this.cb.onMeta?.({ thinking: true });
        break;

      case 'hook:turnEnd':
        if (payload.waitingForInput === true) break;
        this.cb.onMeta?.({ thinking: false });
        this.finalizeTurn(emitter, payload.aborted === true || typeof payload.error === 'string', event.ts ?? Date.now(), typeof payload.error === 'string' ? payload.error : undefined, payload.aborted === true);
        break;

      case 'hook:assistantMessage': {
        const msg = formatEvent(event, this.viewerId);
        if (msg) {
          this.pushMessage(msg);
          this.streamText = '';
          this.thinkingText = '';
          this.cb.onResetStreaming?.();
        }
        const ratio = ratioFromAssistantMessage(payload);
        if (ratio !== null && ratio > 0 && (!this.viewerId || !event.emitterId || event.emitterId === this.viewerId)) {
          this.contextUsage = latestContextUsage(this.contextUsage, { pct: Math.round(ratio * 100), source: 'estimate', ts: event.ts ?? 0, kernelId: contextKernelId(payload) });
          this.cb.onMeta?.({ contextPct: this.contextUsage.pct, contextUsage: this.contextUsage });
        }
        break;
      }

      case 'stream:llm': {
        const chunk = (payload as unknown as StreamLlmChunk).chunk;
        if (!chunk) break;
        if (chunk.type === 'text' && chunk.text) {
          this.streamText += chunk.text;
          this.cb.onStreamText?.(chunk.text);
        } else if (chunk.type === 'thinking' && chunk.text) {
          this.thinkingText += chunk.text;
          this.cb.onThinkingText?.(chunk.text);
        }
        break;
      }

      case 'hook:toolCall': {
        const msg = formatEvent(event, this.viewerId) as ToolCallMessage | null;
        if (msg) {
          const idx = this.currentMessages.length;
          this.pushMessage(msg);
          this.pendingToolCalls.set(msg.id, idx);
        }
        break;
      }

      case 'hook:toolResult': {
        const result = formatEvent(event, this.viewerId) as ToolResultMessage | null;
        if (!result) break;
        const isError =
          result.isError || result.content?.startsWith('Error') || result.content?.startsWith('error');
        const status: 'error' | 'done' = isError ? 'error' : 'done';
        const resultFields = {
          ...(result.name && result.name !== 'tool' ? { name: result.name } : {}),
          status,
          resultDisplay: result.visualDisplay,
          resultContent: result.content,
          fullResultContent: result.fullContent,
          resultData: result.resultData,
          durationMs: result.durationMs,
        };
        const idx = this.pendingToolCalls.get(result.callId);
        this.pendingToolCalls.delete(result.callId);
        if (idx !== undefined) {
          const merged: RendererMessage = {
            ...(this.currentMessages[idx] as ToolCallMessage),
            ...resultFields,
          };
          this.currentMessages[idx] = merged;
          this.cb.onUpdateMessage?.(result.callId, merged);
        } else {
          // Tool call in a previously committed turn (e.g. replay → live handoff).
          // Fire onUpdateMessage so the caller can search committed turns.
          this.cb.onUpdateMessage?.(result.callId, resultFields as unknown as RendererMessage);
        }
        break;
      }

      case 'hook:toolCall:pending':
        break;

      case 'instance_restarted':
        this.finalizeOrphanedToolCalls(true);
        break;

      case 'subagent_launched':
      case 'subagent_result':
      case 'subagent_error': {
        const result = handleSubagentEvent(event, this.currentMessages, this.subagentCallIndex);
        if (result.newMessage) {
          this.pushMessage(result.newMessage);
        }
        if (result.update) {
          this.cb.onUpdateMessage?.(result.update.callId, result.update.merged);
        }
        break;
      }

      default: {
        const msg = formatEvent(event, this.viewerId);
        if (msg) this.pushMessage(msg);
        break;
      }
    }
  }

  /**
   * Flush any remaining accumulated messages as a final turn (call after last
   * event). Does NOT finalize orphaned tool calls — the agent may still be
   * running and results may arrive later via the live event stream.
   */
  flush(): void {
    this.commitPending(/* finalizeOrphans */ false);
  }

  // ── internals ──

  private pushMessage(msg: RendererMessage): void {
    this.currentMessages.push(msg);
    if (!this.turnTs) this.turnTs = msg.timestamp;
    // currentAgent only changes at turn boundaries (where emitter ≡ owner);
    // msg.agent is the emitter, not the owner — must not overwrite here.
    this.cb.onMessage?.(msg);
  }

  /**
   * Finalize orphaned tool calls whose results never arrived. Mirrors
   * normalizeToolTimeline's batchClosed → createInterruptedToolResult
   * inference: if we reach a turn boundary and pendingToolCalls is non-empty,
   * those calls were interrupted (e.g. by instance restart / SIGTERM).
   *
   * When updateLive is true, also fires onUpdateMessage for each affected call
   * so the UI updates immediately (used by instance_restarted handler).
   */
  private finalizeOrphanedToolCalls(updateLive = false): void {
    if (this.pendingToolCalls.size === 0) return;

    for (const [callId, idx] of this.pendingToolCalls) {
      const tc = this.currentMessages[idx] as ToolCallMessage | undefined;
      if (!tc || tc.kind !== 'tool_call') continue;

      const patched: RendererMessage = {
        ...tc,
        status: 'error',
        resultContent: '[Interrupted: tool call did not produce a result]',
      };
      this.currentMessages[idx] = patched;

      if (updateLive) {
        this.cb.onUpdateMessage?.(callId, patched);
      }
    }
    this.pendingToolCalls.clear();
  }

  /** Commit accumulated messages (if any) as a completed turn. */
  private commitPending(finalizeOrphans = true): void {
    if (this.currentMessages.length > 0) {
      if (finalizeOrphans) this.finalizeOrphanedToolCalls();
      this.cb.onTurn({
        agent: this.currentAgent,
        messages: this.currentMessages,
        timestamp: this.turnTs,
      });
      this.currentMessages = [];
    }
  }

  /**
   * Called on hook:turnEnd — if assistantMessage already arrived via
   * pushMessage, streamText is empty and we just commit. The streamText branch
   * is a fallback for when turnEnd fires before/without a hook:assistantMessage.
   */
  private finalizeTurn(agent: string, interrupted = false, timestamp = Date.now(), error?: string, aborted?: boolean): void {
    if (this.streamText) {
      this.currentMessages.push({
        kind: 'assistant_complete',
        text: this.streamText.trim(),
        thinking: this.thinkingText.trim(),
        agent: agent || this.currentAgent,
        timestamp,
      });
    }

    if (this.currentMessages.length > 0 || interrupted) {
      this.finalizeOrphanedToolCalls();
      this.cb.onTurn({
        agent: agent || this.currentAgent,
        messages: this.currentMessages,
        timestamp: this.turnTs || Date.now(),
        ...(interrupted ? { interrupted: true } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(aborted !== undefined ? { aborted } : {}),
      });
    }

    this.currentMessages = [];
    this.turnTs = 0;
    this.streamText = '';
    this.thinkingText = '';
    this.cb.onResetStreaming?.();
  }
}
