/**
 * Renderer event-engine types — ported from @forgeax/orchestrator's
 * `src/channels/ink-renderer/types.ts`. Trimmed to the data model only;
 * ink-specific types (InputSegment / OverlayRequest / SlashCommand /
 * RendererCallbacks / RendererDataSource) are dropped because the web UI
 * doesn't share that scheduling surface.
 *
 * StoredEvent is the wire shape carried by forgeax-server's SSE
 * `event: stored-event` frames (introduced in forgeax-server PR #4). The
 * envelope fields (agentId / sessionId / threadId / runId) live on the
 * frame, not on this type — the store strips them before calling
 * TurnAccumulator.feed(storedEvent).
 */

// ── StoredEvent — raw EventBus event shape (@forgeax/orchestrator native) ──

export interface StoredEvent {
  type: string;
  ts?: number;
  source?: string;
  to?: string;
  emitterId?: string;
  handoff?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── RendererMessage union ──

export interface RendererMessageBase {
  kind: string;
  agent: string;
  timestamp: number;
}

export type RendererMessage =
  | UserInputMessage
  | AssistantCompleteMessage
  | ToolCallMessage
  | ToolResultMessage
  | SystemMessage;

export interface UserInputMessage extends RendererMessageBase {
  kind: 'user_input';
  text: string;
  isSteer: boolean;
  source: string;
  /** checkpoint 回退点外键(payload.msgId,server 注入;旧事件无)。 */
  msgId?: string;
  /** Path-only (or live base64) attachments from user_input payload. */
  attachments?: Array<{
    kind?: string;
    name?: string;
    mediaType?: string;
    path?: string;
    data?: string;
  }>;
}

export interface AssistantCompleteMessage extends RendererMessageBase {
  kind: 'assistant_complete';
  text: string;
  thinking: string;
}

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

export interface ToolCallMessage extends RendererMessageBase {
  kind: 'tool_call';
  id: string;
  name: string;
  status: ToolStatus;
  visualDisplay?: string;
  args: unknown;
  resultDisplay?: string;
  resultContent?: string;
  /** Full untruncated result for progressive expansion (when resultContent is truncated). */
  fullResultContent?: string;
  durationMs?: number;
  subagentId?: string;
}

export interface ToolResultMessage extends RendererMessageBase {
  kind: 'tool_result';
  callId: string;
  name: string;
  visualDisplay?: string;
  content: string;
  /** Full untruncated content — only set when content was truncated. */
  fullContent?: string;
  durationMs: number;
  /** True when the tool execution failed / was aborted. */
  isError?: boolean;
}

export interface SystemMessage extends RendererMessageBase {
  kind: 'system';
  source: string;
  text: string;
  visualDisplay?: string;
  level?: 'info' | 'warning' | 'error';
  /**
   * Direction of inter-agent traffic. Set by the fallback path for any non-hook
   * event with content. `to` field decides: present → incoming, absent → outgoing.
   * UI decides visual encoding.
   */
  direction?: 'incoming' | 'outgoing';
  /** Sender agent id, copied verbatim from `event.emitterId`. */
  from?: string;
  /** Recipient agent id (only present when direction === 'incoming'). */
  to?: string;
}

// ── CompletedTurn ──

export interface CompletedTurn {
  agent: string;
  messages: RendererMessage[];
  timestamp: number;
  /** When true, this turn is still being built (live streaming). commitTurn replaces it. */
  _draft?: boolean;
}
