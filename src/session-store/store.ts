/** `@forgeax/chat` conversation store (R4 — message content owned by chat).
 *
 *  This is the real home of the *message-content* domain extracted from
 *  `@forgeax/interface`'s monolithic `useShellStore`. The session REGISTRY
 *  (`tabs` / `activeSid` / agent binding) and agent-runtime state stay in L1;
 *  this store owns only what is chat-private: the conversation messages, their
 *  streaming/replay pipeline, the client-side send queue, and rewind UI state.
 *
 *  KEYING — the big simplification vs the old L1 design
 *  ----------------------------------------------------
 *  The old store nested messages inside each `ChatTab` and maintained a triple
 *  mirror (`tab.messages` ↔ `tab.messagesByAgent[agentId]` ↔ top-level
 *  `state.messages`) plus a slot-swap on every agent switch. Here messages are
 *  keyed purely by `(sid, agentId)`:
 *
 *      bySid[sid].messagesByAgent[agentId] -> ChatMessage[]
 *
 *  There is NO active mirror. Components derive the visible thread with a
 *  selector that reads the active `(sid, agentId)` from L1's registry and looks
 *  up the bucket here — so switching agents is just selecting a different
 *  bucket, and the slot-swap bookkeeping disappears entirely.
 *
 *  L1 COORDINATION
 *  ---------------
 *  Registry facts (active sid, a tab's pinned agentId, the per-tab provider
 *  override) are read on demand from `useShellStore.getState()`. This store never
 *  writes the registry; the registry never writes messages.
 */
import { create } from 'zustand';
import { t } from '@/i18n';
import {
  useShellStore,
  type ChatAttachment,
  type ChatMessage,
  type ChatSegment,
  type SubAgentRun,
  type ToolCall,
} from '@forgeax/interface/store';
import { parseSse } from '@forgeax/interface/lib/sse';
import { expandPills, expandPillsForDisplay } from '@forgeax/interface/lib/composer-bridge';
import { resolveReplyLanguage } from '@forgeax/interface/lib/reply-language';
import { TurnAccumulator } from '../event-engine/turn-accumulator';
import {
  parseEventLines,
  trimToCompactBoundary,
} from '../event-engine/event-replay';
import { hydrateLedgerBlobs } from '../event-engine/ledger-blob-hydration';
import { applyRewindMask, findPendingRewind } from '../event-engine/rewind-mask';
import {
  buildMainCallbacks,
  buildSubCallbacks,
  finalizeStreamingStatus,
  makeInMemEffects,
  rendererToolCallToLegacy,
  type MessageEffects,
} from '../event-engine/message-builder';
import type { StoredEvent, ToolCallMessage } from '../event-engine/types';

// ── Local types (chat-owned) ────────────────────────────────────────────────

/** One client-side queued message awaiting its turn (Cursor-style queue). */
export interface QueuedMessage {
  id: string;
  text: string;
  ts: number;
}

export interface SendMessageOpts {
  handoff?: 'steer';
  attachments?: Array<Record<string, unknown>>;
  /** Internal target pin used after async preparation and queue flushes. */
  target?: { sid: string; agentId: string };
  /** Internal acceptance callback; invoked after the pinned target is validated. */
  onAccepted?: () => void;
}

function toChatAttachments(raw: Array<Record<string, unknown>> | undefined): ChatAttachment[] | undefined {
  if (!raw?.length) return undefined;
  const out: ChatAttachment[] = [];
  for (const item of raw) {
    const kind = typeof item.kind === 'string' ? item.kind : 'file';
    out.push({
      kind,
      name: typeof item.name === 'string' ? item.name : undefined,
      mediaType: typeof item.mediaType === 'string' ? item.mediaType : undefined,
      data: typeof item.data === 'string' ? item.data : undefined,
      path: typeof item.path === 'string' ? item.path : undefined,
    });
  }
  return out;
}

/** checkpoint 软回退挂起态(Cursor 语义)。非 null = 被回退段置灰显示中。 */
export interface PendingRewind {
  boundaryId: string;
  targetMsgId: string;
  mode: 'both' | 'conversation' | 'code';
  keptDirty: string[];
  overwrite: { files: string[] } | null;
}

export interface RewindDirtyNotice {
  boundaryId: string;
  keptDirty: string[];
  overwrite: { files: string[] } | null;
}

/** Per-session conversation slice — everything chat-private about one `sid`. */
export interface ConvSlice {
  /** Per-agent message slots, keyed by `agentPath`. */
  messagesByAgent: Record<string, ChatMessage[]>;
  /** Per-agent streaming flags. */
  streamingByAgent: Record<string, boolean>;
  /** Context-window fill ratio (0..1) for the session. */
  contextPct: number;
  /** Currently in-flight server-side `Run.id` (cli-provider path). */
  runId: string | null;
  pendingRewind: PendingRewind | null;
  rewindDirtyNotice: RewindDirtyNotice | null;
  /** msgId -> 是否有代码 checkpoint。 */
  checkpointMsgIds: Record<string, boolean>;
}

const EMPTY_CONV: ConvSlice = {
  messagesByAgent: {},
  streamingByAgent: {},
  contextPct: 0,
  runId: null,
  pendingRewind: null,
  rewindDirtyNotice: null,
  checkpointMsgIds: {},
};

const EMPTY_MESSAGES: ChatMessage[] = [];

// ── Module-private runtime maps (moved verbatim from L1 store) ───────────────

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Per-sid owner of the in-flight turn controller. */
interface TurnController {
  controller: AbortController;
  agentId: string;
}
const _abortByTab = new Map<string, TurnController>();

/** EventSource tails opened by loadThreadHistory for runs still streaming. */
const _tailsByTab = new Map<string, Set<EventSource>>();
function trackTail(sid: string, es: EventSource): void {
  let set = _tailsByTab.get(sid);
  if (!set) { set = new Set(); _tailsByTab.set(sid, set); }
  set.add(es);
}
function untrackTail(sid: string, es: EventSource): void {
  const set = _tailsByTab.get(sid);
  if (!set) return;
  set.delete(es);
  if (set.size === 0) _tailsByTab.delete(sid);
}
function closeThreadHistoryTails(sid: string): void {
  const set = _tailsByTab.get(sid);
  if (!set) return;
  for (const es of set) {
    try { es.close(); } catch { /* */ }
  }
  _tailsByTab.delete(sid);
}

// ── Pure segment reducers (moved from L1; chat owns them now) ────────────────

/** Push `chunk` into `segments`, coalescing into the last segment when it
 *  matches kind (text↔text, thinking↔thinking). Tool segments never coalesce. */
export function appendChatSegment(
  segments: ChatSegment[],
  next:
    | { kind: 'text'; ts: number; text: string }
    | { kind: 'thinking'; ts: number; text: string },
): ChatSegment[] {
  if (!next.text) return segments;
  const last = segments[segments.length - 1];
  if (last && last.kind === next.kind) {
    const merged: ChatSegment =
      next.kind === 'text'
        ? { kind: 'text', ts: last.ts, text: (last as { text: string }).text + next.text }
        : { kind: 'thinking', ts: last.ts, text: (last as { text: string }).text + next.text };
    return [...segments.slice(0, -1), merged];
  }
  return [...segments, next];
}

/** Replace an existing tool segment (matched by callId) with a fresh ToolCall,
 *  or append a new tool segment when no match is found. */
export function upsertToolSegment(
  segments: ChatSegment[],
  ts: number,
  next: ToolCall,
): ChatSegment[] {
  const idx = segments.findIndex(
    (s) => s.kind === 'tool' && (s as { tool: ToolCall }).tool.callId === next.callId,
  );
  if (idx >= 0) {
    const updated: ChatSegment = { kind: 'tool', ts: segments[idx].ts, tool: next };
    return [...segments.slice(0, idx), updated, ...segments.slice(idx + 1)];
  }
  return [...segments, { kind: 'tool', ts, tool: next }];
}

// ── AG-UI replay (subprocess providers: claude-code / codex / cursor-agent) ──

export interface AguiStoredEvent {
  id: string;
  seq: number;
  ts: number;
  runId: string;
  event: { type: string } & Record<string, unknown>;
}

function consumeAguiEvents(events: AguiStoredEvent[]): {
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  status: 'streaming' | 'done' | 'error';
  segments: ChatSegment[];
  lastSeq: number;
} {
  let text = '';
  let thinking = '';
  const tcMap = new Map<string, ToolCall>();
  const order: string[] = [];
  let segments: ChatSegment[] = [];
  let finished = false;
  let errored = false;
  let lastSeq = -1;

  const upsertTc = (id: string, ts: number, next: ToolCall): void => {
    tcMap.set(id, next);
    if (!order.includes(id)) order.push(id);
    segments = upsertToolSegment(segments, ts, next);
  };

  for (const stored of events) {
    if (typeof stored.seq === 'number' && stored.seq > lastSeq) lastSeq = stored.seq;
    const ev = stored.event;
    const ts = stored.ts ?? Date.now();
    switch (ev.type) {
      case 'TEXT_MESSAGE_CONTENT':
      case 'TEXT_MESSAGE_CHUNK': {
        const delta = (ev.delta as string | undefined) ?? (ev.content as string | undefined) ?? '';
        if (delta) {
          text += delta;
          segments = appendChatSegment(segments, { kind: 'text', ts, text: delta });
        }
        break;
      }
      case 'THINKING_TEXT_MESSAGE_CONTENT':
      case 'THINKING_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CHUNK': {
        const delta = (ev.delta as string | undefined) ?? (ev.content as string | undefined) ?? '';
        if (delta) {
          thinking += delta;
          segments = appendChatSegment(segments, { kind: 'thinking', ts, text: delta });
        }
        break;
      }
      case 'TOOL_CALL_START': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const name = (ev.toolCallName as string | undefined) ?? '';
        if (!id || tcMap.has(id)) break;
        upsertTc(id, ts, { callId: id, name, args: '', status: 'running' });
        break;
      }
      case 'TOOL_CALL_ARGS':
      case 'TOOL_CALL_CHUNK': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const delta = (ev.delta as string | undefined) ?? '';
        const cur = tcMap.get(id);
        if (cur) {
          const curArgs = typeof cur.args === 'string' ? cur.args : '';
          upsertTc(id, ts, { ...cur, args: curArgs + delta });
        }
        break;
      }
      case 'TOOL_CALL_END': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const cur = tcMap.get(id);
        if (cur) {
          let parsed: unknown = cur.args;
          if (typeof parsed === 'string' && parsed) {
            try { parsed = JSON.parse(parsed); } catch { /* keep raw string */ }
          }
          upsertTc(id, ts, { ...cur, status: 'done', args: parsed });
        }
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const id = (ev.toolCallId as string | undefined) ?? '';
        const result = (ev.result as unknown) ?? (ev.content as unknown);
        const cur = tcMap.get(id);
        if (cur) {
          upsertTc(id, ts, {
            ...cur,
            status: 'done',
            result: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
        break;
      }
      case 'STEP_STARTED': {
        const id = `step:${stored.seq}`;
        upsertTc(id, ts, {
          callId: id,
          name: (ev.stepName as string | undefined) ?? 'step',
          args: ev.input ?? null,
          status: 'running',
        });
        break;
      }
      case 'STEP_FINISHED': {
        const stepName = (ev.stepName as string | undefined) ?? '';
        for (const id of order) {
          const cur = tcMap.get(id);
          if (cur && cur.status === 'running' && cur.name === stepName && id.startsWith('step:')) {
            upsertTc(id, ts, { ...cur, status: 'done' });
            break;
          }
        }
        break;
      }
      case 'RUN_FINISHED': finished = true; break;
      case 'RUN_ERROR':    errored = true;  break;
      default: break;
    }
  }

  const status: 'streaming' | 'done' | 'error' = errored ? 'error' : finished ? 'done' : 'streaming';
  return {
    text,
    thinking: thinking || undefined,
    toolCalls: order.map((id) => tcMap.get(id)!).filter(Boolean),
    status,
    segments,
    lastSeq,
  };
}

/** R3: server fetch_session_events 签名 `args=[sid, agentPath]`。 */
async function fetchSessionEventsNdjson(sid: string, agentPath: string): Promise<string> {
  try {
    const r = await fetch('/api/commands/fetch_session_events/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [sid, agentPath] }),
    });
    if (!r.ok) return '';
    const raw = (await r.json()) as {
      ok?: boolean; data?: string;
      result?: { ok?: boolean; data?: string };
    };
    return (raw.result?.data ?? raw.data) ?? '';
  } catch {
    return '';
  }
}

async function fetchSessionBlob(sid: string, agentPath: string, sha256: string): Promise<Uint8Array> {
  const response = await fetch('/api/commands/fetch_blob/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: [sid, agentPath, sha256] }),
  });
  if (!response.ok) throw new Error(`fetch_blob returned ${response.status}`);
  const raw = (await response.json()) as {
    data?: { data?: string };
    result?: { ok?: boolean; data?: { data?: string } };
  };
  const base64 = raw.result?.data?.data ?? raw.data?.data;
  if (!base64) throw new Error('fetch_blob returned no data');
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// ── Store shape ──────────────────────────────────────────────────────────────

interface ChatStoreState {
  /** Per-session conversation slices, keyed by `sid`. */
  bySid: Record<string, ConvSlice>;
  /** Client-side queued messages, keyed by `${sid}::${agentId}`. */
  queuedMessages: Record<string, QueuedMessage[]>;

  // ── low-level mutation primitives (used by session-stream + sendMessage) ──
  /** Patch a specific `(sid, agentId)` message slot. */
  patchMessages: (sid: string, agentId: string, updater: (msgs: ChatMessage[]) => ChatMessage[]) => void;
  /** Read a `(sid, agentId)` message slot (empty array if absent). */
  readMessages: (sid: string, agentId: string) => ChatMessage[];
  /** Set the per-agent streaming flag. */
  setStreaming: (sid: string, agentId: string, val: boolean) => void;
  /** Merge a partial patch into a session's conv slice. */
  patchConv: (sid: string, patch: Partial<ConvSlice>) => void;

  // ── send + stream ──
  sendMessage: (text: string, opts?: SendMessageOpts) => Promise<void>;

  // ── WAL / replay history ──
  loadSession: (sid: string, agentPath: string, opts?: { force?: boolean }) => Promise<void>;
  loadThreadHistory: (threadId: string) => Promise<void>;

  // ── checkpoint rewind ──
  loadCheckpoints: (sid: string) => Promise<void>;
  performRewind: (sid: string, msgId: string, mode: 'both' | 'conversation' | 'code') => Promise<void>;
  performRewindCancel: (sid: string) => Promise<void>;
  performOverwriteDirty: (sid: string) => Promise<void>;
  performUndoOverwrite: (sid: string) => Promise<void>;
  applyRewindEvent: (
    sid: string,
    kind: 'done' | 'cancelled' | 'finalized' | 'overwrite' | 'overwrite-undone',
    payload: Record<string, unknown>,
  ) => void;

  // ── Message queue (Cursor-style "keep typing while streaming") ──
  enqueueMessage: (text: string) => void;
  dequeueMessage: (id: string) => void;
  clearQueue: () => void;
  flushQueuedForAgent: (sid: string, agentId: string) => void;

  cancelStream: () => void;
  clearMessages: () => void;
}

/** Active `(sid, agentId)` resolved from L1's registry. */
function activeTarget(): { sid: string | null; agentId: string | null } {
  const s = useShellStore.getState();
  const sid = s.activeSid;
  const agentId = sid ? (s.tabs.find((t) => t.sid === sid)?.agentId ?? null) : null;
  return { sid, agentId };
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  bySid: {},
  queuedMessages: {},

  patchConv: (sid, patch) => set((s) => ({
    bySid: { ...s.bySid, [sid]: { ...(s.bySid[sid] ?? EMPTY_CONV), ...patch } },
  })),

  patchMessages: (sid, agentId, updater) => set((s) => {
    const conv = s.bySid[sid] ?? EMPTY_CONV;
    const prev = conv.messagesByAgent[agentId] ?? [];
    const next = updater(prev);
    return {
      bySid: {
        ...s.bySid,
        [sid]: { ...conv, messagesByAgent: { ...conv.messagesByAgent, [agentId]: next } },
      },
    };
  }),

  readMessages: (sid, agentId) => get().bySid[sid]?.messagesByAgent[agentId] ?? EMPTY_MESSAGES,

  setStreaming: (sid, agentId, val) => {
    // Mirror the per-(sid, agentId) busy flag into L1 so registry surfaces
    // (SessionSwitcher / AgentsPanel) can render a spinner without importing
    // chat message state. L1 owns the flag's storage; chat owns its truth.
    useShellStore.getState().setAgentBusy(sid, agentId, val);
    set((s) => {
      const conv = s.bySid[sid] ?? EMPTY_CONV;
      return {
        bySid: {
          ...s.bySid,
          [sid]: { ...conv, streamingByAgent: { ...conv.streamingByAgent, [agentId]: val } },
        },
      };
    });
  },

  loadSession: async (sid: string, agentPath: string, opts?: { force?: boolean }) => {
    // forgeax: each (sid, agentPath) has its own ledger
    //   `<sid>/agents/<agentPath>/events/events-N.jsonl` + blobs/.
    if (!sid || !agentPath) return;
    try {
      // Defense in depth: don't clobber a slot whose tail assistant is in a
      // non-terminal (streaming/error) state — in-memory is more recent than
      // the WAL (broken model / abort wrote user_input but no assistant_complete).
      // 多 tab 同步:带身份锚(`live:` msgId)的在途流式气泡走 merge 保留(下方
      // commit),不再挡整个回放 —— 否则中途加入的 tab 看不到历史;`force` 供
      // resume-gap 全量恢复(server 已声明本地态陈旧)。
      const slotSnap = get().bySid[sid]?.messagesByAgent[agentPath] ?? [];
      const nonDaemon = slotSnap.filter((m) => !m.id.startsWith('daemon-tick-'));
      const tailAsst = [...nonDaemon].reverse().find((m) => m.role === 'assistant');
      const tailAnchored = typeof tailAsst?.msgId === 'string' && tailAsst.msgId.startsWith('live:');
      const slotHasUnpersistedAsst =
        nonDaemon.length > 0 && tailAsst !== undefined &&
        (tailAsst.status === 'streaming' || tailAsst.status === 'error');
      if (slotHasUnpersistedAsst && !opts?.force && !(tailAsst.status === 'streaming' && tailAnchored)) return;

      const ndjson = await fetchSessionEventsNdjson(sid, agentPath);
      const rawEvents = parseEventLines(ndjson);
      await hydrateLedgerBlobs(
        rawEvents,
        (blob) => fetchSessionBlob(sid, agentPath, blob.sha256),
        {
          onError: (blob, error) => {
            console.warn(
              `[chat.loadSession] failed to hydrate blob sid=${sid} agent=${agentPath} sha=${blob.sha256}`,
              error instanceof Error ? error.message : String(error),
            );
          },
        },
      );
      const pendingRw = findPendingRewind(rawEvents);
      const events = trimToCompactBoundary(
        applyRewindMask(rawEvents, pendingRw ? { keepBoundaryVisible: pendingRw.boundaryId } : {}),
      );
      if (events.length === 0) {
        // Don't wipe a populated slot. Cold-start (slot has only daemon-tick-*
        // live bubbles or nothing) clears to the surviving daemon bubbles.
        if (nonDaemon.length > 0) return;
        get().patchMessages(sid, agentPath, (prev) =>
          prev.filter((mm) => mm.id.startsWith('daemon-tick-')));
        return;
      }

      // Replay through TurnAccumulator — same callbacks as live SSE.
      const messages: ChatMessage[] = [];
      const replayEffects = makeInMemEffects(messages, newId);
      let replayContextPct = 0;
      const mainCbs = buildMainCallbacks(replayEffects);
      let curPid: string | undefined;
      const acc = new TurnAccumulator({
        ...mainCbs,
        onMessage: (msg) => {
          mainCbs.onMessage?.(msg);
          const ts = msg.timestamp ?? Date.now();
          if (msg.kind === 'assistant_complete') {
            const pid = curPid ?? 'forgeax';
            replayEffects.applyMain((m) => {
              let segs = m.segments ?? [];
              if (msg.thinking?.trim()) segs = appendChatSegment(segs, { kind: 'thinking', ts, text: msg.thinking });
              if (msg.text?.trim()) segs = appendChatSegment(segs, { kind: 'text', ts, text: msg.text });
              return { ...m, segments: segs, providerId: m.providerId ?? pid };
            });
          } else if (msg.kind === 'tool_call') {
            const tc = rendererToolCallToLegacy(msg as ToolCallMessage);
            replayEffects.applyMain((m) => ({ ...m, segments: upsertToolSegment(m.segments ?? [], ts, tc) }));
          }
        },
        onUpdateMessage: (callId, merged) => {
          mainCbs.onUpdateMessage?.(callId, merged);
          if (merged.kind === 'tool_call') {
            const tc = rendererToolCallToLegacy(merged as ToolCallMessage);
            replayEffects.applyMain((m) => ({ ...m, segments: upsertToolSegment(m.segments ?? [], Date.now(), tc) }));
          }
        },
        onMeta: (m) => { if (m.contextPct !== undefined) replayContextPct = m.contextPct; },
        onTurn: (turn) => {
          mainCbs.onTurn?.(turn);
          if (turn.agent && turn.agent !== 'user') replayEffects.sealMain?.();
        },
      }, agentPath);

      const sorted = [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      const knownAssistantIds = new Set<string>();
      let pendingUserAssistantId: string | null = null;
      let openTurnStartedAt: number | null = null;
      let openTurnAssistantId: string | null = null;
      const lastAssistant = (): ChatMessage | undefined => {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.role === 'assistant') return messages[i];
        }
        return undefined;
      };
      for (const ev of sorted) {
        const p = (ev as { type?: string; payload?: { providerId?: unknown } }).payload;
        const pid = p && typeof p.providerId === 'string' && p.providerId ? p.providerId : undefined;
        if (ev.type === 'user_input' || ev.type === 'hook:turnStart') curPid = pid;
        else if (pid) curPid = pid;

        const sourceAgent = typeof ev.source === 'string' && ev.source.startsWith('agent:')
          ? ev.source.slice('agent:'.length)
          : null;
        const eventEmitter = typeof ev.emitterId === 'string' ? ev.emitterId : sourceAgent;
        const ownAgentEvent = eventEmitter === null || eventEmitter === agentPath;
        if (ev.type === 'hook:turnStart' && ownAgentEvent) {
          openTurnStartedAt = ev.ts ?? Date.now();
          openTurnAssistantId = pendingUserAssistantId;
          pendingUserAssistantId = null;
        }

        const assistantBeforeFeed = lastAssistant()?.id ?? null;
        acc.feed(ev);

        const tail = lastAssistant();
        if (ev.type === 'user_input') {
          // Human user_input creates a new assistant skeleton and is a real
          // turn boundary. Inter-agent user_input renders as a system row and
          // must not erase the currently open turn identity.
          if (tail && tail.id !== assistantBeforeFeed) {
            openTurnStartedAt = null;
            openTurnAssistantId = null;
            pendingUserAssistantId = tail.id;
          }
        }
        if (openTurnStartedAt !== null && openTurnAssistantId === null &&
            tail && !knownAssistantIds.has(tail.id)) {
          openTurnAssistantId = tail.id;
        }
        for (const m of messages) {
          if (m.role === 'assistant') knownAssistantIds.add(m.id);
        }
        if (ev.type === 'hook:turnEnd' && ownAgentEvent) {
          openTurnStartedAt = null;
          openTurnAssistantId = null;
        }
      }
      acc.flush();
      if (openTurnStartedAt !== null && openTurnAssistantId !== null) {
        const anchor = `live:${agentPath}:${openTurnStartedAt}`;
        const idx = messages.findIndex((m) => m.id === openTurnAssistantId);
        if (idx >= 0) messages[idx] = { ...messages[idx]!, msgId: anchor };
      }
      finalizeStreamingStatus(messages);

      // Commit to bySid[sid].messagesByAgent[agentPath], preserving live
      // daemon-tick-* bubbles + 带锚的在途流式气泡 (multi-tab §5.3) already in the slot.
      // WAL replay 从未闭合 turnStart 派生同一个 live anchor，因此按身份去重，
      // 不按文本前缀猜测（自动续轮可能与上一条正文相似）。
      set((s) => {
        const conv = s.bySid[sid] ?? EMPTY_CONV;
        const prev = conv.messagesByAgent[agentPath] ?? [];
        const liveDaemonMsgs = prev.filter((mm) => mm.id.startsWith('daemon-tick-'));
        const liveStreaming = prev.filter((mm) =>
          mm.status === 'streaming' && typeof mm.msgId === 'string' && mm.msgId.startsWith('live:'));
        const liveAnchors = new Set(liveStreaming.map((mm) => mm.msgId));
        const walMessages = liveAnchors.size === 0
          ? messages
          : messages.filter((mm) => !mm.msgId || !liveAnchors.has(mm.msgId));
        const keep = [...liveDaemonMsgs, ...liveStreaming];
        const merged = keep.length === 0
          ? walMessages
          : [...walMessages, ...keep].sort((a, b) => a.ts - b.ts);
        return {
          bySid: {
            ...s.bySid,
            [sid]: {
              ...conv,
              messagesByAgent: { ...conv.messagesByAgent, [agentPath]: merged },
              contextPct: replayContextPct > 0 ? replayContextPct : conv.contextPct,
            },
          },
        };
      });

      // 多 tab 同步:回放后把 cursor 回填到「与当前连接同代的最大 seq」,让直播帧
      // 与回放重叠的部分被 seq 闸丢弃(方案 §3.5)。
      try {
        const { currentWsSgen, noteAppliedSeq } = await import('../session-bridge');
        const wsSgen = currentWsSgen(sid);
        if (wsSgen) {
          let maxSeq = 0;
          for (const ev of rawEvents) {
            const evSgen = (ev as { sgen?: unknown }).sgen;
            const evSeq = (ev as { seq?: unknown }).seq;
            if (evSgen === wsSgen && typeof evSeq === 'number' && evSeq > maxSeq) maxSeq = evSeq;
          }
          if (maxSeq > 0) noteAppliedSeq(sid, wsSgen, maxSeq);
        }
      } catch { /* bridge unavailable (tests) — cursor backfill is best-effort */ }
    } catch (e) {
      console.warn('[chat.loadSession] failed', (e as Error).message);
    }
  },

  loadThreadHistory: async (threadId: string) => {
    if (!threadId) return;
    try {
      const { agentId: activeAgentId } = activeTarget();
      const tr = await fetch(`/api/threads/${encodeURIComponent(threadId)}`);
      if (!tr.ok) return;
      const tj = (await tr.json()) as { thread?: { runIds?: string[] } };
      const runIds = tj.thread?.runIds ?? [];
      if (runIds.length === 0) return;

      type RunBuild = {
        meta: {
          id: string; threadId: string; agentId: string; providerId: string;
          status: string; message: string; createdAt: number; lastEventAt: number;
        };
        events: AguiStoredEvent[];
      };
      const builds = new Map<string, RunBuild>();
      const built: ChatMessage[] = [];
      let inFlightRunId: string | null = null;

      for (const runId of runIds) {
        const rr = await fetch(`/api/runs/${encodeURIComponent(runId)}/events?stream=poll`);
        if (!rr.ok) continue;
        const rj = (await rr.json()) as { run?: RunBuild['meta']; events?: AguiStoredEvent[] };
        const meta = rj.run;
        if (!meta) continue;
        const evs = rj.events ?? [];
        builds.set(runId, { meta, events: evs });

        if (meta.message) {
          built.push({
            id: `${runId}-user`, role: 'user', text: meta.message,
            toolCalls: [], status: 'done', ts: meta.createdAt,
          });
        }
        const a = consumeAguiEvents(evs);
        const isLive = meta.status === 'streaming' || meta.status === 'starting';
        if (isLive) inFlightRunId = runId;
        built.push({
          id: `${runId}-asst`, role: 'assistant',
          text: a.text, thinking: a.thinking, toolCalls: a.toolCalls, segments: a.segments,
          status: isLive ? 'streaming' : a.status,
          ts: meta.lastEventAt || meta.createdAt + 1,
          providerId: meta.providerId,
        });
      }
      built.sort((a, b) => a.ts - b.ts);

      // R3: threadId === sid. Commit to the thread's bound agent slot (active
      // agent of this sid). loadThreadHistory only runs for cli-provider sids
      // where one agent owns the thread.
      const slotAgent = activeAgentId ?? builds.values().next().value?.meta.agentId ?? threadId;
      get().patchConv(threadId, { runId: inFlightRunId });
      get().patchMessages(threadId, slotAgent, () => built);

      closeThreadHistoryTails(threadId);
      for (const [runId, b] of builds) {
        if (b.meta.status !== 'streaming' && b.meta.status !== 'starting') continue;
        const lastSeq = b.events.reduce((m, e) => Math.max(m, e.seq ?? -1), -1);
        const url =
          `/api/runs/${encodeURIComponent(runId)}/events?stream=sse` +
          (lastSeq >= 0 ? `&lastEventId=${encodeURIComponent(`${runId}:${lastSeq}`)}` : '');
        const es = new EventSource(url);
        trackTail(threadId, es);

        const onAguiFrame = (raw: MessageEvent<string>): void => {
          try {
            const stored = JSON.parse(raw.data) as AguiStoredEvent;
            b.events.push(stored);
            const a = consumeAguiEvents(b.events);
            const isLive = a.status === 'streaming';
            get().patchMessages(threadId, slotAgent, (msgs) =>
              msgs.map((m) => m.id === `${runId}-asst`
                ? { ...m, text: a.text, thinking: a.thinking, toolCalls: a.toolCalls, segments: a.segments, status: a.status, ts: stored.ts ?? m.ts }
                : m));
            const conv = get().bySid[threadId];
            if (!isLive && conv?.runId === runId) get().patchConv(threadId, { runId: null });
            if (!isLive) {
              try { es.close(); } catch { /* */ }
              untrackTail(threadId, es);
            }
          } catch (e) {
            console.warn('[chat.loadThreadHistory tail] parse failed', (e as Error).message);
          }
        };

        const TAIL_EVENTS = [
          'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR',
          'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CHUNK', 'TEXT_MESSAGE_END',
          'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_CHUNK', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
          'REASONING_START', 'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT',
          'REASONING_MESSAGE_CHUNK', 'REASONING_MESSAGE_END', 'REASONING_END',
          'STEP_STARTED', 'STEP_FINISHED',
        ];
        for (const t of TAIL_EVENTS) es.addEventListener(t, onAguiFrame as EventListener);
        es.addEventListener('message', onAguiFrame as EventListener);
        es.onerror = () => {
          if (es.readyState === EventSource.CLOSED) untrackTail(threadId, es);
        };
      }
    } catch (e) {
      console.warn('[chat.loadThreadHistory] failed', (e as Error).message);
    }
  },

  enqueueMessage: (text) => {
    const t = text.trim();
    if (!t) return;
    const { sid, agentId } = activeTarget();
    if (!sid || !agentId) return;
    const key = `${sid}::${agentId}`;
    const item: QueuedMessage = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: t,
      ts: Date.now(),
    };
    set((s) => ({
      queuedMessages: { ...s.queuedMessages, [key]: [...(s.queuedMessages[key] ?? []), item] },
    }));
  },

  dequeueMessage: (id) => {
    const { sid, agentId } = activeTarget();
    if (!sid || !agentId) return;
    const key = `${sid}::${agentId}`;
    set((s) => {
      const cur = s.queuedMessages[key] ?? [];
      return { queuedMessages: { ...s.queuedMessages, [key]: cur.filter((m) => m.id !== id) } };
    });
  },

  clearQueue: () => {
    const { sid, agentId } = activeTarget();
    if (!sid || !agentId) return;
    const key = `${sid}::${agentId}`;
    set((s) => {
      if (!(key in s.queuedMessages)) return {};
      const next = { ...s.queuedMessages };
      delete next[key];
      return { queuedMessages: next };
    });
  },

  flushQueuedForAgent: (sid, agentId) => {
    const key = `${sid}::${agentId}`;
    const head = get().queuedMessages[key]?.[0];
    if (!head) return;
    // Keep the item until sendMessage validates and accepts the pinned target.
    // Invalid/stale targets therefore leave the queue intact for recovery.
    void get().sendMessage(head.text, {
      target: { sid, agentId },
      onAccepted: () => set((s) => {
        const cur = s.queuedMessages[key] ?? [];
        if (cur[0]?.id !== head.id) return {};
        return { queuedMessages: { ...s.queuedMessages, [key]: cur.slice(1) } };
      }),
    });
  },

  cancelStream: () => {
    const { sid, agentId } = activeTarget();
    if (!sid) return;
    const conv = get().bySid[sid];

    const c = _abortByTab.get(sid);
    if (c) c.controller.abort();

    const runId = conv?.runId ?? null;
    if (runId) {
      fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
        .catch((e) => console.warn('[chat.cancelStream] run cancel POST failed', (e as Error).message));
    }

    const qs = agentId ? `?agent=${encodeURIComponent(agentId)}` : '';
    fetch(`/api/sessions/${encodeURIComponent(sid)}/abort${qs}`, { method: 'POST' })
      .catch((e) => console.warn('[chat.cancelStream] session abort POST failed', (e as Error).message));

    closeThreadHistoryTails(sid);
  },

  clearMessages: () => {
    const { sid, agentId } = activeTarget();
    if (!sid || !agentId) return;
    get().patchMessages(sid, agentId, () => []);
  },

  sendMessage: async (text, opts) => {
    if (!text.trim() && !opts?.attachments?.length) return;
    const trimmed = text.trim() || '(see attached file)';
    // Resolve the agent reply language for THIS turn (follow-input detection or
    // the global quick-switch value). Sent as a field — the server injects a
    // directive into composeTurnRequest's dynamicSuffix, keeping the visible
    // user message clean (no directive leaks into the bubble or replay history).
    const replyLanguage = resolveReplyLanguage(trimmed);
    const target = opts?.target ?? activeTarget();
    const startSid = target.sid;
    if (!startSid) { console.warn('[chat.sendMessage] no active session'); return; }
    const app = useShellStore.getState();
    const startTab = app.tabs.find((tb) => tb.sid === startSid);
    const targetAgent = target.agentId ?? startTab?.agentId ?? null;
    if (opts?.target && (!startTab || startTab.agentId !== targetAgent)) {
      console.warn('[chat.sendMessage] target no longer owns session', opts.target);
      return;
    }
    opts?.onAccepted?.();
    const sysAgent = targetAgent ?? '__none__';
    const pushSys = (txt: string): void =>
      get().patchMessages(startSid, sysAgent, (msgs) => [...msgs, {
        id: newId(), role: 'system', text: txt, toolCalls: [], status: 'done', ts: Date.now(),
      }]);

    // /loop <intervalSec> <prompt> → spawn a long-running daemon whose ticks
    // render as turns in this thread.
    const loopMatch = trimmed.match(/^\/loop\s+(\d+)\s+(.+)$/s);
    if (loopMatch) {
      const intervalSec = Math.max(15, Math.min(3600, Number(loopMatch[1])));
      const inlinePrompt = loopMatch[2].trim();
      const daemonId = `chat-loop-${Date.now().toString(36)}`;
      const payload = {
        id: daemonId, name: `Loop · ${inlinePrompt.slice(0, 32).replace(/\s+/g, ' ')}`,
        inlinePrompt, promptFile: '', cwd: '/tmp', intervalSec, cliProvider: 'claude-code',
        agentPersona: startTab?.agentId ?? undefined, sourceThreadId: startSid, autoStart: true,
      };
      try {
        const r = await fetch('/api/daemons', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        const j = await r.json();
        pushSys(r.ok ? t('store.loop.started', { daemonId, intervalSec }) : t('store.loop.createFailed', { error: j.error ?? r.status }));
      } catch (e) {
        pushSys(t('store.loop.networkError', { message: (e as Error).message }));
      }
      return;
    }

    // /tool <surface> <action> [jsonArgs] — split-surface plugin RPC.
    const toolMatch = trimmed.match(/^\/tool\s+(\S+)\s+(\S+)(?:\s+(.+))?$/s);
    if (toolMatch) {
      const surfaceId = toolMatch[1];
      const action = toolMatch[2];
      const argsRaw = toolMatch[3]?.trim();
      let args: unknown = undefined;
      if (argsRaw) {
        try { args = JSON.parse(argsRaw); }
        catch (e) { pushSys(t('store.tool.invalidJson', { message: (e as Error).message })); return; }
      }
      get().patchMessages(startSid, sysAgent, (msgs) => [...msgs, {
        id: newId(), role: 'user', text: trimmed, toolCalls: [], status: 'done', ts: Date.now(),
      }]);
      try {
        const r = await fetch(`/api/bus/ui/surfaces/${encodeURIComponent(surfaceId)}/dispatch`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, args, awaitAck: true, timeoutMs: 30000 }),
        });
        const j = await r.json();
        pushSys(r.ok && j.ok !== false
          ? `✅ \`${surfaceId}.${action}\` ok\n\n\`\`\`json\n${JSON.stringify(j.result ?? j, null, 2)}\n\`\`\``
          : `❌ \`${surfaceId}.${action}\` failed: ${j.error ?? j.message ?? r.status}`);
      } catch (e) {
        pushSys(t('store.tool.networkError', { message: (e as Error).message }));
      }
      return;
    }

    // /<name> [args] — generic server command dispatch (match on wire text so
    // command pills expand to `/name` before routing).
    const wireText = expandPills(trimmed);
    const cmdMatch = wireText.match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      const cmdName = cmdMatch[1];
      const cmdArgs = cmdMatch[2]?.trim() || '';
      const agentId = startTab?.agentId ?? null;
      const displayText = expandPillsForDisplay(trimmed);
      get().patchMessages(startSid, sysAgent, (msgs) => [...msgs, {
        id: newId(), role: 'user', text: displayText, toolCalls: [], status: 'done', ts: Date.now(),
      }]);
      const pendingId = newId();
      get().patchMessages(startSid, sysAgent, (msgs) => [...msgs, {
        id: pendingId, role: 'system', text: `⏳ /${cmdName} running...`, toolCalls: [], status: 'done', ts: Date.now(),
      }]);
      try {
        const r = await fetch(`/api/commands/${encodeURIComponent(cmdName)}/execute`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ args: cmdArgs ? cmdArgs.split(/\s+/) : [], sessionId: startSid, requestingAgentId: agentId ?? undefined }),
        });
        const j = await r.json();
        const result = j.result;
        const sysText = result?.ok !== false
          ? `✅ /${cmdName} → ${typeof result?.data === 'string' ? result.data : JSON.stringify(result?.data ?? result)}`
          : `❌ /${cmdName}: ${result?.error ?? 'unknown error'}`;
        get().patchMessages(startSid, sysAgent, (msgs) => msgs.map((m) => m.id === pendingId ? { ...m, text: sysText, ts: Date.now() } : m));
      } catch (e) {
        get().patchMessages(startSid, sysAgent, (msgs) => msgs.map((m) => m.id === pendingId ? { ...m, text: t('store.command.networkError', { cmdName, message: (e as Error).message }), ts: Date.now() } : m));
      }
      return;
    }

    // Resolve the chat target — @mention overrides the tab's pinned agent.
    const mentionMatch = trimmed.match(/^@([a-zA-Z][a-zA-Z0-9_-]{0,39})\s+/);
    const mentionedAgent = mentionMatch?.[1];
    const agentId = mentionedAgent ?? targetAgent;
    if (!agentId) { pushSys(t('store.noAgentSelected')); return; }
    const activeAgent = agentId;

    const patchAsst = (mut: (m: ChatMessage) => ChatMessage): void => {
      get().patchMessages(startSid, activeAgent, (msgs) => msgs.map((m) => (m.id === asstMsg.id ? mut(m) : m)));
    };
    const patchSub = (emitterId: string, mut: (r: SubAgentRun) => SubAgentRun): void => {
      get().patchMessages(startSid, activeAgent, (msgs) => msgs.map((m) => {
        if (m.id !== asstMsg.id) return m;
        const subAgents = { ...(m.subAgents ?? {}) };
        const prev: SubAgentRun = subAgents[emitterId] ?? { emitterId, text: '', toolCalls: [], status: 'streaming', startedAt: Date.now() };
        subAgents[emitterId] = mut(prev);
        return { ...m, subAgents };
      }));
    };
    const setStreaming = (val: boolean): void => get().setStreaming(startSid, activeAgent, val);

    // Composer may fold big pastes into paste-pills; expand paste/file pills for
    // display while keeping skill/command pills as tag chips in the transcript.
    const displayText = expandPillsForDisplay(trimmed);

    const displayAttachments = toChatAttachments(opts?.attachments);

    // ── Interrupt-send (steer) ──
    if (opts?.handoff === 'steer') {
      const steerUserMsg: ChatMessage = {
        id: newId(), role: 'user', text: displayText, toolCalls: [], status: 'done', ts: Date.now(),
        ...(displayAttachments ? { attachments: displayAttachments } : {}),
      };
      get().patchMessages(startSid, activeAgent, (msgs) => [...msgs, steerUserMsg]);
      try {
        const { emitForgeaXMessage } = await import('../session-bridge');
        const candidate = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;
        const clientMsgId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        markEmittedClientMsg(clientMsgId);
        const { beginChatTurn } = await import('@forgeax/interface/lib/trace');
        const { traceparent } = beginChatTurn(activeAgent, startSid, useShellStore.getState().providerOverride ?? undefined);
        const r = await emitForgeaXMessage(startSid, wireText, {
          to: candidate,
          payload: { agentId, clientMsgId, traceparent, replyLanguage, ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) },
          handoff: 'steer',
        });
        if (!r.ok) throw new Error(r.error ?? 'emit failed');
      } catch (e) {
        get().patchMessages(startSid, activeAgent, (msgs) => [...msgs, {
          id: newId(), role: 'system', text: t('store.steer.sendFailed', { message: (e as Error).message }), toolCalls: [], status: 'done', ts: Date.now(),
        }]);
      }
      return;
    }

    const userMsg: ChatMessage = {
      id: newId(), role: 'user', text: displayText, toolCalls: [], status: 'done', ts: Date.now(),
      ...(displayAttachments ? { attachments: displayAttachments } : {}),
    };
    const asstMsg: ChatMessage = { id: newId(), role: 'assistant', text: '', toolCalls: [], status: 'streaming', ts: Date.now() };
    const old = _abortByTab.get(startSid);
    if (old) {
      old.controller.abort();
      get().setStreaming(startSid, old.agentId, false);
    }
    const aborter = new AbortController();
    const turnController: TurnController = { controller: aborter, agentId: activeAgent };
    _abortByTab.set(startSid, turnController);
    const signal = aborter.signal;
    const ownsAborter = (): boolean => _abortByTab.get(startSid) === turnController;
    const finishTurn = (): void => {
      if (!ownsAborter()) return;
      _abortByTab.delete(startSid);
      setStreaming(false);
    };

    // Optimistic push into the target agent's slot + auto-title.
    if (startTab && !startTab.displayName) {
      useShellStore.getState().renameTab(startSid, wireText.slice(0, 40).replace(/\s+/g, ' '));
    }
    get().patchMessages(startSid, activeAgent, (msgs) => [...msgs, userMsg, asstMsg]);
    setStreaming(true);

    const turnOverride = startTab?.providerOverride ?? null;

    // R3 provider routing: null/'forgeax' → native EventBus; else cli bridge.
    const isForgeaXNative = turnOverride === null || turnOverride === 'forgeax';
    if (isForgeaXNative) {
      try {
        const { emitForgeaXMessage } = await import('../session-bridge');
        const candidate = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;
        const clientMsgId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        markEmittedClientMsg(clientMsgId);
        const { beginChatTurn } = await import('@forgeax/interface/lib/trace');
        const { traceparent } = beginChatTurn(activeAgent, startSid, useShellStore.getState().providerOverride ?? undefined);
        const r = await emitForgeaXMessage(startSid, wireText, {
          to: candidate,
          payload: { agentId, clientMsgId, traceparent, replyLanguage, ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) },
        });
        if (!r.ok) throw new Error(r.error ?? 'emit failed');
        if (r.msgId) {
          const mid = r.msgId;
          get().patchMessages(startSid, activeAgent, (msgs) => msgs.map((m) => (m.id === userMsg.id ? { ...m, msgId: mid } : m)));
          get().patchConv(startSid, { checkpointMsgIds: { ...(get().bySid[startSid]?.checkpointMsgIds ?? {}), [mid]: true } });
        }
        patchAsst((m) => ({ ...m, providerId: m.providerId ?? 'forgeax' }));
      } catch (err) {
        patchAsst((m) => ({ ...m, status: 'error', errorMessage: `forgeax emit failed: ${(err as Error).message}` }));
        finishTurn();
      }
      if (ownsAborter()) _abortByTab.delete(startSid);
      return;
    }

    let res: Response;
    // R1-b 对偶(多 tab 同步 §5.4):cli 桥会把 token 广播成 stream:llm,发起 turn 的
    // 本 tab 已经在从 SSE 渲染同一份文本 —— 标记存续期,session-stream 丢 WS 那份。
    markCliSseActive(startSid, activeAgent);
    try {
      res = await fetch('/api/cli/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: wireText, agentId, threadId: startSid, sessionId: startSid, replyLanguage, ...(turnOverride ? { providerOverride: turnOverride } : {}), ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) }),
        signal,
      });
    } catch (e) {
      clearCliSseActive(startSid, activeAgent);
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        patchAsst((m) => (m.status === 'streaming' ? { ...m, status: 'done' } : m));
      } else {
        patchAsst((m) => ({ ...m, status: 'error', errorMessage: `network error: ${(e as Error).message}` }));
      }
      finishTurn(); return;
    }
    if (!res.ok) {
      clearCliSseActive(startSid, activeAgent);
      let body: { error?: string; hint?: string } = {};
      try { body = await res.json(); } catch { /* ignore */ }
      patchAsst((m) => ({ ...m, status: 'error', errorMessage: body.error ? `${res.status} ${body.error}${body.hint ? ` — ${body.hint}` : ''}` : `HTTP ${res.status}` }));
      finishTurn(); return;
    }
    if (!res.body) {
      clearCliSseActive(startSid, activeAgent);
      patchAsst((m) => ({ ...m, status: 'error', errorMessage: 'empty response body' }));
      finishTurn(); return;
    }

    const isMain = (eid: unknown): boolean => !eid || eid === agentId || (agentId === 'forgeax' && eid === 'admin');
    const liveEffects: MessageEffects = { applyMain: patchAsst, applySub: patchSub };
    const mainAcc = new TurnAccumulator(buildMainCallbacks(liveEffects), agentId);
    const subAccs = new Map<string, TurnAccumulator>();
    const getSubAcc = (eid: string): TurnAccumulator => {
      const existing = subAccs.get(eid);
      if (existing) return existing;
      const acc = new TurnAccumulator(buildSubCallbacks(eid, liveEffects), eid);
      subAccs.set(eid, acc);
      return acc;
    };

    let lastSeenProviderId: string | undefined;
    let mainProviderIdCommitted = false;
    const subProviderIdCommitted = new Set<string>();

    const sseDeltaBuf = new Map<string, { callId: string; name: string; accumulated: string; mainEvent: boolean; emitterId: string | null }>();
    let sseLastFlush = 0;
    const SSE_DELTA_INTERVAL = 32;
    const flushSseDeltaBuf = (): void => {
      if (sseDeltaBuf.size === 0) return;
      const batch = [...sseDeltaBuf.values()];
      sseDeltaBuf.clear();
      sseLastFlush = Date.now();
      for (const pd of batch) {
        const applyDelta = (tc: ToolCall): ToolCall => {
          if (tc.callId !== pd.callId) return tc;
          const prev = typeof tc.args === 'string' ? tc.args : '';
          return { ...tc, args: prev + pd.accumulated, status: 'running' };
        };
        if (pd.mainEvent) {
          patchAsst((m) => {
            const existing = m.toolCalls.find((tc) => tc.callId === pd.callId);
            if (existing) {
              const toolCalls = m.toolCalls.map(applyDelta);
              const segments = (m.segments ?? []).map((s) => s.kind === 'tool' && s.tool.callId === pd.callId ? { ...s, tool: applyDelta(s.tool) } : s);
              return { ...m, toolCalls, segments };
            }
            const tc: ToolCall = { callId: pd.callId, name: pd.name, args: pd.accumulated, status: 'running' };
            return { ...m, toolCalls: [...m.toolCalls, { ...tc, at: m.text.length }], segments: upsertToolSegment(m.segments ?? [], Date.now(), tc) };
          });
        } else if (pd.emitterId) {
          patchSub(pd.emitterId, (r) => ({ ...r, toolCalls: r.toolCalls.map(applyDelta) }));
        }
      }
    };
    const sseTextBuf = new Map<string, { mainEvent: boolean; emitterId: string | null; chunks: Array<{ kind: 'text' | 'thinking'; text: string }>; providerId?: string }>();
    let sseTextLastFlush = 0;
    const flushSseTextBuf = (): void => {
      if (sseTextBuf.size === 0) return;
      const batch = [...sseTextBuf.values()];
      sseTextBuf.clear();
      sseTextLastFlush = Date.now();
      for (const b of batch) {
        const ts = Date.now();
        if (b.mainEvent) {
          patchAsst((m) => {
            let segments = m.segments ?? [];
            let text = m.text;
            let thinking = m.thinking ?? '';
            for (const ch of b.chunks) {
              if (ch.kind === 'text') text += ch.text; else thinking += ch.text;
              segments = appendChatSegment(segments, { kind: ch.kind, ts, text: ch.text });
            }
            return { ...m, text, thinking, segments, providerId: m.providerId ?? b.providerId };
          });
        } else if (b.emitterId) {
          patchSub(b.emitterId, (r) => {
            let text = r.text;
            let thinking = r.thinking ?? '';
            for (const ch of b.chunks) { if (ch.kind === 'text') text += ch.text; else thinking += ch.text; }
            return { ...r, text, thinking, providerId: r.providerId ?? b.providerId };
          });
        }
      }
    };
    const bufText = (mainEvent: boolean, emitterId: string | null, kind: 'text' | 'thinking', text: string, providerId?: string): void => {
      const key = emitterId ?? '__main__';
      let b = sseTextBuf.get(key);
      if (!b) { b = { mainEvent, emitterId, chunks: [], providerId }; sseTextBuf.set(key, b); }
      b.chunks.push({ kind, text });
      if (providerId && !b.providerId) b.providerId = providerId;
    };

    try {
      for await (const frame of parseSse(res.body)) {
        if (!frame.data) continue;
        if (frame.event !== 'agent-start' && frame.event !== 'stored-event' && frame.event !== 'token' && frame.event !== 'thinking' && frame.event !== 'tool-call' && frame.event !== 'tool-call-delta' && frame.event !== 'tool-result' && frame.event !== 'done' && frame.event !== 'error') continue;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(frame.data); } catch { continue; }
        const emitterId = payload.emitterId as string | undefined;
        const providerId = payload.providerId as string | undefined;
        if (providerId) {
          if (isMain(emitterId)) {
            lastSeenProviderId = providerId;
            if (!mainProviderIdCommitted) { mainProviderIdCommitted = true; patchAsst((m) => (m.providerId ? m : { ...m, providerId })); }
          } else if (emitterId && !subProviderIdCommitted.has(emitterId)) {
            subProviderIdCommitted.add(emitterId);
            patchSub(emitterId, (r) => (r.providerId ? r : { ...r, providerId }));
          }
        }
        const sentRunId = typeof payload.runId === 'string' ? payload.runId : null;
        if (sentRunId && get().bySid[startSid]?.runId !== sentRunId) get().patchConv(startSid, { runId: sentRunId });
        if (frame.event === 'agent-start') continue;
        if (frame.event === 'token' || frame.event === 'thinking' || frame.event === 'tool-call' || frame.event === 'tool-call-delta' || frame.event === 'tool-result' || frame.event === 'done' || frame.event === 'error') {
          const mainEvent = isMain(emitterId);
          const nowTs = Date.now();
          if (frame.event !== 'token' && frame.event !== 'thinking') flushSseTextBuf();
          if (frame.event === 'token') {
            const text = String(payload.text ?? '');
            if (text) { bufText(mainEvent, emitterId ?? null, 'text', text, providerId); if (nowTs - sseTextLastFlush >= SSE_DELTA_INTERVAL) flushSseTextBuf(); }
          } else if (frame.event === 'thinking') {
            const text = String(payload.text ?? '');
            if (text) { bufText(mainEvent, emitterId ?? null, 'thinking', text, providerId); if (nowTs - sseTextLastFlush >= SSE_DELTA_INTERVAL) flushSseTextBuf(); }
          } else if (frame.event === 'tool-call') {
            const callId = String(payload.callId ?? '');
            if (callId) {
              const tc: ToolCall = { callId, name: String(payload.name ?? 'tool'), args: payload.args ?? {}, status: 'running' };
              if (mainEvent) patchAsst((m) => ({ ...m, toolCalls: [...m.toolCalls, { ...tc, at: m.text.length }], segments: upsertToolSegment(m.segments ?? [], nowTs, tc) }));
              else if (emitterId) patchSub(emitterId, (r) => ({ ...r, toolCalls: [...r.toolCalls, tc] }));
            }
          } else if (frame.event === 'tool-call-delta') {
            const callId = String(payload.callId ?? '');
            const delta = typeof payload.argumentsDelta === 'string' ? payload.argumentsDelta : '';
            if (callId && delta) {
              const prev = sseDeltaBuf.get(callId);
              if (prev) prev.accumulated += delta;
              else sseDeltaBuf.set(callId, { callId, name: String(payload.name ?? 'tool'), accumulated: delta, mainEvent, emitterId: emitterId ?? null });
              if (Date.now() - sseLastFlush >= SSE_DELTA_INTERVAL) flushSseDeltaBuf();
            }
          } else if (frame.event === 'tool-result') {
            flushSseDeltaBuf();
            const callId = String(payload.callId ?? '');
            const ok = payload.ok !== false;
            const result = typeof payload.result === 'string' ? payload.result : undefined;
            const error = typeof payload.error === 'string' ? payload.error : undefined;
            const apply = (tc: ToolCall): ToolCall => tc.callId !== callId ? tc : { ...tc, status: ok ? 'done' : 'error', result, error };
            if (mainEvent) patchAsst((m) => ({ ...m, toolCalls: m.toolCalls.map(apply), segments: (m.segments ?? []).map((s) => s.kind === 'tool' && s.tool.callId === callId ? { ...s, tool: apply(s.tool) } : s) }));
            else if (emitterId) patchSub(emitterId, (r) => ({ ...r, toolCalls: r.toolCalls.map(apply) }));
          } else if (frame.event === 'error') {
            flushSseDeltaBuf();
            const msg = String(payload.message ?? payload.error ?? 'stream error');
            if (mainEvent) patchAsst((m) => ({ ...m, status: 'error', errorMessage: msg }));
            else if (emitterId) patchSub(emitterId, (r) => ({ ...r, status: 'error', errorMessage: msg } as SubAgentRun));
          } else if (frame.event === 'done') {
            flushSseDeltaBuf();
          }
          continue;
        }
        const stored = payload as unknown as StoredEvent;
        const eid = stored.emitterId ?? '';
        const acc = isMain(eid) ? mainAcc : getSubAcc(eid);
        acc.feed(stored);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError' || signal.aborted) {
        patchAsst((m) => ({ ...m, status: 'done', providerId: m.providerId ?? lastSeenProviderId ?? turnOverride ?? undefined }));
      } else {
        patchAsst((m) => ({ ...m, status: 'error', errorMessage: `stream error: ${(e as Error).message}` }));
      }
    } finally {
      clearCliSseActive(startSid, activeAgent);
      flushSseTextBuf();
      flushSseDeltaBuf();
      mainAcc.flush();
      for (const acc of subAccs.values()) acc.flush();
      patchAsst((m) => (m.status === 'streaming' ? { ...m, status: 'done' } : m));
      for (const eid of subAccs.keys()) patchSub(eid, (r) => (r.status === 'streaming' ? { ...r, status: 'done' } : r));
      finishTurn();
    }
  },

  // ── checkpoint rewind ──
  loadCheckpoints: async (sid) => {
    if (!sid) return;
    try {
      const { fetchCheckpoints } = await import('@forgeax/interface/lib/checkpoint-api');
      const { checkpoints, pending } = await fetchCheckpoints(sid);
      const checkpointMsgIds: Record<string, boolean> = {};
      for (const c of checkpoints) checkpointMsgIds[c.msgId] = c.hasCode;
      get().patchConv(sid, {
        checkpointMsgIds,
        pendingRewind: pending
          ? { boundaryId: pending.boundaryId, targetMsgId: pending.targetMsgId, mode: pending.mode, keptDirty: pending.keptDirty, overwrite: pending.overwrite ? { files: pending.overwrite.files } : null }
          : null,
      });
    } catch (e) {
      console.warn('[chat.loadCheckpoints] failed', (e as Error).message);
    }
  },
  performRewind: async (sid, msgId, mode) => {
    const { rewindTo } = await import('@forgeax/interface/lib/checkpoint-api');
    await rewindTo(sid, msgId, mode);
  },
  performRewindCancel: async (sid) => {
    const boundaryId = get().bySid[sid]?.pendingRewind?.boundaryId;
    if (!boundaryId) { get().patchConv(sid, { pendingRewind: null }); return; }
    const { rewindCancel } = await import('@forgeax/interface/lib/checkpoint-api');
    try {
      await rewindCancel(sid, boundaryId);
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      if (/\b409\b/.test(msg) || /not pending|finalized|cancelled/i.test(msg)) {
        get().patchConv(sid, { pendingRewind: null });
        void get().loadCheckpoints(sid);
        return;
      }
      throw e;
    }
  },
  performOverwriteDirty: async (sid) => {
    const conv = get().bySid[sid];
    const boundaryId = conv?.rewindDirtyNotice?.boundaryId ?? conv?.pendingRewind?.boundaryId;
    if (!boundaryId) return;
    const { rewindOverwriteDirty } = await import('@forgeax/interface/lib/checkpoint-api');
    await rewindOverwriteDirty(sid, boundaryId);
  },
  performUndoOverwrite: async (sid) => {
    const conv = get().bySid[sid];
    const boundaryId = conv?.rewindDirtyNotice?.boundaryId ?? conv?.pendingRewind?.boundaryId;
    if (!boundaryId) return;
    const { rewindUndoOverwrite } = await import('@forgeax/interface/lib/checkpoint-api');
    await rewindUndoOverwrite(sid, boundaryId);
  },
  applyRewindEvent: (sid, kind, payload) => {
    const conv = get().bySid[sid];
    if (!conv) return;
    const agentId = useShellStore.getState().tabs.find((tb) => tb.sid === sid)?.agentId ?? null;
    if (kind === 'done') {
      const msgId = String(payload.msgId ?? '');
      if (msgId && agentId) {
        const cur = conv.messagesByAgent[agentId];
        if (Array.isArray(cur) && cur.length > 0 && !cur.some((m) => m.msgId === msgId)) return;
      }
      const mode = (payload.mode === 'code' || payload.mode === 'conversation' ? payload.mode : 'both') as 'both' | 'conversation' | 'code';
      const boundaryId = String(payload.boundaryId ?? '');
      const keptDirty = Array.isArray(payload.keptDirty) ? (payload.keptDirty as string[]) : [];
      get().patchConv(sid, {
        pendingRewind: { boundaryId, targetMsgId: msgId, mode, keptDirty, overwrite: null },
        rewindDirtyNotice: keptDirty.length > 0 ? { boundaryId, keptDirty, overwrite: null } : null,
      });
    } else if (kind === 'cancelled') {
      const boundaryId = String(payload.boundaryId ?? '');
      const keptDirty = Array.isArray(payload.keptDirty) ? (payload.keptDirty as string[]) : [];
      get().patchConv(sid, { pendingRewind: null, rewindDirtyNotice: keptDirty.length > 0 ? { boundaryId, keptDirty, overwrite: null } : null });
    } else if (kind === 'finalized') {
      const pr = conv.pendingRewind;
      const targetMsgId = String(payload.targetMsgId ?? pr?.targetMsgId ?? '');
      const pm = payload.mode;
      const finMode: 'both' | 'conversation' | 'code' = pm === 'code' || pm === 'conversation' || pm === 'both' ? pm : (pr?.mode ?? 'both');
      get().patchConv(sid, { pendingRewind: null, rewindDirtyNotice: null });
      if (targetMsgId && finMode !== 'code' && agentId) {
        get().patchMessages(sid, agentId, (msgs) => {
          const targetIdx = msgs.findIndex((m) => m.msgId === targetMsgId);
          if (targetIdx < 0) return msgs;
          let lastUserIdx = -1;
          for (let i = msgs.length - 1; i > targetIdx; i--) { if (msgs[i].role === 'user') { lastUserIdx = i; break; } }
          const cutEnd = lastUserIdx > targetIdx ? lastUserIdx : msgs.length;
          return [...msgs.slice(0, targetIdx), ...msgs.slice(cutEnd)];
        });
      }
    } else if (kind === 'overwrite') {
      const files = Array.isArray(payload.files) ? (payload.files as string[]) : [];
      const boundaryId = String(payload.boundaryId ?? '');
      get().patchConv(sid, {
        rewindDirtyNotice: { boundaryId, keptDirty: [], overwrite: { files } },
        ...(conv.pendingRewind ? { pendingRewind: { ...conv.pendingRewind, keptDirty: [], overwrite: { files } } } : {}),
      });
    } else if (kind === 'overwrite-undone') {
      const files = Array.isArray(payload.files) ? (payload.files as string[]) : [];
      const boundaryId = String(payload.boundaryId ?? '');
      get().patchConv(sid, {
        rewindDirtyNotice: { boundaryId, keptDirty: files, overwrite: null },
        ...(conv.pendingRewind ? { pendingRewind: { ...conv.pendingRewind, keptDirty: files, overwrite: null } } : {}),
      });
    }
  },
}));

// ── convenience selector hooks (resolve the active (sid, agentId) target) ────
// Components read the visible thread by composing L1's registry (which sid /
// agent is active) with this store's per-(sid,agentId) buckets.

function useActiveSid(): string | null {
  return useShellStore((s) => s.activeSid);
}
function useActiveAgentId(): string | null {
  return useShellStore((s) => (s.activeSid ? s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null : null));
}

/** The visible message thread for the active (sid, agentId). */
export function useActiveMessages(): ChatMessage[] {
  const sid = useActiveSid();
  const agentId = useActiveAgentId();
  return useChatStore((s) => (sid && agentId ? (s.bySid[sid]?.messagesByAgent[agentId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES));
}
/** Streaming flag for the active (sid, agentId).
 *  OR L1 busyByAgentBySid —— boot 时 `_syncActiveAgentRunning` 从 list_agents.running
 *  写入,避免刷新后错过 turnStart/snapshot 时 Send 误亮。 */
export function useActiveStreaming(): boolean {
  const sid = useActiveSid();
  const agentId = useActiveAgentId();
  const chatBusy = useChatStore((s) =>
    sid && agentId ? Boolean(s.bySid[sid]?.streamingByAgent[agentId]) : false);
  const shellBusy = useShellStore((s) =>
    sid && agentId ? Boolean(s.busyByAgentBySid[sid]?.[agentId]) : false);
  return Boolean(chatBusy || shellBusy);
}
export function useActiveContextPct(): number {
  const sid = useActiveSid();
  return useChatStore((s) => (sid ? s.bySid[sid]?.contextPct ?? 0 : 0));
}
export function useActivePendingRewind(): PendingRewind | null {
  const sid = useActiveSid();
  return useChatStore((s) => (sid ? s.bySid[sid]?.pendingRewind ?? null : null));
}
export function useActiveRewindDirtyNotice(): RewindDirtyNotice | null {
  const sid = useActiveSid();
  return useChatStore((s) => (sid ? s.bySid[sid]?.rewindDirtyNotice ?? null : null));
}
export function useActiveCheckpointMsgIds(): Record<string, boolean> | undefined {
  const sid = useActiveSid();
  return useChatStore((s) => (sid ? s.bySid[sid]?.checkpointMsgIds : undefined));
}
const EMPTY_STREAMING: Record<string, boolean> = {};
let mergedChatFlagsRef: Record<string, boolean> = EMPTY_STREAMING;
let mergedShellFlagsRef: Record<string, boolean> = EMPTY_STREAMING;
let mergedStreamingFlags: Record<string, boolean> = EMPTY_STREAMING;

function mergeStreamingByAgent(
  chatFlags: Record<string, boolean>,
  shellFlags: Record<string, boolean>,
): Record<string, boolean> {
  if (chatFlags === mergedChatFlagsRef && shellFlags === mergedShellFlagsRef) {
    return mergedStreamingFlags;
  }
  mergedChatFlagsRef = chatFlags;
  mergedShellFlagsRef = shellFlags;
  const keys = new Set([...Object.keys(chatFlags), ...Object.keys(shellFlags)]);
  if (keys.size === 0) {
    mergedStreamingFlags = EMPTY_STREAMING;
    return mergedStreamingFlags;
  }
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    if (chatFlags[k] || shellFlags[k]) out[k] = true;
  }
  mergedStreamingFlags = out;
  return mergedStreamingFlags;
}

/** Per-agent streaming flags for the active session (ChatAgentCapsule). */
export function useActiveStreamingByAgent(): Record<string, boolean> {
  const sid = useActiveSid();
  const chatFlags = useChatStore((s) => (sid ? s.bySid[sid]?.streamingByAgent ?? EMPTY_STREAMING : EMPTY_STREAMING));
  const shellFlags = useShellStore((s) => (sid ? s.busyByAgentBySid[sid] ?? EMPTY_STREAMING : EMPTY_STREAMING));
  return mergeStreamingByAgent(chatFlags, shellFlags);
}

// ── user_input dedupe (sendMessage emits → session-stream skips the echo) ────
const _emittedClientMsgIds: string[] = [];
const _EMITTED_LRU_MAX = 64;
export function markEmittedClientMsg(clientMsgId: string): void {
  _emittedClientMsgIds.push(clientMsgId);
  if (_emittedClientMsgIds.length > _EMITTED_LRU_MAX) _emittedClientMsgIds.shift();
}
export function isOwnUserInput(clientMsgId: string | undefined): boolean {
  if (!clientMsgId) return false;
  return _emittedClientMsgIds.includes(clientMsgId);
}

// ── cli-SSE turn dedupe (sendMessage cli 路径 → session-stream 丢 WS 副本) ────
// cli 桥把 token 广播成 stream:llm(多 tab 同步 R1-b)后,发起 turn 的 tab 会同时
// 从自己的 /api/cli/chat SSE 和 WS 收到同一份文本;SSE 存续期间置此标志,
// session-stream 对该 (sid, agent) 丢弃 WS 的 text/thinking 与收口 reconcile。
const _cliSseTurns = new Map<string, number>();
export function markCliSseActive(sid: string, agentId: string): void {
  const key = `${sid}::${agentId}`;
  _cliSseTurns.set(key, (_cliSseTurns.get(key) ?? 0) + 1);
}
export function clearCliSseActive(sid: string, agentId: string): void {
  const key = `${sid}::${agentId}`;
  const remaining = (_cliSseTurns.get(key) ?? 0) - 1;
  if (remaining > 0) _cliSseTurns.set(key, remaining);
  else _cliSseTurns.delete(key);
}
export function isCliSseTurnActive(sid: string, agentId: string): boolean {
  return (_cliSseTurns.get(`${sid}::${agentId}`) ?? 0) > 0;
}

// ── registry GC: when L1 drops a session tab, tear down its chat-side state ──
let _prevSids: string[] = [];
useShellStore.subscribe((s) => {
  const sids = s.tabs.map((tb) => tb.sid);
  if (sids.length === _prevSids.length && sids.every((x, i) => x === _prevSids[i])) return;
  const removed = _prevSids.filter((sid) => !sids.includes(sid));
  _prevSids = sids;
  if (removed.length === 0) return;
  for (const sid of removed) {
    const c = _abortByTab.get(sid);
    if (c) c.controller.abort();
    closeThreadHistoryTails(sid);
    useChatStore.setState((cs) => {
      if (!(sid in cs.bySid)) {
        const queuedMessages = Object.fromEntries(Object.entries(cs.queuedMessages).filter(([k]) => k.split('::')[0] !== sid));
        return { queuedMessages };
      }
      const { [sid]: _drop, ...bySid } = cs.bySid;
      const queuedMessages = Object.fromEntries(Object.entries(cs.queuedMessages).filter(([k]) => k.split('::')[0] !== sid));
      return { bySid, queuedMessages };
    });
  }
});

/** Internal accessors shared with the (soon-to-move) session-stream + sendMessage
 *  modules in this package. Not part of the public surface. */
export const _chatInternals = {
  abortByTab: _abortByTab,
  trackTail,
  untrackTail,
  closeThreadHistoryTails,
  newId,
  consumeAguiEvents,
  fetchSessionEventsNdjson,
};
