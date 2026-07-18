/** forgeax 原生路径 bridge —— interface 直接给 server EventBus 发消息。
 *
 *  跟 cli-provider 桥（/api/cli/chat SSE，临时）严格分开：这条是 R3 之后
 *  最终保留的"真"路径。流程：
 *
 *      [interface composer.send]
 *           │ POST /api/sessions/:sid/messages
 *           ▼                          ┌────────────────────────────┐
 *      [forgeax-server EventBus] ──→  │ observer fan-out via WsHub │ ──→ ws://?sid=<sid>
 *                                      └────────────────────────────┘
 *
 *  2026-05-20 重做（彻底版）：
 *  - 此前模块自己持有 `_sid` 单例 + `ensureForgeaXSid()` 懒初始化，跟前端
 *    `tabs[].threadId / sessionId` 形成两套独立账本，session 删了 tab 还在、
 *    boot 创了 session 但 tab.threadId 仍是 null —— 一切恶心 fallback 的根源。
 *  - 新版：本模块**不再持有 active sid 状态**。所有写/读操作都要求调用方
 *    显式传入 sid（store.ts 是唯一真值源 = `useShellStore.activeSid`）。WS 连接
 *    内部仍记一个 `_attachedSid` 但只反映「当前 WS 升级到了哪个 sid」，不当
 *    全局活跃 sid 用。
 *  - boot 时由 store action `initSessions()` 显式拉 list / 必要时建一条，再
 *    把 sid 写进 store；本模块只提供 REST 包装。
 */

// ─── 类型 ────────────────────────────────────────────────────────────────

export interface SessionMeta {
  sid: string;
  displayName?: string;
  defaultDir?: string;
  autoStart?: boolean;
  /** Epoch ms of last on-disk activity (server-derived from newest mtime
   *  in the session's agents/ tree). Drives SessionSwitcher's "X 分钟前"
   *  meta + recency sort. Undefined when the server couldn't stat. */
  lastActivityAt?: number;
}

export interface SessionEvent {
  type: "session-event";
  sid: string;
  emitterId?: string;
  event: {
    source: string;
    type: string;
    payload: Record<string, unknown>;
    to?: string;
    ts: number;
    /** 多 tab 同步(§3.1):server EventBus 打的 per-session 单调序号 + 会话代。 */
    seq?: number;
    sgen?: string;
  };
}

/** 中途加入补齐帧(§3.2)—— server LiveTurnTracker 的在途 turn 快照。 */
export interface TurnSnapshotFrame {
  type: "turn-snapshot";
  sid: string;
  emitterId: string;
  payload: {
    turn: number;
    startedAt: number;
    seq: number;
    sgen: string;
    text: string;
    thinking: string;
    sealedTextLen: number;
    sealedThinkingLen: number;
    toolCalls: Array<{ callId: string; name: string; args?: unknown; status: "running" | "done" | "error" }>;
  };
}

/** 断线续传超窗/换代(§3.3)—— 客户端需走全量恢复。 */
export interface ResumeGapFrame {
  type: "resume-gap";
  sid: string;
  sgen: string;
  from: number;
}

export interface ForgeaXAgentNode {
  path: string;
  display: string;
  depth: number;
  fullId: string;
  parent: string | null;
  hasLedger: boolean;
  /** 后端 blackboard.RUNNING 真值快照 —— ConsciousAgent 进入 turn set true，
   *  finally clear false。前端拿这个做权威 isStreaming 初始化（boot/切换
   *  session 时不再臆想），增量靠 hook:turnStart/turnEnd 事件。 */
  running: boolean;
}

// ─── REST：sessions CRUD ─────────────────────────────────────────────────

// `game` scopes the list to one game's sessions (整个 session 面板按 game 收口).
// Omitting it lets the server fall back to the active game; passing the current
// pinned slug keeps every surface showing only that game's sessions.
export async function fetchSessionList(game?: string): Promise<SessionMeta[]> {
  const url = game ? `/api/sessions?game=${encodeURIComponent(game)}` : "/api/sessions";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/sessions ${r.status}`);
  const j = (await r.json()) as { sessions?: SessionMeta[] };
  return j.sessions ?? [];
}

/** 创建一条新 session。`displayName` / `defaultDir` 不传时让 server 端缺省决定
 *  （server 端 displayName 留 undefined → UI 用 `session <sid前6位>` 占位）。 */
export async function createSession(opts?: {
  displayName?: string;
  defaultDir?: string;
  autoStart?: boolean;
  bootstrapAgent?: string | false | null;
}): Promise<{ sid: string; bootstrappedAgent: string | null }> {
  const body: Record<string, unknown> = { autoStart: opts?.autoStart ?? true };
  if (opts?.displayName !== undefined) body.displayName = opts.displayName;
  if (opts?.defaultDir !== undefined) body.defaultDir = opts.defaultDir;
  if (opts?.bootstrapAgent !== undefined) body.bootstrapAgent = opts.bootstrapAgent;
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`POST /api/sessions failed: ${detail}`);
  }
  const j = (await r.json()) as { sid: string; bootstrappedAgent?: string | null };
  return { sid: j.sid, bootstrappedAgent: j.bootstrappedAgent ?? null };
}

/** DELETE /api/sessions/:sid —— 整个 session 目录从盘上抹掉（含 ledger / agents）。
 *  对 unknown sid 是 idempotent（server 端不抛）。失败时抛带 detail 的 Error。 */
export async function deleteSession(sid: string): Promise<void> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}`, {
    method: "DELETE",
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(`DELETE /api/sessions/${sid} failed: ${detail}`);
  }
}

// ─── REST：emit / list_agents ────────────────────────────────────────────

/** POST 一条 user_input 到指定 sid 的 EventBus。
 *  Server 端：session.eventBus.emit(event) → observer fan-out → WS 推回来。
 *
 *  `to`：agent path 或 fullId（"echo#1" 形态）。server `/api/sessions/:sid/messages`
 *  会用 `resolveAgentPath` 把 fullId 解成 path 再 route 到 EventQueue。 */
export async function emitForgeaXMessage(
  sid: string,
  content: string,
  opts: {
    to?: string;
    type?: string;
    payload?: Record<string, unknown>;
    /** EventQueue handoff. Server default is 'turn'. Pass 'steer' for an
     *  interrupt-send: the EventQueue onSteer listener aborts the running LLM
     *  turn immediately, then the steer event is processed as its own turn. */
    handoff?: "silent" | "passive" | "turn" | "innerLoop" | "steer";
  } = {},
): Promise<{ ok: boolean; to?: string; msgId?: string; error?: string }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      ...(opts.to ? { to: opts.to } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.payload ? { payload: opts.payload } : {}),
      ...(opts.handoff ? { handoff: opts.handoff } : {}),
    }),
  });
  if (!r.ok) {
    let detail: string;
    try { detail = ((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`; }
    catch { detail = `HTTP ${r.status}`; }
    return { ok: false, error: detail };
  }
  return (await r.json()) as { ok: boolean; to?: string; msgId?: string };
}

/** 调 `/api/commands/list_agents/query`（args=[sid]）拿到 session 内 agent 列表。
 *  必传 sid —— 调用方负责从 store 拿，本模块不再用模块级单例兜底。 */
export async function listSessionAgents(sid: string): Promise<ForgeaXAgentNode[]> {
  const r = await fetch("/api/commands/list_agents/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: [sid] }),
  });
  if (!r.ok) throw new Error(`list_agents ${r.status}`);
  const j = (await r.json()) as { result?: { ok: boolean; data?: { agents?: ForgeaXAgentNode[] }; error?: string } };
  if (!j.result?.ok) throw new Error(j.result?.error ?? "list_agents failed");
  return j.result.data?.agents ?? [];
}

// ─── WebSocket bridge ────────────────────────────────────────────────────

type SessionEventHandler = (event: SessionEvent) => void;
type TurnSnapshotHandler = (frame: TurnSnapshotFrame) => void;
type ResumeGapHandler = (frame: ResumeGapFrame) => void;
let _ws: WebSocket | null = null;
// handler 按 key 注册（不是匿名 Set），HMR 重载 session-stream.ts 时新 dispatch
// 覆盖旧的，避免一份 event 被多份残留 handler 重复处理。
const _wsHandlers = new Map<string, SessionEventHandler>();
const _snapshotHandlers = new Map<string, TurnSnapshotHandler>();
const _gapHandlers = new Map<string, ResumeGapHandler>();
let _reconnectTimer: number | null = null;
let _reconnectDelay = 1_000;  // 1s → 2 → 4 → 8 ... cap 30s
const RECONNECT_MAX_MS = 30_000;
let _connected = false;
/** 当前 WS 升级到的 sid。null 表示没连。仅反映 WS 自身状态，不是「全局活跃 sid」
 *  —— 那个住 store。 */
let _attachedSid: string | null = null;
/** store 调用 connectForgeaXWs(sid) 切换连接时存这里；reconnect timer fire 时
 *  按这个值升级，避免 reconnect 跑回旧 sid。 */
let _desiredSid: string | null = null;

// ─── 多 tab 同步:per-sid cursor (sgen, lastAppliedSeq) + resume-gap 缓冲 ────
//
// cursor 是「本 tab 已应用到哪」的水位:dispatch 每应用一条带 seq 的事件就推进;
// WAL 回放 / turn-snapshot 应用后由调用方 noteAppliedSeq 回填。重连 URL 带
// since=<seq>&sgen=,server 从 ring buffer 补发;换代(sgen 变)= 全量恢复。

interface SessionCursor { sgen: string; seq: number; }
const _cursors = new Map<string, SessionCursor>();
/** 最近一次 hello 帧报的 server 会话代(per sid)。 */
const _helloSgen = new Map<string, string>();
/** resume-gap 期间缓冲的帧:全量恢复(WAL 重放)完成前不应用,避免被回放覆盖。 */
const _gapBuffers = new Map<string, Array<SessionEvent | TurnSnapshotFrame>>();

/** dispatch 入口幂等闸(§3.5):true = 应用,false = 重复帧丢弃。顺手推进 cursor。 */
export function gateSessionEvent(sid: string, sgen?: string, seq?: number): boolean {
  if (typeof seq !== "number" || typeof sgen !== "string") return true; // 无 seq 旧事件,现状路径
  const cur = _cursors.get(sid);
  if (!cur || cur.sgen !== sgen) { _cursors.set(sid, { sgen, seq }); return true; } // 换代即换 cursor
  if (seq <= cur.seq) return false;
  cur.seq = seq;
  return true;
}

/** WAL 回放 / 快照应用后回填水位(只升不降;sgen 不同则换代)。 */
export function noteAppliedSeq(sid: string, sgen: string, seq: number): void {
  const cur = _cursors.get(sid);
  if (!cur || cur.sgen !== sgen) { _cursors.set(sid, { sgen, seq }); return; }
  if (seq > cur.seq) cur.seq = seq;
}

/** 当前连接的 server 会话代(来自 hello 帧);loadSession 回放后按它筛 WAL 行回填 cursor。 */
export function currentWsSgen(sid: string): string | null {
  return _helloSgen.get(sid) ?? null;
}

/** resume-gap 全量恢复完成 → 按序放行缓冲帧(经 gate 幂等去重)。 */
export function releaseGapBuffer(sid: string): void {
  const buffered = _gapBuffers.get(sid);
  _gapBuffers.delete(sid);
  if (!buffered) return;
  for (const frame of buffered) _routeFrame(frame);
}

function _routeFrame(frame: SessionEvent | TurnSnapshotFrame): void {
  if (frame.type === "session-event") {
    _wsHandlers.forEach((h) => {
      try { h(frame); }
      catch (err) { console.warn("[forgeax-bridge] handler threw", err); }
    });
  } else {
    _snapshotHandlers.forEach((h) => {
      try { h(frame); }
      catch (err) { console.warn("[forgeax-bridge] snapshot handler threw", err); }
    });
  }
}

function wsUrl(sid: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let url = `${proto}//${location.host}/ws?sid=${encodeURIComponent(sid)}`;
  // 断线续传(§3.3):有 cursor 才带 since —— 首连/换 sid 走全量(hello + 快照)。
  const cur = _cursors.get(sid);
  if (cur) url += `&since=${cur.seq}&sgen=${encodeURIComponent(cur.sgen)}`;
  return url;
}

function _connectOnce(sid: string): void {
  // Hard close any prior socket — _scheduleReconnect / repeat connectForgeaXWs
  // 路径都会进来,旧 _ws 如果不关掉,它的 message listener 还在,server 仍把
  // event 推过来 → dispatch 跑两次 → 段重影。listeners 是 per-instance 的,
  // 模块级 _ws 重新赋值不会解绑旧实例的 onmessage,只能显式 close()。
  if (_ws) {
    try { _ws.close(); } catch { /* ignore */ }
    _ws = null;
  }
  _attachedSid = sid;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(sid));
  } catch (err) {
    console.warn("[forgeax-bridge] ws ctor failed", err);
    _scheduleReconnect();
    return;
  }
  _ws = ws;
  ws.addEventListener("open", () => {
    if (_ws !== ws) return;  // we got superseded mid-connect; ignore late open
    _connected = true;
    _reconnectDelay = 1_000;  // reset backoff
  });
  ws.addEventListener("message", (m) => {
    if (_ws !== ws) return;  // late message from an orphaned socket — drop
    let obj: unknown;
    try { obj = JSON.parse(m.data as string); } catch { return; }
    if (typeof obj !== "object" || obj === null) return;
    const frame = obj as { type?: string; sid?: string };

    if (frame.type === "hello" && typeof frame.sid === "string") {
      const sgen = (frame as { sgen?: string }).sgen;
      if (typeof sgen === "string") _helloSgen.set(frame.sid, sgen);
      return;
    }
    if (frame.type === "resume-gap" && typeof frame.sid === "string") {
      // 后续帧先缓冲,等全量恢复(WAL 重放)完成再放行 —— 否则回放 commit 会覆盖它们。
      _gapBuffers.set(frame.sid, []);
      const gap = frame as ResumeGapFrame;
      _gapHandlers.forEach((h) => {
        try { h(gap); }
        catch (err) { console.warn("[forgeax-bridge] gap handler threw", err); }
      });
      return;
    }
    if (frame.type === "session-event" || frame.type === "turn-snapshot") {
      const e = frame as SessionEvent | TurnSnapshotFrame;
      const buffered = _gapBuffers.get(e.sid);
      if (buffered) { buffered.push(e); return; }
      _routeFrame(e);
    }
  });
  ws.addEventListener("close", () => {
    // 只在我们仍是 active socket 时清状态 / reconnect —— 否则上一段 _connectOnce
    // 已经把 _ws 切到新实例,这里碰旧实例的 close 不能反过来覆盖新状态。
    if (_ws !== ws) return;
    _connected = false;
    _ws = null;
    if (_desiredSid) _scheduleReconnect();
  });
  ws.addEventListener("error", (err) => {
    console.warn("[forgeax-bridge] ws error", err);
    // close handler will handle reconnect
  });
}

function _scheduleReconnect(): void {
  if (_reconnectTimer !== null) return;
  if (!_desiredSid) return;
  _reconnectTimer = window.setTimeout(() => {
    _reconnectTimer = null;
    _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS);
    if (_desiredSid) _connectOnce(_desiredSid);
  }, _reconnectDelay);
}

/** 切到指定 sid 的 WS。
 *  - 当前 _attachedSid === sid 且连接活着 → no-op（幂等）。
 *  - 否则关掉旧连接、清掉 reconnect timer、重置 backoff、立即用 sid 重连。
 *  - sid === null 等价于 disconnectForgeaXWs()。 */
export function connectForgeaXWs(sid: string | null): void {
  _desiredSid = sid;
  if (sid === null) {
    if (_reconnectTimer !== null) {
      window.clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    if (_ws) {
      try { _ws.close(); } catch { /* ignore */ }
      _ws = null;
    }
    _attachedSid = null;
    _connected = false;
    return;
  }
  if (sid === _attachedSid && _ws && _connected) return;
  if (_reconnectTimer !== null) {
    window.clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _reconnectDelay = 1_000;
  if (_ws) {
    try { _ws.close(); } catch { /* ignore */ }
    _ws = null;
  }
  _connectOnce(sid);
}

/** 显式断开 WS（store 切到「无 active sid」空态时用）。等价于 connectForgeaXWs(null)。 */
export function disconnectForgeaXWs(): void {
  connectForgeaXWs(null);
}

/** 按 key 注册 handler；同 key 重复注册会**覆盖**（HMR 友好）。返回 unsubscribe。 */
export function onSessionEvent(key: string, handler: SessionEventHandler): () => void {
  _wsHandlers.set(key, handler);
  return () => { _wsHandlers.delete(key); };
}

/** turn-snapshot 帧(中途加入补齐)。注册语义同 onSessionEvent。 */
export function onTurnSnapshot(key: string, handler: TurnSnapshotHandler): () => void {
  _snapshotHandlers.set(key, handler);
  return () => { _snapshotHandlers.delete(key); };
}

/** resume-gap 帧(超窗/换代 → 调用方负责全量恢复后 releaseGapBuffer)。 */
export function onResumeGap(key: string, handler: ResumeGapHandler): () => void {
  _gapHandlers.set(key, handler);
  return () => { _gapHandlers.delete(key); };
}

export function getForgeaXWsStatus(): { connected: boolean; sid: string | null } {
  return { connected: _connected, sid: _attachedSid };
}
