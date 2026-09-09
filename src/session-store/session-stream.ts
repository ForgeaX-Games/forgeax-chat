/** SessionEvent → ChatMessage 桥（forgeax 原生 WS 实时流）— chat-owned (R4).
 *
 *  Subscribes to `forgeax-bridge.onSessionEvent` and translates server EventBus
 *  events into patches on the chat conversation store (`useChatStore`). Message
 *  content (segments / toolCalls / thinking / streaming flags / contextPct /
 *  rewind state) is chat-private and lives in `useChatStore`. Registry-runtime
 *  facts the event also carries — live agent tree (`setLiveAgents`) and the
 *  file-activity ledger (`pushFileTouch` / `updateFileTouchStatus`) — stay in
 *  Interface's `useShellStore`; this module writes both stores from one dispatch.
 *
 *  Moved out of `@forgeax/interface/src/lib` when message ownership moved to Chat:
 *  the event→message translator had to follow because Interface may not import Chat.
 */
import {
  useShellStore,
  type ChatMessage,
  type SystemDirection,
  type SystemLevel,
  type ToolCall,
} from '@forgeax/interface/store';
import {
  onSessionEvent,
  onTurnSnapshot,
  onResumeGap,
  gateSessionEvent,
  noteAppliedSeq,
  releaseGapBuffer,
  type SessionEvent,
  type TurnSnapshotFrame,
} from '../session-bridge';
import { ratioFromUsage } from '../event-engine/turn-accumulator';
import { formatCompactionStatus } from '../event-engine/compaction-status';
import { isChatMessageEvent } from '../event-engine/chat-visibility';
import { mergeToolResult } from '../event-engine/tool-result';
import { inferToolNameFromResult, normalizeHookToolCall } from '../event-engine/event-formatter';
import { normalizeToolCall } from '../event-engine/tool-name';
import { hasPendingAskUser } from '../task-flow/ask-user-protocol';
import { chatFirstToken, chatToolResult, chatTurnEnd } from '@forgeax/interface/lib/trace';
import { reportPassiveFeedbackSignal } from '@forgeax/interface/lib/passive-feedback';
import { t } from '@/i18n';
import type { ArtifactResolvedPayload, ArtifactSummary } from '@forgeax/types/artifact-summary';
import {
  appendChatSegment,
  isAgentStreamSuppressed,
  isOwnUserInput,
  isCliSseTurnActive,
  upsertToolSegment,
  useChatStore,
} from './store';

// ─── server event payload shapes ─────────────────────────────────────────

interface StreamLlmPayload {
  chunk?: {
    type: 'text' | 'thinking' | 'tool_call' | 'tool_call_delta' | 'provider_sidecar' | 'usage';
    text?: string;
    id?: string;
    name?: string;
    arguments?: string;
    arguments_delta?: string;
    visibility?: 'public_summary' | 'private_reasoning';
  };
  turn?: number;
}

interface HookToolCallPayload {
  name?: string;
  args?: Record<string, unknown>;
  toolCall?: { id?: string; name?: string };
  permissionPrompt?: boolean;
}

interface HookToolResultPayload {
  name?: string;
  durationMs?: number;
  error?: string;
  result?: unknown;
  callId?: string;
}

interface HookTurnEndPayload {
  turn?: number;
  turnId?: string;
  aborted?: boolean;
  error?: string;
  durationMs?: number;
  waitingForInput?: boolean;
}

interface UserInputPayload {
  content?: string;
  clientMsgId?: string;
}

// ─── file-touch extraction from tool calls ──────────────────────────────
export const FILE_TOOL_PATH_KEY: Record<string, string> = {
  read_file: 'file_path',
  write_file: 'file_path',
  edit_file: 'file_path',
  notebook_edit: 'notebook_path',
  delete_file: 'file_path',
  rename_file: 'to',
  move_file: 'to',
  apply_patch: 'path',
};

function extractFileTouch(
  sid: string,
  agentPath: string,
  callId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  ts: number,
): void {
  if (!args) return;
  const pathKey = FILE_TOOL_PATH_KEY[toolName];
  if (pathKey) {
    const filePath = args[pathKey];
    if (typeof filePath === 'string' && filePath) {
      const name = filePath.split('/').pop() ?? filePath;
      const op = toolName === 'read_file' ? 'read' : toolName === 'edit_file' ? 'edit' : toolName === 'apply_patch' ? 'patch' : 'write';
      useShellStore.getState().pushFileTouch(sid, agentPath, { callId, path: filePath, name, op, ts, status: 'running' });
    }
    return;
  }
  if (toolName === 'multi_edit') {
    const edits = args.edits;
    if (Array.isArray(edits)) {
      for (const e of edits as Array<{ file_path?: string }>) {
        if (typeof e.file_path === 'string' && e.file_path) {
          const name = e.file_path.split('/').pop() ?? e.file_path;
          useShellStore.getState().pushFileTouch(sid, agentPath, { callId, path: e.file_path, name, op: 'edit', ts, status: 'running' });
        }
      }
    }
  }
}

// ─── tool_call_delta throttle ────────────────────────────────────────────

interface PendingDelta {
  sid: string;
  agentId: string;
  msgId: string;
  callId: string;
  name: string;
  accumulated: string;
}

const pendingDeltas = new Map<string, PendingDelta>();
let deltaRafId: number | null = null;

function flushPendingDeltas(): void {
  deltaRafId = null;
  if (pendingDeltas.size === 0) return;
  const batch = [...pendingDeltas.values()];
  pendingDeltas.clear();
  useChatStore.getState().batchPatchMessages(batch.map((pd) => ({
    sid: pd.sid,
    agentId: pd.agentId,
    updater: (messages) => patchMessageInList(messages, pd.msgId, (m) => {
      const existing = m.toolCalls.find((tc) => tc.callId === pd.callId);
      if (existing) {
        if (typeof existing.args !== 'string' || existing.status !== 'running') return m;
        const updatedRaw = existing.args + pd.accumulated;
        const updatedTc: ToolCall = { ...existing, args: updatedRaw, status: 'running' };
        return {
          ...m,
          toolCalls: m.toolCalls.map((tc) => (tc.callId === pd.callId ? updatedTc : tc)),
          segments: upsertToolSegment(m.segments ?? [], m.ts ?? Date.now(), updatedTc),
          status: 'streaming',
        };
      }
      const tc: ToolCall = { callId: pd.callId, name: pd.name, args: pd.accumulated, status: 'running' };
      return {
        ...m,
        toolCalls: [...m.toolCalls, { ...tc, at: m.text.length }],
        segments: upsertToolSegment(m.segments ?? [], m.ts ?? Date.now(), tc),
        status: 'streaming',
      };
    }),
  })));
}

function enqueueDelta(sid: string, agentId: string, msgId: string, callId: string, name: string, delta: string): void {
  const key = `${sid}:${callId}`;
  const existing = pendingDeltas.get(key);
  if (existing) existing.accumulated += delta;
  else pendingDeltas.set(key, { sid, agentId, msgId, callId, name, accumulated: delta });
  if (deltaRafId === null) deltaRafId = requestAnimationFrame(flushPendingDeltas);
}

function dropPendingDelta(sid: string, callId: string): void {
  pendingDeltas.delete(`${sid}:${callId}`);
}

// ─── stream text/thinking micro-batch ────────────────────────────────────
// forgeax-core 原生路径的 text chunk 是真 token 级(实测 p50 间隔 13ms、每块 ~2 字符);
// 逐条 patch 会让每个 chunk 都触发一次 store 更新 + Markdown 全量重渲染,主线程被打满,
// 观感反而"一坨一坨"。与 tool_call_delta 同款 rAF 合帧:一帧内的 chunk 合成一次 patch。
// 顺序敏感事件(tool_call 的 at 锚点 / turnEnd 收口等)到达时由 dispatch 顶部同步冲刷保序。

interface PendingStreamText {
  sid: string;
  agentId: string;
  msgId: string;
  chunks: Array<{ kind: 'text' | 'thinking'; ts: number; text: string; visibility?: 'public_summary' | 'private_reasoning' }>;
}

const pendingStreamText = new Map<string, PendingStreamText>();
let streamTextRafId: number | null = null;

function flushPendingStreamText(): void {
  if (streamTextRafId !== null) {
    cancelAnimationFrame(streamTextRafId);
    streamTextRafId = null;
  }
  if (pendingStreamText.size === 0) return;
  const batch = [...pendingStreamText.values()];
  pendingStreamText.clear();
  useChatStore.getState().batchPatchMessages(batch.map((p) => ({
    sid: p.sid,
    agentId: p.agentId,
    updater: (messages) => patchMessageInList(messages, p.msgId, (m) => {
      let text = m.text;
      let thinking = m.thinking ?? '';
      let segments = m.segments ?? [];
      for (const ch of p.chunks) {
        if (ch.kind === 'text') text += ch.text;
        else thinking += ch.text;
        segments = appendChatSegment(segments, {
          kind: ch.kind,
          ts: ch.ts,
          text: ch.text,
          ...(ch.visibility ? { visibility: ch.visibility } : {}),
        });
      }
      return { ...m, text, ...(thinking ? { thinking } : {}), segments, status: 'streaming' };
    }),
  })));
}

function enqueueStreamText(
  sid: string,
  agentId: string,
  msgId: string,
  kind: 'text' | 'thinking',
  ts: number,
  text: string,
  visibility?: 'public_summary' | 'private_reasoning',
): void {
  const key = `${sid}:${agentId}:${msgId}`;
  const p = pendingStreamText.get(key);
  if (p) p.chunks.push({ kind, ts, text, ...(visibility ? { visibility } : {}) });
  else pendingStreamText.set(key, { sid, agentId, msgId, chunks: [{ kind, ts, text, ...(visibility ? { visibility } : {}) }] });
  if (streamTextRafId === null) streamTextRafId = requestAnimationFrame(flushPendingStreamText);
}

// ─── helpers ─────────────────────────────────────────────────────────────

function findStreamingAsst(
  sid: string,
  agentId: string | null | undefined,
): { sid: string; agentId: string; msg: ChatMessage } | null {
  if (!agentId) return null;
  const msgs = useChatStore.getState().readMessages(sid, agentId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.status === 'streaming') return { sid, agentId, msg: m };
  }
  return null;
}

function findLatestAsst(
  sid: string,
  agentId: string | null | undefined,
  turnId?: string,
): ChatMessage | null {
  if (!agentId) return null;
  const msgs = useChatStore.getState().readMessages(sid, agentId);
  if (turnId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const message = msgs[i];
      if (message?.role === 'assistant' && message.turnId === turnId) return message;
    }
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'assistant') return msgs[i]!;
  }
  return null;
}

function artifactFromPayload(payload: Record<string, unknown>): ArtifactSummary | null {
  const wire = payload as unknown as Partial<ArtifactResolvedPayload>;
  if (wire.schemaVersion !== undefined && wire.schemaVersion !== 1) return null;
  const resolution = payload.resolution && typeof payload.resolution === 'object'
    ? payload.resolution as Record<string, unknown>
    : null;
  if (!resolution || (resolution.kind !== 'summary' && resolution.kind !== 'unavailable') || !resolution.summary || typeof resolution.summary !== 'object') return null;
  const summary = resolution.summary as Record<string, unknown>;
  if (typeof summary.id !== 'string' || typeof summary.sid !== 'string' || typeof summary.turnId !== 'string' || !Array.isArray(summary.files)) return null;
  const files = summary.files.filter((file): file is Record<string, unknown> => !!file && typeof file === 'object' && !Array.isArray(file))
    .filter((file) => typeof file.path === 'string' && (file.change === 'edit' || file.change === 'new' || file.change === 'del'))
    .map((file) => ({
      path: file.path as string,
      change: file.change as 'edit' | 'new' | 'del',
      ...(typeof file.insertions === 'number' ? { insertions: file.insertions } : {}),
      ...(typeof file.deletions === 'number' ? { deletions: file.deletions } : {}),
      ...(typeof file.binary === 'boolean' ? { binary: file.binary } : {}),
    }));
  if (!Array.isArray(summary.agents) || !summary.agents.every((agent) => typeof agent === 'string')) return null;
  return {
    id: summary.id,
    sid: summary.sid,
    turnId: summary.turnId,
    checkpointMsgId: typeof summary.checkpointMsgId === 'string' ? summary.checkpointMsgId : undefined,
    files,
    status: resolution.kind === 'unavailable' ? 'unavailable' : summary.status === 'partial' || summary.status === 'unavailable' ? summary.status : 'complete',
    derivedUnavailable: summary.derivedUnavailable === true,
    unavailableReason: typeof summary.unavailableReason === 'string' ? summary.unavailableReason : undefined,
    reliableCandidatePaths: Array.isArray(summary.reliableCandidatePaths) ? summary.reliableCandidatePaths.filter((path): path is string => typeof path === 'string') : undefined,
    unattributedCount: typeof summary.unattributedCount === 'number' ? summary.unattributedCount : undefined,
    agents: summary.agents as string[],
    durationMs: typeof summary.durationMs === 'number' ? summary.durationMs : undefined,
    semantic: summary.semantic && typeof summary.semantic === 'object' ? summary.semantic as ArtifactSummary['semantic'] : undefined,
  };
}

/**
 * 定位或领养本轮助手气泡:live 锚 → streaming → spawn。
 * WAL replay 会从未闭合 turnStart 派生同一个 live 锚，因此无需按内容猜测；
 * 猜测尾部 done 会在自动续轮时错误覆盖上一轮。
 */
function ensureStreamingAsst(
  sid: string,
  agentId: string,
  ts: number,
  anchor?: string,
): ChatMessage | null {
  // After Stop, ignore late live frames so they cannot reopen a sealed bubble
  // or flip the Stop button back on (needs-two-clicks).
  if (isAgentStreamSuppressed(sid, agentId)) return null;
  const msgs = useChatStore.getState().readMessages(sid, agentId);
  const byAnchor = anchor ? msgs.find((m) => m.msgId === anchor) : undefined;
  const streaming = findStreamingAsst(sid, agentId)?.msg;
  const adopt = byAnchor ?? streaming;
  if (adopt) {
    patchMsg(sid, agentId, adopt.id, (m) => markMessageStreaming(m, anchor));
    useChatStore.getState().setStreaming(sid, agentId, true);
    return adopt;
  }
  const spawned = spawnStreamingAsst(sid, agentId, ts, anchor);
  useChatStore.getState().setStreaming(sid, agentId, true);
  return spawned;
}

/** Pure/idempotent transition used for every streamed token. */
export function markMessageStreaming(message: ChatMessage, anchor?: string): ChatMessage {
  const anchorUnchanged = !anchor || message.msgId === anchor;
  if (message.status === 'streaming' && anchorUnchanged) return message;
  return {
    ...message,
    status: 'streaming',
    ...(anchor ? { msgId: anchor } : {}),
  };
}

function patchMessageInList(
  messages: ChatMessage[],
  msgId: string,
  mutate: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === msgId);
  if (index < 0) return messages;
  const current = messages[index];
  const nextMessage = mutate(current);
  if (nextMessage === current) return messages;
  const next = messages.slice();
  next[index] = nextMessage;
  return next;
}

function patchMsg(sid: string, agentId: string, msgId: string, mut: (m: ChatMessage) => ChatMessage): void {
  useChatStore.getState().patchMessages(sid, agentId, (messages) => patchMessageInList(messages, msgId, mut));
}

function spawnStreamingAsst(sid: string, agentId: string, ts: number, anchor?: string): ChatMessage {
  const msg: ChatMessage = {
    id: `s-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    text: '',
    toolCalls: [],
    status: 'streaming',
    ts,
    providerId: 'forgeax',
    ...(anchor ? { msgId: anchor } : {}),
  };
  useChatStore.getState().patchMessages(sid, agentId, (msgs) => [...msgs, msg]);
  return msg;
}

// ─── 多 tab 同步:流式消息身份锚 + per-step seal(方案 §3.4 / D4)─────────────
//
// 锚 = `live:<emitterId>:<turnStartTs>`(hook:turnStart 的 event.ts),所有 tab 与
// turn-snapshot 看到同一值 → 同一条流式消息跨端对齐。仅用于在途定位,不持久化。
// seal = 已被 hook:assistantMessage 封口的 text/thinking 前缀长度;一个 turn 内
// assistantMessage 发多条(tool-loop 每 step 一条),reconcile 只修封口后的尾部。

function liveAnchor(emitterId: string, turnStartTs: number): string {
  return `live:${emitterId}:${turnStartTs}`;
}

const _seals = new Map<string, { text: number; thinking: number }>();

function sealKey(sid: string, agentId: string, localMsgId: string): string {
  return `${sid}:${agentId}:${localMsgId}`;
}

/** 从 hook:assistantMessage payload 提取权威 text/thinking。
 *  形状兼容:原生路径 `llmMessage`,cli 桥 `msg`(event-formatter 同款兼容)。 */
function extractAuthoritative(payload: Record<string, unknown>): { text: string; thinking: string } | null {
  const raw = (payload.llmMessage ?? payload.msg) as { content?: unknown; thinking?: unknown } | undefined;
  if (!raw || typeof raw !== 'object') return null;
  let text = '';
  const content = raw.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
  }
  const thinking = typeof raw.thinking === 'string' ? raw.thinking : '';
  if (!text && !thinking) return null;
  return { text, thinking };
}

/** per-step 收口 reconcile:对 seal 之后的未封口尾部做「一致免改 / 缺失补齐 /
 *  不一致替换」,然后推进 seal。任何丢帧在下一个 step 封口时被修正。 */
function reconcileAssistantStep(
  sid: string,
  agentId: string,
  msg: ChatMessage,
  step: { text: string; thinking: string },
  ts: number,
): void {
  const key = sealKey(sid, agentId, msg.id);
  const seal = _seals.get(key) ?? { text: 0, thinking: 0 };
  patchMsg(sid, agentId, msg.id, (m) => {
    let text = m.text;
    let thinking = m.thinking ?? '';
    let segments = m.segments ?? [];
    if (step.thinking) {
      const tail = thinking.slice(seal.thinking);
      if (tail !== step.thinking) {
        thinking = thinking.slice(0, seal.thinking) + step.thinking;
        const missing = step.thinking.startsWith(tail) ? step.thinking.slice(tail.length) : step.thinking;
        if (missing) segments = appendChatSegment(segments, { kind: 'thinking', ts, text: missing });
      }
    }
    if (step.text) {
      const tail = text.slice(seal.text);
      if (tail !== step.text) {
        text = text.slice(0, seal.text) + step.text;
        const missing = step.text.startsWith(tail) ? step.text.slice(tail.length) : step.text;
        if (missing) segments = appendChatSegment(segments, { kind: 'text', ts, text: missing });
      }
    }
    seal.text = text.length;
    seal.thinking = thinking.length;
    return { ...m, text, ...(thinking ? { thinking } : {}), segments };
  });
  _seals.set(key, seal);
}

function activeAgentForSid(sid: string): string | null {
  return useShellStore.getState().tabs.find((tb) => tb.sid === sid)?.agentId ?? null;
}

function pushSystemMessage(
  sid: string,
  agentId: string | null,
  patch: { text: string; compactionId?: string; level?: SystemLevel; direction?: SystemDirection; source?: string; from?: string; to?: string; ts: number },
): void {
  if (!patch.text) return;
  const targetAgent = agentId ?? activeAgentForSid(sid);
  if (!targetAgent) return;
  const prev = useChatStore.getState().readMessages(sid, targetAgent);
  const last = prev[prev.length - 1];
  if (last && last.role === 'system' && (!patch.compactionId || last.id === patch.compactionId) && last.text === patch.text && last.level === patch.level && last.direction === patch.direction) return;
  const sysMsg: ChatMessage = {
    id: patch.compactionId ?? `sys-${patch.ts}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    text: patch.text,
    toolCalls: [],
    status: 'done',
    ts: patch.ts,
    level: patch.level,
    direction: patch.direction,
    source: patch.source,
    from: patch.from,
    to: patch.to,
  };
  useChatStore.getState().patchMessages(sid, targetAgent, (msgs) => {
    const index = patch.compactionId ? msgs.findIndex(m => m.id === patch.compactionId) : -1;
    if (index < 0) return [...msgs, sysMsg];
    return msgs.map((m, i) => i === index ? sysMsg : m);
  });
}

function readableSummary(payload: Record<string, unknown>): string {
  const vis = payload.visual_display;
  if (typeof vis === 'string' && vis) return vis;
  const summary = payload.summary;
  if (typeof summary === 'string' && summary) return summary;
  const text = payload.text;
  if (typeof text === 'string' && text) return text;
  const message = payload.message;
  if (typeof message === 'string' && message) return message;
  const content = payload.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content as Array<Record<string, unknown>>) {
      if (p && typeof p === 'object') {
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
        else if (p.type === 'image_file' && typeof p.path === 'string') parts.push(t('sessionStream.imageRef', { path: p.path }));
        else if ((p.type === 'file' || p.type === 'text_file') && typeof p.path === 'string') parts.push(t('sessionStream.fileRef', { path: p.path }));
      }
    }
    if (parts.length) return parts.join(' ');
  }
  return '';
}

// ─── dispatch ─────────────────────────────────────────────────────────────

export function dispatchSessionEvent(evt: SessionEvent): void {
  const { sid, emitterId, event } = evt;
  const type = event.type;

  // 幂等闸(方案 §3.5):重复/回放重叠帧按 (sgen, seq) 丢弃 —— G3 的 race
  // 从时序问题退化为按 seq 过滤。无 seq 的旧事件按现状路径处理。
  if (!gateSessionEvent(sid, event.sgen, event.seq)) return;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const visible = isChatMessageEvent(type, payload);
  const ts = event.ts ?? Date.now();
  const emitter = emitterId || (typeof event.to === 'string' ? event.to : null);

  // 保序:除 text/thinking chunk 本身外,任何事件处理前先冲刷合帧缓冲——tool_call 的
  // `at: m.text.length` 锚点、turnEnd 的 done 收口都依赖「已到的文本先落」。
  {
    const chunkType = type === 'stream:llm' ? (payload as StreamLlmPayload).chunk?.type : undefined;
    if (chunkType !== 'text' && chunkType !== 'thinking') flushPendingStreamText();
  }

  if (type === 'compaction.status') {
    const message = visible ? formatCompactionStatus({ ...event, emitterId: emitter ?? undefined }) : null;
    if (message) pushSystemMessage(sid, emitter, { ...message, ts: message.timestamp });
    return;
  }

  if (visible && payload.error && type !== 'hook:toolResult' && type !== 'agent_crash' && type !== 'hook:turnEnd') {
    pushSystemMessage(sid, emitter, { text: String(payload.error), level: 'error', source: emitterId ? `${emitterId}(${type})` : type, from: emitterId, ts });
    return;
  }

  if (visible && payload.warning && type !== 'hook:llmFallback' && type !== 'hook:llmRetry') {
    pushSystemMessage(sid, emitter, { text: String(payload.warning), level: 'warning', source: emitterId ? `${emitterId}(${type})` : type, from: emitterId, ts });
    return;
  }

  if (type === 'agent_log') {
    // Provider logs are not user content. Only an explicit host-labelled
    // public summary may enter the production process; raw CLI thinking and
    // unknown visibility remain diagnostics.
    if (payload.visibility !== 'public_summary' || !emitter) return;
    const summary = readableSummary(payload);
    if (!summary.trim()) return;
    const ctxMsg = ensureStreamingAsst(sid, emitter, ts);
    if (!ctxMsg) return;
    enqueueStreamText(sid, emitter, ctxMsg.id, 'thinking', ts, summary, 'public_summary');
    return;
  }

  if (type === 'user_input' && visible) {
    if (isOwnUserInput((payload as UserInputPayload).clientMsgId)) return;
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (!content) return;
    const tabAgent = activeAgentForSid(sid);
    if (useShellStore.getState().tabs.findIndex((tb) => tb.sid === sid) < 0) return;
    const fromAgent = typeof emitterId === 'string' && emitterId.length > 0 ? emitterId : null;
    const toAgent = typeof event.to === 'string' && event.to.length > 0 ? event.to : null;
    const isInterAgent = event.source === 'agent' && fromAgent && toAgent;
    const evtTs = event.ts ?? Date.now();

    if ((payload as { narrativeAutoNudge?: boolean }).narrativeAutoNudge) {
      const target = toAgent || tabAgent;
      if (target) {
        pushSystemMessage(sid, target, { text: content, direction: 'incoming', source: t('sessionStream.narrativeWorkshop'), to: target, ts: evtTs });
      }
      return;
    }

    if (isInterAgent) {
      pushSystemMessage(sid, fromAgent, { text: content, direction: 'outgoing', source: `${fromAgent}(user_input)`, from: fromAgent, to: toAgent, ts: evtTs });
      pushSystemMessage(sid, toAgent, { text: content, direction: 'incoming', source: `${fromAgent}(user_input)`, from: fromAgent, to: toAgent, ts: evtTs });
      return;
    }

    const targetAgent = toAgent || tabAgent;
    if (!targetAgent) return;
    const rawAtts = Array.isArray((payload as { attachments?: unknown }).attachments)
      ? (payload as { attachments: Array<Record<string, unknown>> }).attachments
      : [];
    const attachments = rawAtts.length
      ? rawAtts.map((att) => ({
          kind: typeof att.kind === 'string' ? att.kind : 'file',
          name: typeof att.name === 'string' ? att.name : undefined,
          mediaType: typeof att.mediaType === 'string' ? att.mediaType : undefined,
          path: typeof att.path === 'string' ? att.path : undefined,
          data: typeof att.data === 'string' ? att.data : undefined,
        })).filter((att) => att.path || att.data)
      : undefined;
    const messageId = typeof payload.msgId === 'string' && payload.msgId
      ? payload.msgId
      : typeof payload.clientMsgId === 'string' && payload.clientMsgId
        ? payload.clientMsgId
        : undefined;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text: content,
      toolCalls: [],
      status: 'done',
      ts: evtTs,
      ...(messageId ? { msgId: messageId } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };
    useChatStore.getState().patchMessages(sid, targetAgent, (msgs) => {
      // Resume/WAL overlap can deliver a request already present in this slot.
      // Identity is scoped to (sid, agent), never inferred from prompt text.
      if (messageId && msgs.some(m => m.role === 'user' && m.msgId === messageId)) return msgs;
      // A snapshot may have installed the running reply before its request
      // arrives. Insert the request by event time without moving live replies.
      const index = msgs.findIndex(m => m.ts > evtTs || (m.ts === evtTs && m.role === 'assistant'));
      if (index < 0) return [...msgs, userMsg];
      return [...msgs.slice(0, index), userMsg, ...msgs.slice(index)];
    });
    return;
  }

  if (type.startsWith('rewind:')) {
    const kind = type.slice('rewind:'.length) as 'done' | 'cancelled' | 'finalized' | 'overwrite' | 'overwrite-undone';
    if (kind === 'done' || kind === 'cancelled' || kind === 'finalized' || kind === 'overwrite' || kind === 'overwrite-undone') {
      useChatStore.getState().applyRewindEvent(sid, kind, payload);
    }
    return;
  }

  if (type === 'hook:turnStart') {
    if (!emitter) return;
    const anchor = liveAnchor(emitter, event.ts);
    const msg = ensureStreamingAsst(sid, emitter, ts, anchor);
    if (!msg) return;
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : undefined;
    if (turnId) patchMsg(sid, emitter, msg.id, (current) => ({ ...current, turnId }));
    _seals.set(sealKey(sid, emitter, msg.id), { text: 0, thinking: 0 });
    return;
  }

  if (type === 'stream:llm') {
    const p = payload as StreamLlmPayload;
    const chunk = p.chunk;
    if (!chunk) return;
    if (!emitter) return;
    // 发送 tab 去重(R1-b 对偶):cli 桥把 token 转发为 stream:llm 后,发起 turn 的
    // tab 已经在从自己的 /api/cli/chat SSE 渲染同一份文本 —— WS 这份丢弃。
    if ((chunk.type === 'text' || chunk.type === 'thinking') && isCliSseTurnActive(sid, emitter)) return;
    const ctxMsg = ensureStreamingAsst(sid, emitter, ts);
    if (!ctxMsg) return;
    if (chunk.type === 'text') {
      const txt = chunk.text ?? '';
      if (!txt) return;
      chatFirstToken(emitter);
      enqueueStreamText(sid, emitter, ctxMsg.id, 'text', ts, txt, chunk.visibility);
      return;
    }
    if (chunk.type === 'thinking') {
      const txt = chunk.text ?? '';
      if (!txt) return;
      chatFirstToken(emitter);
      enqueueStreamText(sid, emitter, ctxMsg.id, 'thinking', ts, txt, chunk.visibility);
      return;
    }
    if (chunk.type === 'tool_call') {
      const callId = chunk.id ?? '';
      if (!callId) return;
      let parsedArgs: unknown = chunk.arguments ?? '';
      try { parsedArgs = JSON.parse(chunk.arguments ?? ''); } catch { /* partial */ }
      const normalized = normalizeToolCall(chunk.name ?? 'tool', parsedArgs);
      const tc: ToolCall = { callId, name: normalized.name, args: normalized.args, status: 'running' };
      patchMsg(sid, emitter, ctxMsg.id, (m) => ({
        ...m,
        toolCalls: m.toolCalls.some((tcl) => tcl.callId === callId) ? m.toolCalls.map((tcl) => (tcl.callId === callId ? { ...tcl, ...tc } : tcl)) : [...m.toolCalls, { ...tc, at: m.text.length }],
        segments: upsertToolSegment(m.segments ?? [], ts, tc),
        status: 'streaming',
      }));
      return;
    }
    if (chunk.type === 'tool_call_delta') {
      const callId = chunk.id ?? '';
      if (!callId) return;
      const delta = chunk.arguments_delta ?? '';
      if (!delta) return;
      enqueueDelta(sid, emitter, ctxMsg.id, callId, normalizeToolCall(chunk.name ?? 'tool', {}).name, delta);
      return;
    }
    return;
  }

  // the reference agent CLI / CLI bridge tool events use stream:tool_* rather than
  // hook:toolCall/toolResult. They are transient (not in WAL), so the WS path
  // must maintain the live bubble for refresh/multi-tab restoration.
  if (type === 'stream:tool_use') {
    if (!emitter) return;
    if (isCliSseTurnActive(sid, emitter)) return;
    const callId = typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
    if (!callId) return;
    const msg = ensureStreamingAsst(sid, emitter, ts);
    if (!msg) return;
    const normalized = normalizeToolCall(typeof payload.name === 'string' ? payload.name : 'tool', payload.input ?? {});
    const tc: ToolCall = {
      callId,
      name: normalized.name,
      args: normalized.args,
      status: 'running',
      ...(payload.permissionPrompt === true ? { permissionPrompt: true } : {}),
    };
    patchMsg(sid, emitter, msg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.some((existing) => existing.callId === callId)
        ? m.toolCalls.map((existing) => existing.callId === callId ? { ...existing, ...tc } : existing)
        : [...m.toolCalls, { ...tc, at: m.text.length }],
      segments: upsertToolSegment(m.segments ?? [], ts, tc),
      status: 'streaming',
    }));
    const fileArgs = normalized.args && typeof normalized.args === 'object'
      ? normalized.args as Record<string, unknown>
      : undefined;
    // CliEventBridge records the durable server-side touch and also publishes
    // a hook call below. Do not create a second UI touch for this transient
    // copy; native stream events still use this extraction path.
    if (payload.bridgeSource !== 'cli-event-bridge') {
      extractFileTouch(sid, emitter, callId, tc.name, fileArgs, ts);
    }
    return;
  }

  if (type === 'stream:tool_result') {
    if (!emitter) return;
    if (isCliSseTurnActive(sid, emitter)) return;
    // A tool result is liveness evidence even when the provider has not
    // emitted a text/thinking token and the live bubble is missing.
    chatToolResult(emitter);
    const callId = typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
    if (!callId) return;
    const ctx = findStreamingAsst(sid, emitter);
    if (!ctx) return;
    const apply = (tc: ToolCall): ToolCall =>
      tc.callId === callId
        ? {
          ...tc,
          status: payload.isError ? 'error' : 'done',
          ...(payload.isError
            ? { error: String(payload.output ?? '') }
            : { result: String(payload.output ?? '') }),
        }
        : tc;
    patchMsg(sid, emitter, ctx.msg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.map(apply),
      segments: (m.segments ?? []).map((segment) =>
        segment.kind === 'tool' ? { ...segment, tool: apply(segment.tool) } : segment),
    }));
    useShellStore.getState().updateFileTouchStatus(
      sid,
      emitter,
      callId,
      payload.isError ? 'error' : 'done',
    );
    return;
  }

  if (type === 'hook:toolCall') {
    const p = payload as HookToolCallPayload;
    const callId = p.toolCall?.id ?? '';
    if (!callId) return;
    if (!emitter) return;
    const ctxMsg = ensureStreamingAsst(sid, emitter, ts);
    if (!ctxMsg) return;
    dropPendingDelta(sid, callId);
    const ts2 = event.ts ?? Date.now();
    const normalized = normalizeHookToolCall(p.name ?? p.toolCall?.name ?? 'tool', p.args ?? {});
    const tc: ToolCall = {
      callId,
      name: normalized.name,
      args: normalized.args,
      status: 'running',
      ...(p.permissionPrompt === true ? { permissionPrompt: true } : {}),
    };
    patchMsg(sid, emitter, ctxMsg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.some((tcl) => tcl.callId === callId) ? m.toolCalls.map((tcl) => (tcl.callId === callId ? { ...tcl, ...tc } : tcl)) : [...m.toolCalls, { ...tc, at: m.text.length }],
      segments: upsertToolSegment(m.segments ?? [], ts2, tc),
    }));
    extractFileTouch(sid, emitter, callId, tc.name, normalized.args as Record<string, unknown>, ts2);
    return;
  }

  if (type === 'hook:toolResult') {
    const p = payload as HookToolResultPayload;
    if (!emitter) return;
    // Do this before UI lookup: a durable tool result must dismiss a stale
    // watchdog even if a refresh/multi-tab race left no streaming message.
    chatToolResult(emitter);
    const ctxMsg = ensureStreamingAsst(sid, emitter, ts);
    if (!ctxMsg) return;
    const callId = p.callId;
    const inferredName = inferToolNameFromResult(p.result);
    const resultName = p.name ? normalizeHookToolCall(p.name, {}).name : undefined;
    const apply = (tc: ToolCall): ToolCall => {
      const matched = callId ? tc.callId === callId : (!!resultName && tc.name === resultName && tc.status === 'running');
      if (!matched) return tc;
      const merged = mergeToolResult(tc, p);
      return inferredName && (tc.name === 'tool' || tc.name === 'DeferExecuteTool')
        ? { ...merged, name: inferredName }
        : merged;
    };
    patchMsg(sid, emitter, ctxMsg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.map(apply),
      segments: (m.segments ?? []).map((s) => (s.kind === 'tool' ? { ...s, tool: apply(s.tool) } : s)),
    }));
    if (callId) useShellStore.getState().updateFileTouchStatus(sid, emitter, callId, p.error ? 'error' : 'done');
    return;
  }

  if (type === 'artifact:resolved') {
    if (!emitter) return;
    const artifact = artifactFromPayload(payload);
    if (!artifact) return; // no_change is a terminal fact with no card.
    const latest = findLatestAsst(sid, emitter, artifact.turnId);
    if (!latest) return;
    patchMsg(sid, emitter, latest.id, (message) => ({
      ...message,
      artifact,
      artifactAnchorSeq: typeof payload.anchorSeq === 'number' ? payload.anchorSeq : undefined,
      turnId: message.turnId ?? artifact.turnId,
    }));
    return;
  }

  if (type === 'hook:turnEnd') {
    const p = payload as HookTurnEndPayload;
    if (!emitter) return;
    // A provider may emit a turn-end while ask_user is still waiting. This is
    // a lifecycle checkpoint, not final settle: keep the assistant streaming
    // and leave the Ask card mounted/expanded until its result arrives.
    const ctxMsg = findStreamingAsst(sid, emitter)?.msg;
    const pendingAsk = ctxMsg
      ? hasPendingAskUser([
        ...ctxMsg.toolCalls,
        ...(ctxMsg.segments?.flatMap((segment) => segment.kind === 'tool' ? [segment.tool] : []) ?? []),
      ])
      : false;
    if (p.waitingForInput || (pendingAsk && !p.error && !p.aborted)) return;
    if (ctxMsg) {
      const endTs = event.ts ?? Date.now();
      patchMsg(sid, emitter, ctxMsg.id, (m) => {
        const durationMs = typeof p.durationMs === 'number'
          ? Math.max(0, p.durationMs)
          : Math.max(0, endTs - m.ts);
        const turnId = p.turnId ?? m.turnId;
        if (p.error || p.aborted) {
          return {
            ...m,
            ...(turnId ? { turnId } : {}),
            status: 'error',
            ...(p.aborted ? { turnAborted: true } : {}),
            errorMessage: p.error ?? 'Turn interrupted',
            durationMs,
          };
        }
        return { ...m, ...(turnId ? { turnId } : {}), status: 'done', durationMs };
      });
    }
    // 清掉本 turn 的封口游标 —— 按 (sid,emitter) 前缀全清,不依赖收尾时 findStreamingAsst
    // 命中的还是 turnStart 那个 localMsgId:该气泡可能已被 reconcile 换了 id,或 snapshot
    // (applyTurnSnapshot)用别的 id 建过键,delete-by-exact-id 会落空 → 逐 turn 残留累积
    // (key 含唯一 localMsgId,永不复用)。一个 agent 同刻只跑一个 turn,前缀清扫只清本 turn。
    const sealPrefix = `${sid}:${emitter}:`;
    for (const k of _seals.keys()) if (k.startsWith(sealPrefix)) _seals.delete(k);
    // 原生路同样三值:取消不是故障,也不是成功。两个执行口的判据必须同形 —— 只在一口
    // 分辨取消,同一件事在两条入口下就长得不一样,监控没法比对。
    chatTurnEnd(
      emitter,
      p.error ? 'error' : p.aborted ? 'cancelled' : 'ok',
      p.error ?? (p.aborted ? 'Turn interrupted' : undefined),
    );
    useChatStore.getState().setStreaming(sid, emitter, false);
    if (!p.error && !p.aborted) useChatStore.getState().flushQueuedForAgent(sid, emitter);
    return;
  }

  if (type === 'hook:assistantMessage') {
    // per-step 收口 reconcile(D4):权威文本修正未封口尾部 —— cli 桥旁观 tab
    // (直播期间没有 stream:llm 的场景)正是靠这里把整段文本补上。
    if (emitter) {
      const step = extractAuthoritative(payload);
      if (step) {
        if (step.text || step.thinking) chatFirstToken(emitter);
        if (!isCliSseTurnActive(sid, emitter)) {
          const msg = ensureStreamingAsst(sid, emitter, ts);
          if (msg) reconcileAssistantStep(sid, emitter, msg, step, ts);
        }
      }
    }
    const usage = payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    const model = payload.model;
    if (usage && model) {
      const pct = ratioFromUsage(usage, model);
      if (pct > 0) useChatStore.getState().patchConv(sid, { contextPct: pct });
    }
    return;
  }

  if (type === 'agent_crash') {
    const errMsg = typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : 'agent crash';
    if (emitter) {
      // Close any earlier watchdog before enqueueing the terminal crash card;
      // the crash feedback must remain visible instead of being immediately
      // filtered by the recovery event from chatTurnEnd.
      chatTurnEnd(emitter, 'error', errMsg);
      const ctxMsg = findStreamingAsst(sid, emitter)?.msg;
      if (ctxMsg) patchMsg(sid, emitter, ctxMsg.id, (m) => ({ ...m, status: 'error', errorMessage: errMsg }));
      useChatStore.getState().setStreaming(sid, emitter, false);
    }
    reportPassiveFeedbackSignal({
      code: 'agent_crash',
      message: `${errMsg}\nsid=${sid}\nagent=${emitter ?? 'unknown'}`,
    });
    pushSystemMessage(sid, emitter, { text: errMsg, level: 'error', source: emitterId ? `${emitterId}(agent_crash)` : 'agent_crash', from: emitterId, ts });
    return;
  }

  if (type === 'hook:llmFallback' || type === 'hook:llmRetry') {
    const warning = typeof payload.warning === 'string' ? payload.warning : type;
    const label = type === 'hook:llmFallback' ? 'LLM fallback' : 'LLM retry';
    pushSystemMessage(sid, emitter, { text: warning, level: 'warning', source: emitterId ? `${emitterId}(${label})` : label, from: emitterId, ts });
    return;
  }

  if (type.startsWith('hook:') || type.startsWith('stream:') || type.startsWith('_')) return;
  if (type.startsWith('file-activity:')) return;
  if (type.startsWith('perception:')) return;
  if (type === 'agent_added') {
    const p = payload as { path?: string; display?: string; parent?: string; depth?: number };
    if (p.path) {
      const s = useShellStore.getState();
      const prev = s.liveAgents[sid] ?? [];
      if (!prev.some((a) => a.path === p.path)) {
        s.setLiveAgents(sid, [...prev, { path: p.path, display: p.display ?? p.path, parent: p.parent ?? null, running: false, depth: p.depth ?? (p.parent ? 2 : 1) }]);
      }
    }
    return;
  }
  if (type === 'agent_removed') {
    const p = payload as { path?: string };
    if (p.path) {
      const s = useShellStore.getState();
      const prev = s.liveAgents[sid] ?? [];
      s.setLiveAgents(sid, prev.filter((a) => a.path !== p.path));
    }
    return;
  }
  if (type === 'media_attachment' || type === 'agent_command' || type === 'tick' || type === 'breakpoint_continuation') return;

  // Unknown/internal events must not fall through to readableSummary. Keep
  // metadata handling above this boundary (agent tree, rewind, artifacts, etc.).
  if (!visible) return;
  const viewer = activeAgentForSid(sid);
  const text = readableSummary(payload);
  if (!text) return;
  const to = typeof event.to === 'string' ? event.to : undefined;
  let direction: SystemDirection | undefined;
  if (viewer && to && to === viewer) direction = 'incoming';
  else if (viewer && emitterId && emitterId === viewer && to) direction = 'outgoing';
  const targetSlot = direction === 'incoming' ? (to ?? viewer ?? null) : (emitterId ?? to ?? null);
  pushSystemMessage(sid, targetSlot, { text, direction, source: emitterId ? `${event.source ?? emitterId}(${type})` : `${event.source ?? type}`, from: emitterId, to, ts });
}

// ─── turn-snapshot / resume-gap(中途加入 + 断线续传,方案 §3.2/§3.3)──────────

/** 中途加入补齐:按锚 upsert 一条 streaming 消息,text/thinking/toolCalls 整体
 *  set + seal 基线。段序是近似(thinking→text→tools),收口 reconcile / 刷新后
 *  WAL 回放保证最终一致(方案 §10.4)。 */
export function applyTurnSnapshot(frame: TurnSnapshotFrame): void {
  const { sid, emitterId, payload: p } = frame;
  if (!emitterId) return;
  noteAppliedSeq(sid, p.sgen, p.seq);

  const anchor = liveAnchor(emitterId, p.startedAt);
  // Reconnect snapshots may arrive after a terminal event or WAL recovery.
  // A snapshot of that same turn must not reopen the completed conversation.
  const messages = useChatStore.getState().readMessages(sid, emitterId);
  if (messages.some((message) => message.role === 'assistant' &&
      (message.msgId === anchor || message.ts === p.startedAt) &&
      (message.status === 'done' || message.status === 'error'))) return;
  const toolCalls: ToolCall[] = (p.toolCalls ?? []).map((tc) => {
    const normalized = normalizeToolCall(tc.name, tc.args ?? {});
    return {
      callId: tc.callId,
      name: normalized.name,
      args: normalized.args,
      ...(tc.permissionPrompt ? { permissionPrompt: true } : {}),
      status: tc.status === 'error' ? 'error' : tc.status === 'done' ? 'done' : 'running',
    };
  });
  let segments: ChatMessage['segments'] = [];
  if (p.thinking) segments = appendChatSegment(segments ?? [], { kind: 'thinking', ts: p.startedAt, text: p.thinking });
  if (p.text) segments = appendChatSegment(segments ?? [], { kind: 'text', ts: p.startedAt, text: p.text });
  for (const tc of toolCalls) segments = upsertToolSegment(segments ?? [], p.startedAt, tc);

  const existing = ensureStreamingAsst(sid, emitterId, p.startedAt, anchor);
  if (!existing) return;
  patchMsg(sid, emitterId, existing.id, (m) => ({
    ...m,
    msgId: anchor,
    ts: p.startedAt,
    text: p.text,
    thinking: p.thinking || undefined,
    toolCalls,
    segments,
    status: 'streaming',
  }));
  _seals.set(sealKey(sid, emitterId, existing.id), { text: p.sealedTextLen, thinking: p.sealedThinkingLen });
  useChatStore.getState().setStreaming(sid, emitterId, true);
}

/** 断线超窗/server 换代:全量恢复(强制 WAL 重放,绕过 slot 保护)→ 放行缓冲帧。 */
function handleResumeGap(frame: { sid: string }): void {
  const { sid } = frame;
  const agent = activeAgentForSid(sid);
  const done = (): void => releaseGapBuffer(sid);
  if (!agent) { done(); return; }
  void useChatStore.getState().loadSession(sid, agent, { force: true }).then(done, done);
}

// ─── public boot hook ─────────────────────────────────────────────────────

/** Boot 时调一次。重复调安全（按 key 注册，HMR 重载会覆盖旧 dispatch）。 */
export function subscribeSessionStream(): void {
  onSessionEvent('session-stream', (event) => enqueueSessionWork(() => dispatchSessionEvent(event)));
  onTurnSnapshot('session-stream', (frame) => enqueueSessionWork(() => applyTurnSnapshot(frame)));
  onResumeGap('session-stream', (frame) => enqueueSessionWork(() => handleResumeGap(frame)));
}

const pendingSessionWork: Array<() => void> = [];
let sessionWorkScheduled = false;

function enqueueSessionWork(work: () => void): void {
  pendingSessionWork.push(work);
  if (sessionWorkScheduled) return;
  sessionWorkScheduled = true;
  queueMicrotask(() => {
    sessionWorkScheduled = false;
    const batch = pendingSessionWork.splice(0);
    for (const apply of batch) apply();
  });
}
