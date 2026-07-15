/** SessionEvent → ChatMessage 桥（forgeax 原生 WS 实时流）— chat-owned (R4).
 *
 *  Subscribes to `forgeax-bridge.onSessionEvent` and translates server EventBus
 *  events into patches on the chat conversation store (`useChatStore`). Message
 *  content (segments / toolCalls / thinking / streaming flags / contextPct /
 *  rewind state) is chat-private and lives in `useChatStore`. Registry-runtime
 *  facts the event also carries — live agent tree (`setLiveAgents`) and the
 *  file-activity ledger (`pushFileTouch` / `updateFileTouchStatus`) — stay in
 *  L1's `useShellStore`; this module writes both stores from one dispatch.
 *
 *  Moved out of `@forgeax/interface/src/lib` in R4: once messages left the L1
 *  store, the event→message translator had to follow (L1 may not import chat).
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
import { chatFirstToken, chatTurnEnd } from '@forgeax/interface/lib/trace';
import { t } from '@/i18n';
import { appendChatSegment, isOwnUserInput, isCliSseTurnActive, upsertToolSegment, useChatStore } from './store';

// ─── server event payload shapes ─────────────────────────────────────────

interface StreamLlmPayload {
  chunk?: {
    type: 'text' | 'thinking' | 'tool_call' | 'tool_call_delta' | 'provider_sidecar' | 'usage';
    text?: string;
    id?: string;
    name?: string;
    arguments?: string;
    arguments_delta?: string;
  };
  turn?: number;
}

interface HookToolCallPayload {
  name?: string;
  args?: Record<string, unknown>;
  toolCall?: { id?: string; name?: string };
}

interface HookToolResultPayload {
  name?: string;
  durationMs?: number;
  error?: string;
  callId?: string;
}

interface HookTurnEndPayload {
  turn?: number;
  aborted?: boolean;
  error?: string;
}

interface UserInputPayload {
  content?: string;
  clientMsgId?: string;
}

// ─── file-touch extraction from tool calls ──────────────────────────────
const FILE_TOOL_PATH_KEY: Record<string, string> = {
  read_file: 'path',
  write_file: 'path',
  edit_file: 'file_path',
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
  for (const pd of batch) {
    patchMsg(pd.sid, pd.agentId, pd.msgId, (m) => {
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
    });
  }
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
  chunks: Array<{ kind: 'text' | 'thinking'; ts: number; text: string }>;
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
  for (const p of batch) {
    patchMsg(p.sid, p.agentId, p.msgId, (m) => {
      let text = m.text;
      let thinking = m.thinking ?? '';
      let segments = m.segments ?? [];
      for (const ch of p.chunks) {
        if (ch.kind === 'text') text += ch.text;
        else thinking += ch.text;
        segments = appendChatSegment(segments, { kind: ch.kind, ts: ch.ts, text: ch.text });
      }
      return { ...m, text, ...(thinking ? { thinking } : {}), segments, status: 'streaming' };
    });
  }
}

function enqueueStreamText(sid: string, agentId: string, msgId: string, kind: 'text' | 'thinking', ts: number, text: string): void {
  const key = `${sid}:${agentId}:${msgId}`;
  const p = pendingStreamText.get(key);
  if (p) p.chunks.push({ kind, ts, text });
  else pendingStreamText.set(key, { sid, agentId, msgId, chunks: [{ kind, ts, text }] });
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

function patchMsg(sid: string, agentId: string, msgId: string, mut: (m: ChatMessage) => ChatMessage): void {
  useChatStore.getState().patchMessages(sid, agentId, (msgs) => msgs.map((m) => (m.id === msgId ? mut(m) : m)));
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
  patch: { text: string; level?: SystemLevel; direction?: SystemDirection; source?: string; from?: string; to?: string; ts: number },
): void {
  if (!patch.text) return;
  const targetAgent = agentId ?? activeAgentForSid(sid);
  if (!targetAgent) return;
  const prev = useChatStore.getState().readMessages(sid, targetAgent);
  const last = prev[prev.length - 1];
  if (last && last.role === 'system' && last.text === patch.text && last.level === patch.level && last.direction === patch.direction) return;
  const sysMsg: ChatMessage = {
    id: `sys-${patch.ts}-${Math.random().toString(36).slice(2, 8)}`,
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
  useChatStore.getState().patchMessages(sid, targetAgent, (msgs) => [...msgs, sysMsg]);
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

function dispatch(evt: SessionEvent): void {
  const { sid, emitterId, event } = evt;
  const type = event.type;

  // 幂等闸(方案 §3.5):重复/回放重叠帧按 (sgen, seq) 丢弃 —— G3 的 race
  // 从时序问题退化为按 seq 过滤。无 seq 的旧事件按现状路径处理。
  if (!gateSessionEvent(sid, event.sgen, event.seq)) return;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const ts = event.ts ?? Date.now();
  const emitter = emitterId || (typeof event.to === 'string' ? event.to : null);

  // 保序:除 text/thinking chunk 本身外,任何事件处理前先冲刷合帧缓冲——tool_call 的
  // `at: m.text.length` 锚点、turnEnd 的 done 收口都依赖「已到的文本先落」。
  {
    const chunkType = type === 'stream:llm' ? (payload as StreamLlmPayload).chunk?.type : undefined;
    if (chunkType !== 'text' && chunkType !== 'thinking') flushPendingStreamText();
  }

  if (payload.error && type !== 'hook:toolResult' && type !== 'agent_crash' && type !== 'hook:turnEnd') {
    pushSystemMessage(sid, emitter, { text: String(payload.error), level: 'error', source: emitterId ? `${emitterId}(${type})` : type, from: emitterId, ts });
    return;
  }

  if (payload.warning && type !== 'hook:llmFallback' && type !== 'hook:llmRetry') {
    pushSystemMessage(sid, emitter, { text: String(payload.warning), level: 'warning', source: emitterId ? `${emitterId}(${type})` : type, from: emitterId, ts });
    return;
  }

  if (type === 'user_input' || event.source === 'user') {
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
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text: content,
      toolCalls: [],
      status: 'done',
      ts: evtTs,
      ...(typeof payload.msgId === 'string' ? { msgId: payload.msgId } : {}),
    };
    useChatStore.getState().patchMessages(sid, targetAgent, (msgs) => [...msgs, userMsg]);
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
    let ctx = findStreamingAsst(sid, emitter);
    if (!ctx) {
      const msg = spawnStreamingAsst(sid, emitter, ts, anchor);
      ctx = { sid, agentId: emitter, msg };
    } else {
      // 领养:发送 tab 的乐观占位 / 已存在的流式气泡接上服务端身份锚(§3.4)。
      patchMsg(sid, emitter, ctx.msg.id, (m) => ({ ...m, ts, msgId: anchor }));
    }
    _seals.set(sealKey(sid, emitter, ctx.msg.id), { text: 0, thinking: 0 });
    useChatStore.getState().setStreaming(sid, emitter, true);
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
    let ctx = findStreamingAsst(sid, emitter);
    if (!ctx) {
      const msg = spawnStreamingAsst(sid, emitter, ts);
      ctx = { sid, agentId: emitter, msg };
    }
    if (chunk.type === 'text') {
      const txt = chunk.text ?? '';
      if (!txt) return;
      chatFirstToken(emitter);
      enqueueStreamText(sid, emitter, ctx.msg.id, 'text', ts, txt);
      return;
    }
    if (chunk.type === 'thinking') {
      const txt = chunk.text ?? '';
      if (!txt) return;
      chatFirstToken(emitter);
      enqueueStreamText(sid, emitter, ctx.msg.id, 'thinking', ts, txt);
      return;
    }
    if (chunk.type === 'tool_call') {
      const callId = chunk.id ?? '';
      if (!callId) return;
      let parsedArgs: unknown = chunk.arguments ?? '';
      try { parsedArgs = JSON.parse(chunk.arguments ?? ''); } catch { /* partial */ }
      const tc: ToolCall = { callId, name: chunk.name ?? 'tool', args: parsedArgs, status: 'running' };
      patchMsg(sid, emitter, ctx.msg.id, (m) => ({
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
      enqueueDelta(sid, emitter, ctx.msg.id, callId, chunk.name ?? 'tool', delta);
      return;
    }
    return;
  }

  if (type === 'hook:toolCall') {
    const p = payload as HookToolCallPayload;
    const callId = p.toolCall?.id ?? '';
    if (!callId) return;
    if (!emitter) return;
    const ctx = findStreamingAsst(sid, emitter);
    if (!ctx) return;
    dropPendingDelta(sid, callId);
    const ts2 = event.ts ?? Date.now();
    const tc: ToolCall = { callId, name: p.name ?? p.toolCall?.name ?? 'tool', args: p.args ?? {}, status: 'running' };
    patchMsg(sid, emitter, ctx.msg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.some((tcl) => tcl.callId === callId) ? m.toolCalls.map((tcl) => (tcl.callId === callId ? { ...tcl, ...tc } : tcl)) : [...m.toolCalls, { ...tc, at: m.text.length }],
      segments: upsertToolSegment(m.segments ?? [], ts2, tc),
    }));
    extractFileTouch(sid, emitter, callId, tc.name, p.args, ts2);
    return;
  }

  if (type === 'hook:toolResult') {
    const p = payload as HookToolResultPayload;
    if (!emitter) return;
    const ctx = findStreamingAsst(sid, emitter);
    if (!ctx) return;
    const callId = p.callId;
    const apply = (tc: ToolCall): ToolCall => {
      const matched = callId ? tc.callId === callId : (tc.name === p.name && tc.status === 'running');
      if (!matched) return tc;
      return { ...tc, status: p.error ? 'error' : 'done', error: p.error };
    };
    patchMsg(sid, emitter, ctx.msg.id, (m) => ({
      ...m,
      toolCalls: m.toolCalls.map(apply),
      segments: (m.segments ?? []).map((s) => (s.kind === 'tool' ? { ...s, tool: apply(s.tool) } : s)),
    }));
    if (callId) useShellStore.getState().updateFileTouchStatus(sid, emitter, callId, p.error ? 'error' : 'done');
    return;
  }

  if (type === 'hook:turnEnd') {
    const p = payload as HookTurnEndPayload;
    if (!emitter) return;
    const ctx = findStreamingAsst(sid, emitter);
    if (ctx) {
      const endTs = event.ts ?? Date.now();
      patchMsg(sid, emitter, ctx.msg.id, (m) => {
        const durationMs = endTs - m.ts;
        if (p.error) return { ...m, status: 'error', errorMessage: p.error, durationMs };
        return { ...m, status: 'done', durationMs };
      });
    }
    // 清掉本 turn 的封口游标 —— 按 (sid,emitter) 前缀全清,不依赖收尾时 findStreamingAsst
    // 命中的还是 turnStart 那个 localMsgId:该气泡可能已被 reconcile 换了 id,或 snapshot
    // (applyTurnSnapshot)用别的 id 建过键,delete-by-exact-id 会落空 → 逐 turn 残留累积
    // (key 含唯一 localMsgId,永不复用)。一个 agent 同刻只跑一个 turn,前缀清扫只清本 turn。
    const sealPrefix = `${sid}:${emitter}:`;
    for (const k of _seals.keys()) if (k.startsWith(sealPrefix)) _seals.delete(k);
    chatTurnEnd(emitter, !p.error, p.error);
    useChatStore.getState().setStreaming(sid, emitter, false);
    if (!p.error && !p.aborted) useChatStore.getState().flushQueuedForAgent(sid, emitter);
    return;
  }

  if (type === 'hook:assistantMessage') {
    // per-step 收口 reconcile(D4):权威文本修正未封口尾部 —— cli 桥旁观 tab
    // (直播期间没有 stream:llm 的场景)正是靠这里把整段文本补上。
    if (emitter && !isCliSseTurnActive(sid, emitter)) {
      const step = extractAuthoritative(payload);
      if (step) {
        const ctx = findStreamingAsst(sid, emitter) ??
          { sid, agentId: emitter, msg: spawnStreamingAsst(sid, emitter, ts) };
        reconcileAssistantStep(sid, emitter, ctx.msg, step, ts);
      }
    }
    const usage = payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    const model = payload.model as string | undefined;
    if (usage && model) {
      const pct = ratioFromUsage(usage, model);
      if (pct > 0) useChatStore.getState().patchConv(sid, { contextPct: pct });
    }
    return;
  }

  if (type === 'agent_crash') {
    const errMsg = typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : 'agent crash';
    if (emitter) {
      const ctx = findStreamingAsst(sid, emitter);
      if (ctx) patchMsg(sid, emitter, ctx.msg.id, (m) => ({ ...m, status: 'error', errorMessage: errMsg }));
      useChatStore.getState().setStreaming(sid, emitter, false);
    }
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
function applyTurnSnapshot(frame: TurnSnapshotFrame): void {
  const { sid, emitterId, payload: p } = frame;
  if (!emitterId) return;
  noteAppliedSeq(sid, p.sgen, p.seq);

  const anchor = liveAnchor(emitterId, p.startedAt);
  const toolCalls: ToolCall[] = (p.toolCalls ?? []).map((tc) => ({
    callId: tc.callId,
    name: tc.name,
    args: tc.args ?? {},
    status: tc.status === 'error' ? 'error' : tc.status === 'done' ? 'done' : 'running',
  }));
  let segments: ChatMessage['segments'] = [];
  if (p.thinking) segments = appendChatSegment(segments ?? [], { kind: 'thinking', ts: p.startedAt, text: p.thinking });
  if (p.text) segments = appendChatSegment(segments ?? [], { kind: 'text', ts: p.startedAt, text: p.text });
  for (const tc of toolCalls) segments = upsertToolSegment(segments ?? [], p.startedAt, tc);

  const store = useChatStore.getState();
  const msgs = store.readMessages(sid, emitterId);
  const existing = msgs.find((m) => m.msgId === anchor) ?? findStreamingAsst(sid, emitterId)?.msg;
  let localId: string;
  if (existing) {
    localId = existing.id;
    patchMsg(sid, emitterId, existing.id, (m) => ({
      ...m,
      msgId: anchor,
      ts: p.startedAt,
      text: p.text,
      ...(p.thinking ? { thinking: p.thinking } : {}),
      toolCalls,
      segments,
      status: 'streaming',
    }));
  } else {
    const msg: ChatMessage = {
      id: `s-${p.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      text: p.text,
      ...(p.thinking ? { thinking: p.thinking } : {}),
      toolCalls,
      segments,
      status: 'streaming',
      ts: p.startedAt,
      providerId: 'forgeax',
      msgId: anchor,
    };
    store.patchMessages(sid, emitterId, (prev) => [...prev, msg]);
    localId = msg.id;
  }
  _seals.set(sealKey(sid, emitterId, localId), { text: p.sealedTextLen, thinking: p.sealedThinkingLen });
  store.setStreaming(sid, emitterId, true);
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
  onSessionEvent('session-stream', dispatch);
  onTurnSnapshot('session-stream', applyTurnSnapshot);
  onResumeGap('session-stream', handleResumeGap);
}
