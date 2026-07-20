import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, ArrowDown, Undo2, ChevronDown, X } from 'lucide-react';
import { loadOnboarding, saveOnboarding } from '@forgeax/interface/components/Onboarding/types';
import { APP_EVENTS } from '@forgeax/interface/lib/storageKeys';
import { ForgeCard } from './ForgeCard';
import { Composer } from './Composer';
import { PermissionPrompt } from './PermissionPrompt';
import { ChatAgentCapsule } from './ChatAgentCapsule';
import { RewindConfirmDialog, RewindBanner, DirtyNoticeBar, RewindInlineEditor, BubbleEditInline } from './RewindControls';
import { AgentAvatarVideo } from '@forgeax/ai-workbench/components/AgentAvatarVideo/AgentAvatarVideo';
import { useAgentNames, shortAgentId } from './useAgentNames';
import { useShellStore } from '@forgeax/interface/store';
import {
  useChatStore,
  useActiveMessages,
  useActiveStreaming,
  useActivePendingRewind,
  useActiveRewindDirtyNotice,
  useActiveCheckpointMsgIds,
} from '../../session-store';
import type { ChatMessage } from '../../session-store';
import { parseSegments } from '@forgeax/interface/lib/composer-bridge';
import { PillChip } from '../Composer/PillChip';
import { getWindowManager, decodeSurfaceFromLocation } from '@forgeax/interface/lib/platform';
import { useTranslation, t } from '@forgeax/interface/i18n';
import './ChatPanel.css';

// True when THIS window is itself a detached surface (so we don't show a
// "pop out" button inside an already-popped-out window).
const IS_DETACHED_WINDOW = decodeSurfaceFromLocation() !== null;

// 消息编辑草稿(**仅内存**):点自己消息进编辑态后,若用户改了内容却未发送就失焦/
// 取消,把草稿按 sid:msgId 暂存;下次重新编辑同一条时回填用户上次改到一半的内容。
// 故意用模块级 Map(非 store / 非 ref):跨组件重挂(切 tab、弹出窗口)仍在,但页面
// 刷新即随模块重建而清空 —— 正是「只记内存,刷新就没了」。未改动(草稿==原文)或清空
// 则删除该键,保证下次回到原文。
const editDrafts = new Map<string, string>();
const editDraftKey = (sid: string, msgId: string) => `${sid}::${msgId}`;

// memleak case-02 (MEMLEAK_CASE02_RENDER_WINDOW) — chat-history scroll-up paging.
// messagesByAgent[agentId] is never capped (store.ts), and we used to render
// `messages.map(...)` over the FULL thread, so every turn mounted ~22 more DOM
// nodes that never unmounted (run.mjs make scenario: nodesPerIter≈88, monotonic).
// Now we MOUNT only the most recent window of message blocks (one "page");
// older messages stay in the store (history intact, also persisted to the
// ledger) and are mounted on demand when the user scrolls to the top (上拉分页),
// with a scroll anchor so the view doesn't jump. Crucially, when the user is
// live-tailing at the bottom we COLLAPSE back to one window — so even a marathon
// session that never leaves the chat keeps DOM nodes/listeners bounded.
const MEMLEAK_CASE02_RENDER_WINDOW = 120;
// Distance (px) from the top of the thread at which scroll-up auto-loads the
// previous page. Small so it only fires when the user actually reaches the top.
const MEMLEAK_CASE02_TOP_LOAD_PX = 80;

// "N 条新消息" 浮层的计数单位 —— 一条 = 一次有返回的模型调用,而不是一个聊天气泡。
// 一个 assistant 气泡(一轮)内部可能有多次模型调用,被 tool 段隔开,每段 text 即
// 一次模型返回,所以数它的 text 段(至少 1,兼容没有 segments 的旧消息);
// user / system 气泡各算 1 条。
function unitsOf(m: ChatMessage): number {
  if (m.role !== 'assistant') return 1;
  const texts = (m.segments ?? []).filter((s) => s.kind === 'text').length;
  return Math.max(1, texts);
}
function countUnits(msgs: ChatMessage[]): number {
  let n = 0;
  for (const m of msgs) n += unitsOf(m);
  return n;
}

function PillText({ text }: { text: string }) {
  const segs = parseSegments(text);
  return (
    <>
      {segs.map((s, i) =>
        s.kind === 'text'
          ? <Fragment key={i}>{s.text}</Fragment>
          : <PillChip key={i} payload={s.payload} />,
      )}
    </>
  );
}

// 2026-05-17 — EmptyBusReadout / EmptySurfacesReadout / EmptyEventsTicker
// 三个空 session 调试卡 + 共享的 KIND_ROW 常量删除。本来想用空白页解答
// 「forgeax 都能干啥」,但 bus 总览已经在底栏 GlobalStatusBar (PulseFeeds)
// 长驻显示,空 session 不该多塞这层调试信息。

// Chat timestamp: optimize for "same session" reading. Drop the noisy date
// when the message is from today; show MM-DD HH:MM if same year but different
// day; full YYYY-MM-DD HH:MM only for stale messages. Format follows ISO-ish
// dashes (replaces the old `.` separator) to match conventions used elsewhere.
function sameDay(a: number, b: number): boolean {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
// iter-93: i18n via Intl.RelativeTimeFormat. With {numeric:'auto'} the API
// emits the localized word for 0/-1 days ('today'/'yesterday' in en, '今天'/'昨天'
// in zh, '今日'/'昨日' in ja, 'hoy'/'ayer' in es, 'hier' in fr, etc.) instead of
// numeric strings. Locale resolves from navigator.language; memoized at module
// load (locale doesn't change at runtime). capFirst preserves header-style
// capitalization for latin scripts (cjk/no-case scripts pass through unchanged).
// Fallback to zh '今天/昨天' if Intl.RelativeTimeFormat absent (very old UA).
const RTF = (() => {
  try {
    return new Intl.RelativeTimeFormat(
      typeof navigator !== 'undefined' ? navigator.language : 'en',
      { numeric: 'auto' }
    );
  } catch { return null; }
})();
const capFirst = (s: string): string => (s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Day-divider label: '今天' / '昨天' for the two most recent days (greatly
// reduces eye-load in long sessions), then degrade to MM-DD same-year, then
// full YYYY-MM-DD for old archives. Mirrors formatTs's progressive disclosure.
function dayLabel(ms: number, now: number = Date.now()): string {
  if (sameDay(ms, now)) return RTF ? capFirst(RTF.format(0, 'day')) : t('common.today');
  if (sameDay(ms, now - 86400000)) return RTF ? capFirst(RTF.format(-1, 'day')) : t('common.yesterday');
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, '0');
  if (d.getFullYear() === new Date(now).getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTs(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const pad = (x: number) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return hm;
  }
  if (d.getFullYear() === n.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** SystemLine — renders role='system' ChatMessages with ink-renderer parity.
 *
 *  Four visual flavors driven by `level` + `direction`:
 *   - 报错 (level='error')     ✖  red  border + tinted bg
 *   - 警告 (level='warning')   ⚠  amber border + tinted bg
 *   - 来信 (direction='incoming') 📨  sky-blue accent (inter-agent inbound)
 *   - 出信 (direction='outgoing') 📤  violet accent (inter-agent outbound)
 *   - 其它 info / 中性          ·  dim border, dim text
 *
 *  Long text (>180 chars or multi-line) auto-collapses to first line with
 *  "[展开]" toggle — mirrors ink-renderer's SystemLine.Collapsible behavior. */
const SYS_COLLAPSE_THRESHOLD = 180;

// Inter-agent "拍一拍" phrases. Read as "{from}拍了拍{to}，并{action}".
// HANDOFF — the delegating agent passes the task to another agent (紫色派活).
const PAT_HANDOFF_ACTIONS = [
  '把活儿交给了 ta',
  '请 ta 来搭把手',
  '甩了个大活过去',
  '喊 ta 出场救场',
  '把接力棒递了过去',
  '派 ta 去开工',
  '托付了一件大事',
  '让 ta 接手了',
  '点名 ta 上场',
  '请 ta 接力一棒',
];
// COMPLETION — the delegated agent reports back after finishing (蓝色完工).
const PAT_DONE_ACTIONS = [
  '交差了',
  '把成果递了回来',
  '报告任务完成',
  '把活儿干完了',
  '交卷啦',
  '搞定收工',
  '把接力棒还了回来',
  '汇报了战果',
  '功成身退',
  '把任务画上了句号',
];

function patActionFor(seed: string, pool: readonly string[]): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length]!;
}

function SystemLine({ m }: { m: ChatMessage }) {
  const { t } = useTranslation();
  const resolveName = useAgentNames();
  const isError = m.level === 'error';
  const isWarning = m.level === 'warning';
  const isIncoming = m.direction === 'incoming';
  const isOutgoing = m.direction === 'outgoing';
  // Inter-agent traffic (有 from + to) gets the "拍一拍" treatment: the emitter's
  // avatar replaces the emoji, and a pat phrase frames the from→to relationship.
  // 紫色派活 (source 含 user_input) = handoff; 蓝色完工 = completion.
  const isInterAgent = !isError && !isWarning && !!m.from && !!m.to;
  const isHandoff = isInterAgent && (m.source ?? '').includes('user_input');
  const fromName = isInterAgent ? resolveName(m.from) : '';
  const toName = isInterAgent ? resolveName(m.to) : '';
  const patText = isInterAgent
    ? `${fromName}拍了拍${toName}，并${patActionFor(
        m.msgId ?? m.id ?? `${m.from}:${m.to}`,
        isHandoff ? PAT_HANDOFF_ACTIONS : PAT_DONE_ACTIONS,
      )}`
    : '';
  // 完工消息正文形如「✓ X 完成了…：brief\n\n--- X 的产出 ---\n<产出>」。
  // 摘要(brief 之前+brief)常显在外,产出段折叠进「展开」。
  const patProduceMatch = isInterAgent ? m.text.match(/\n\n--- .+? 的产出 ---\n/) : null;
  const patSummary = patProduceMatch ? m.text.slice(0, patProduceMatch.index) : m.text;
  const patOutput = patProduceMatch ? m.text.slice(patProduceMatch.index! + patProduceMatch[0].length) : '';
  const hasPatOutput = isInterAgent && patOutput.trim().length > 0;
  const icon = isError ? '✖' : isWarning ? '⚠' : isIncoming ? '📨' : isOutgoing ? '📤' : '·';
  const cls = [
    'sys-line',
    isError && 'is-error',
    isWarning && 'is-warning',
    isIncoming && 'is-incoming',
    isOutgoing && 'is-outgoing',
    !isError && !isWarning && !isIncoming && !isOutgoing && 'is-info',
  ].filter(Boolean).join(' ');

  const long = m.text.length > SYS_COLLAPSE_THRESHOLD || m.text.includes('\n');
  const [open, setOpen] = useState(false);
  const firstLine = m.text.split('\n')[0] ?? '';
  const collapsed = firstLine.length > SYS_COLLAPSE_THRESHOLD
    ? firstLine.slice(0, SYS_COLLAPSE_THRESHOLD) + '…'
    : firstLine;
  const label = m.source ? `${m.source}:` : '';

  // 拍一拍 inter-agent 卡片:头像嵌进胶囊(底色保留),摘要常显在外,
  // 产出折叠进右下角「展开」。
  if (isInterAgent) {
    return (
      <div className={cls} data-direction={m.direction} data-level={m.level} data-pat="1">
        <div className="sys-body sys-pat-body">
          <div className="sys-pat-cap">
            <AgentAvatarVideo
              agentId={shortAgentId(m.from!)}
              mode="idle"
              size={20}
              shape="circle"
              className="sys-pat-avatar"
              fallback={<span className="sys-icon" aria-hidden="true">{icon}</span>}
            />
            <span className="sys-pat-text">{patText}</span>
          </div>
          {(patSummary.trim() || (hasPatOutput && open)) && (
            <div className="sys-pat-content">
              {patSummary.trim() && <span className="sys-text">{patSummary.trim()}</span>}
              {hasPatOutput && open && <span className="sys-pat-output">{patOutput.trim()}</span>}
            </div>
          )}
          {hasPatOutput && (
            <div className="sys-pat-foot">
              <button
                type="button"
                className="sys-pat-toggle"
                onClick={() => setOpen((v) => !v)}
                title="点击查看产出"
              >
                {open ? '收起' : '展开'}
                <ChevronDown size={11} className={open ? 'spt-chev open' : 'spt-chev'} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cls} data-direction={m.direction} data-level={m.level}>
      <span className="sys-icon" aria-hidden="true">{icon}</span>
      <div className="sys-body">
        {label && <span className="sys-label">{label}</span>}
        {long ? (
          <>
            <span className="sys-text">{open ? m.text : collapsed}</span>
            <button
              type="button"
              className="sys-toggle"
              onClick={() => setOpen((v) => !v)}
              title={open ? t('chat.systemLine.collapse') : t('chat.systemLine.expandAll')}
            >
              {open ? t('chat.systemLine.collapse') : t('chat.systemLine.expand')}
            </button>
          </>
        ) : (
          <span className="sys-text">{m.text}</span>
        )}
        {(m.from || m.to) && (
          <span className="sys-meta">
            {m.from && <span className="sys-meta-from"> from {m.from}</span>}
            {m.to && <span className="sys-meta-to"> → {m.to}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const { t } = useTranslation();
  const messages = useActiveMessages();
  // First-chat hint: after the onboarding tour ends, a brand-new user hasn't
  // sent anything yet. Instead of a global floating nudge, this belongs to the
  // chat's own empty state — a note above the composer + a highlighted input,
  // dismissed on close or as soon as any message exists.
  const [firstHintOpen, setFirstHintOpen] = useState(() => {
    const s = loadOnboarding();
    return s.done.tour && !s.done.firstChat;
  });
  const dismissFirstHint = useCallback(() => {
    setFirstHintOpen(false);
    const s = loadOnboarding();
    if (!s.done.firstChat) saveOnboarding({ ...s, done: { ...s.done, firstChat: true } });
  }, []);
  const showFirstHint = firstHintOpen && messages.length === 0;
  useEffect(() => {
    if (firstHintOpen && messages.length > 0) dismissFirstHint();
  }, [firstHintOpen, messages.length, dismissFirstHint]);
  // ChatPanel mounts before the tour finishes, so its initial read of the
  // onboarding state is stale. Re-read when the tour signals completion so the
  // hint can appear this session without a reload.
  useEffect(() => {
    const onChanged = () => {
      const s = loadOnboarding();
      setFirstHintOpen(s.done.tour && !s.done.firstChat);
    };
    window.addEventListener(APP_EVENTS.onboardingChanged, onChanged);
    return () => window.removeEventListener(APP_EVENTS.onboardingChanged, onChanged);
  }, []);
  const threadRef = useRef<HTMLDivElement>(null);
  // Auto-scroll / "jump to latest" 状态机。
  //   - pinnedRef：是否「贴底跟随」。pinned 时新输出自动滚到底;非 pinned 时不
  //     自动滚,只累加 unread 弹浮层。关键:一旦用户**往上滚一点点**就立刻
  //     unpin(不等 48px 阈值)—— 否则 streaming 期间每个 token 都 scrollTo 底部,
  //     会把用户 <48px 的小幅上滚一次次拽回去,手感像「滚不动」(这是真正的 bug)。
  //   - lastTopRef：上一次观察到的 scrollTop,用来区分「用户上滚」(top 变小) 和
  //     「我们自己 scrollToBottom」(top 变大/落到底)。
  //   - seenUnitsRef：unpin 那一刻「已读」的模型返回单元数(见 countUnits),
  //     unread = 现在单元数 - seenUnits。正在 streaming 的尾条整体排除在外(用户
  //     正是滚上去不看它),其后续每多一次模型返回(多一段 text)unread 就 +1。
  //   - lastUserMsgIdRef：检测「用户刚发了新消息」,无论在哪都强制回底部。
  // 程序化滚动一律 instant:瞬时落底只产生一个「在底部」的 scroll 事件。
  const pinnedRef = useRef(true);
  const lastTopRef = useRef(0);
  const seenUnitsRef = useRef(0);
  const lastUserMsgIdRef = useRef<string | null>(null);
  const [unread, setUnread] = useState(0);
  // How many of the most recent message blocks to MOUNT (memleak case-02).
  // Grows by one window when the user scrolls to the top (上拉分页) and collapses
  // back to one window when they return to the live bottom — so DOM stays
  // bounded whether they leave or chat forever. History is never lost (it lives
  // in the store + ledger); only what React mounts is paged.
  const [renderLimit, setRenderLimit] = useState(MEMLEAK_CASE02_RENDER_WINDOW);
  // Set right before a scroll-up page-load; consumed by a useLayoutEffect to
  // restore the scroll position after the older page mounts (anti-jump anchor).
  const topAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const scrollToBottom = () => {
    const el = threadRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setUnread(0);
    el.scrollTo({ top: el.scrollHeight });
    lastTopRef.current = el.scrollTop;
  };

  const handleScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const atBottom = el.scrollHeight - top - el.clientHeight < 48;
    const scrolledUp = top < lastTopRef.current - 1;
    lastTopRef.current = top;

    // memleak case-02 — 上拉分页:滚到接近顶部且还有更早未挂载的消息时,自动多
    // 挂载一页。先存锚点(当前 scrollHeight/scrollTop),渲染后由 useLayoutEffect
    // 还原滚动位置,避免新内容撑高把视口往下顶造成跳动。
    if (top < MEMLEAK_CASE02_TOP_LOAD_PX && messages.length > renderLimit && !topAnchorRef.current) {
      topAnchorRef.current = { prevHeight: el.scrollHeight, prevTop: top };
      setRenderLimit((n) => Math.min(messages.length, n + MEMLEAK_CASE02_RENDER_WINDOW));
    }

    // 上滚优先:哪怕还在底部 48px 内,只要用户往上动就 unpin —— 否则贴底跟随
    // 会把这小幅上滚一次次拽回去。re-pin 只在「不是上滚 + 已到底部」时发生。
    if (scrolledUp) {
      if (pinnedRef.current) {
        pinnedRef.current = false;
        const tail = messages[messages.length - 1];
        const streaming = tail && tail.status === 'streaming';
        // 正在 streaming 的尾条整体算未读;之后每多一次模型返回 unread 自增。
        const seen = countUnits(messages) - (streaming ? unitsOf(tail) : 0);
        seenUnitsRef.current = seen;
        setUnread(Math.max(0, countUnits(messages) - seen));
      }
    } else if (atBottom) {
      pinnedRef.current = true;
      setUnread(0);
      // memleak case-02 — 回到实时底部 → 折叠回一页窗口,卸载之前上拉展开的更早
      // 消息(仍在 store,下次上滑可重新挂载)。这保证「长时间贴底连续对话、从不
      // 离开」时 DOM 也恒定有界。在底部卸载顶部内容不移动底部视口,不会跳。
      // 函数式更新:已是默认窗口时返回同值,React 会跳过这次 re-render(无抖动)。
      setRenderLimit((n) => (n > MEMLEAK_CASE02_RENDER_WINDOW ? MEMLEAK_CASE02_RENDER_WINDOW : n));
    }
  };

  // memleak case-02 — anti-jump anchor for scroll-up paging. After an older page
  // mounts (renderLimit grew via handleScroll/click), the thread got taller above
  // the viewport; offset scrollTop by exactly that growth so the message the user
  // was looking at stays put. No-op on initial mount / bottom-collapse (no anchor).
  useLayoutEffect(() => {
    const el = threadRef.current;
    const anchor = topAnchorRef.current;
    if (!el || !anchor) return;
    el.scrollTop = el.scrollHeight - anchor.prevHeight + anchor.prevTop;
    lastTopRef.current = el.scrollTop;
    topAnchorRef.current = null;
  }, [renderLimit]);
  // Auto-replay trigger — R3 (2026-05-20)：换成 `loadSession(sid, agentPath)`。
  //
  // 旧路径走 `loadThreadHistory(threadId)` → `/api/threads/:id` + `/api/runs/:id/events`，
  // 那条 AG-UI 路径在 R3 下已下线（threadId 现在等价 sid，但 server 端没有
  // `/api/threads` 路由），返回 404 时静默丢空，前端就看到「刷新后聊天历史不渲染」。
  //
  // 新路径直接读 ledger：fetch_session_events(sid, agentPath) raw JSONL → trim
  // 到上一个 compact_boundary → TurnAccumulator 重放。forgeax 一个 (sid,
  // agentPath) 一份 ledger，所以 effect 依赖 `[sid, agentPath]`，**两个都变才**
  // 重拉一次。
  //
  // Empty-messages gate 保持：sendMessage 已经 append 用户气泡 + streaming
  // 气泡（store.ts ~1680）；如果 messages 已有，说明正在直播，不能 clobber。
  // 持久化 tab 刷新场景 messages=[]，gate 开门重放。
  // 2026-05-20 重做：sid === threadId（一一对应），WAL replay 直接用 activeSid。
  const activeSid = useShellStore((s) => s.activeSid);
  const activeAgentId = useShellStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  const loadSession = useChatStore((s) => s.loadSession);
  // Each (sid, agentPath) pair has its own ledger on disk + an independent
  // messagesByAgent slot in store. Reload whenever the (sid, agentPath) key
  // changes — including when the user switches agent **during** another
  // agent's in-flight stream (Forge stuck delegating → user clicks mochi).
  // R3.5 (2026-05-23) — dropped the `isStreaming` guard that previously
  // short-circuited this effect: per-agent slots mean the live Forge stream
  // lives in messagesByAgent[forge] and isn't clobbered by loading mochi's
  // history into messagesByAgent[mochi]. loadedKeyRef still prevents
  // redundant reloads of the same (sid, agent) pair on steady-state sends.
  //
  // R3.6 (2026-05-23) — `loadedKeyRef` was a single string, so the sequence
  // forge → mochi → iro → mochi would reload mochi a second time when the
  // user switched back. That second load races with the optimistic state
  // already cached in `messagesByAgent[mochi]` and (in the failure mode where
  // LLM never produced an `assistant_complete` event — e.g. broken model
  // config) replaces it with just the lone `user_input` from WAL, dropping the
  // assistant bubble the user already saw. Live SSE keeps the slot in sync
  // while we're away, so a Set-of-loaded-keys is sufficient: every (sid,
  // agent) replays from WAL exactly once per ChatPanel lifetime.
  const loadedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeSid || !activeAgentId) return;
    const key = `${activeSid}:${activeAgentId}`;
    if (loadedKeysRef.current.has(key)) return;
    loadedKeysRef.current.add(key);
    void loadSession(activeSid, activeAgentId);
  }, [activeSid, activeAgentId, loadSession]);

  // 2026-06-30 — game round-trip fix. Switching game makes `refreshSessions`
  // DROP the old game's tabs and (on switching back) RECREATE them with empty
  // `messages`/`messagesByAgent`. `loadedKeysRef` is keyed per ChatPanel
  // lifetime, so a recreated tab's (sid,agent) is still flagged "loaded" → the
  // replay effect above short-circuits and its WAL history never reloads
  // (symptom: switch game → switch back → clicking any session shows empty,
  // "切 session 无效"). Forget keys whose sid has left the tab list so a
  // recreated tab replays from WAL afresh. (sid is a UUID — no ':' — so the
  // substring before the first ':' is the sid.)
  const tabSidsKey = useShellStore((s) => s.tabs.map((t) => t.sid).join('\u0000'));
  useEffect(() => {
    const present = new Set(tabSidsKey ? tabSidsKey.split('\u0000') : []);
    for (const key of [...loadedKeysRef.current]) {
      if (!present.has(key.slice(0, key.indexOf(':')))) {
        loadedKeysRef.current.delete(key);
      }
    }
  }, [tabSidsKey]);

  // ── checkpoint 回退点 ──────────────────────────────────────
  // 每次切到一个 sid 拉一次 checkpoints 索引(msgId → hasCode + 挂起态)。
  // rewind:* WS 事件实时维护;这里是冷启动/刷新后的权威同步。
  const loadCheckpoints = useChatStore((s) => s.loadCheckpoints);
  useEffect(() => {
    if (activeSid) void loadCheckpoints(activeSid);
  }, [activeSid, loadCheckpoints]);
  const pendingRewind = useActivePendingRewind();
  const rewindDirtyNotice = useActiveRewindDirtyNotice();
  const chatStreaming = useActiveStreaming();
  const checkpointMsgIds = useActiveCheckpointMsgIds();
  // 确认浮层:点「⟲ 回到这里」后置 {msgId};null = 关闭。
  const [rewindConfirm, setRewindConfirm] = useState<string | null>(null);
  // 消息编辑态:点自己已发送的消息进入,原地编辑 + 其后置灰,但不立即回退。
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  // ⟲ 即时回退一旦启动(pendingRewind),退出编辑态——二者互斥,pendingRewind 优先。
  useEffect(() => {
    if (pendingRewind) setEditingMsgId(null);
  }, [pendingRewind]);
  // 置灰起点:挂起且非 code-only 时优先,否则编辑态时取编辑目标。目标消息在
  // messages 里的下标(含自身),其后的消息置灰。
  const rewoundFromIdx = (() => {
    if (pendingRewind && pendingRewind.mode !== 'code') {
      return messages.findIndex((m) => m.msgId === pendingRewind.targetMsgId);
    }
    if (editingMsgId) {
      return messages.findIndex((m) => m.msgId === editingMsgId);
    }
    return -1;
  })();

  // 三态滚动策略(messages 每个 token / 新气泡都会变):
  //   2) 用户刚发新消息 → 永远回到底部(不管之前在哪)。
  //   3) 本来贴在底部 → 跟随最新输出。
  //   1) 不在底部 → 不打扰,累加 unread 数,由浮层提示。
  useEffect(() => {
    let lastUserId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserId = messages[i].id; break; }
    }
    const userJustSent = lastUserId !== null && lastUserId !== lastUserMsgIdRef.current;
    lastUserMsgIdRef.current = lastUserId;

    if (userJustSent || pinnedRef.current) {
      // 2) 用户刚发新消息 → 永远回底部;3) 贴底跟随 → 跟随最新输出。
      scrollToBottom();
    } else {
      // 1) 已 unpin → 不打扰,按模型返回单元数累加 unread,由浮层提示。
      setUnread(Math.max(0, countUnits(messages) - seenUnitsRef.current));
    }
    // scrollToBottom 每次渲染重建且只读 ref,不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Midnight refresh: dayLabel("今天"/"昨天") is computed against Date.now() at
  // render. iter-94 chain-reschedule fires once at midnight, bumps dayTick,
  // then re-arms itself for the next midnight (cheap, no per-render churn).
  // iter-95 consolidation: also own visibility-driven re-arm. setTimeout
  // counts monotonic elapsed time, not wall clock — so when the system clock
  // jumps (TZ change, NTP correction, sleep/resume across midnight), the
  // in-flight timer still fires at the original monotonic delta but the wall
  // clock has moved past midnight, leaving dayLabel stale. On
  // visibilitychange→visible we clear and re-schedule against the fresh wall
  // clock, then bump dayTick to force a re-render. Math.max(0, …) clamps
  // negative deltas to fire-now in case wall clock has already passed the
  // pre-jump midnight.
  const [, setDayTick] = useState(0);
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1).getTime();
      id = setTimeout(() => { setDayTick((t) => t + 1); schedule(); }, Math.max(0, nextMidnight - now.getTime()));
    };
    schedule();
    const onVis = () => {
      if (!document.hidden) { clearTimeout(id); setDayTick((t) => t + 1); schedule(); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const canPopOut = !IS_DETACHED_WINDOW && getWindowManager().canDetach();

  return (
    <aside className="chat-panel chat-rail glass-subtle" data-testid="chat-panel">
      {canPopOut && (
        <button
          className="cp-window-toggle"
          onClick={() =>
            void useShellStore.getState().detachSurface(
              { kind: 'panel', id: 'chat' },
              { title: t('chat.windowTitle') },
            )
          }
          title={t('chat.popOut')}
        >
          <ExternalLink size={12} />
        </button>
      )}
      <div className="cp-body">
        <ChatAgentCapsule />

        <div className="cp-thread thin-scrollbar" ref={threadRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="cp-empty">
            <div className="cp-empty-title">{t('chat.empty.title')}</div>
            <div className="cp-empty-sub">
              {t('chat.empty.subtitle')}
            </div>
            {/* 2026-05-17 — EmptyBusReadout / EmptySurfacesReadout /
               EmptyEventsTicker 3 张卡片删除。bus host 总数 / kind 拆分 /
               UI surfaces / live events 等信号统一由底栏 GlobalStatusBar
               (PulseFeeds 6 chip) 承载,空 session 不该塞这么多调试信息。 */}
          </div>
        )}

        {messages.length > renderLimit && (
          <button
            className="cp-load-earlier"
            onClick={() => {
              const el = threadRef.current;
              if (el) topAnchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
              setRenderLimit((n) => Math.min(messages.length, n + MEMLEAK_CASE02_RENDER_WINDOW));
            }}
            title={t('chat.loadEarlier.tooltip')}
          >
            ↑ {t('chat.loadEarlier.label', { count: messages.length - renderLimit })}
          </button>
        )}

        {(messages.length > renderLimit ? messages.slice(messages.length - renderLimit) : messages).map((m, idx, view) => {
          const prev = idx > 0 ? view[idx - 1] : null;
          const showDivider = !prev || !sameDay(prev.ts, m.ts);
          // checkpoint:绝对下标(分页 slice 偏移)→ 是否落在被回退置灰区。
          const absIdx = messages.length - view.length + idx;
          // Cursor 软回退:目标消息原地变编辑框(isEditTarget),它**之后**的
          // 消息变灰(isRewound 严格 > 目标)。
          const isEditTarget = rewoundFromIdx >= 0 && absIdx === rewoundFromIdx;
          const isRewound = rewoundFromIdx >= 0 && absIdx > rewoundFromIdx;
          // 编辑态目标:点气泡进入,渲染 BubbleEditInline(发送时按需弹回退确认)。
          const isLocalEditTarget = m.role === 'user' && !!editingMsgId && m.msgId === editingMsgId;
          const canRewindHere =
            m.role === 'user' && !!m.msgId && checkpointMsgIds?.[m.msgId] !== undefined
            && !isRewound && !isEditTarget && m.msgId !== editingMsgId;
          if (isLocalEditTarget && activeSid) {
            return (
              <Fragment key={m.id}>
                {showDivider && <div className="day-divider"><span>{dayLabel(m.ts)}</span></div>}
                <div className="msg-block rw-edit-block">
                  <BubbleEditInline
                    sid={activeSid}
                    msgId={m.msgId!}
                    initialText={editDrafts.get(editDraftKey(activeSid, m.msgId!)) ?? m.text}
                    hasCode={checkpointMsgIds?.[m.msgId!] === true}
                    isStreaming={chatStreaming}
                    onCancel={(draft) => {
                      // 非发送退出:改过(且非空)→ 暂存草稿;未改 / 清空 → 删键回原文。
                      const k = editDraftKey(activeSid, m.msgId!);
                      if (draft.trim() && draft !== m.text) editDrafts.set(k, draft);
                      else editDrafts.delete(k);
                      setEditingMsgId(null);
                    }}
                  />
                </div>
              </Fragment>
            );
          }
          if (isEditTarget && m.role === 'user' && activeSid) {
            return (
              <Fragment key={m.id}>
                {showDivider && <div className="day-divider"><span>{dayLabel(m.ts)}</span></div>}
                <div className="msg-block rw-edit-block">
                  <RewindInlineEditor sid={activeSid} initialText={m.text} isStreaming={chatStreaming} />
                </div>
              </Fragment>
            );
          }
          return (
            <Fragment key={m.id}>
              {showDivider && <div className="day-divider"><span>{dayLabel(m.ts)}</span></div>}
              {m.role === 'user' ? (
                <div className={`msg-block${isRewound ? ' is-rewound' : ''}`}>
                  <div className="ts">{formatTs(m.ts)}</div>
                  <div
                    className={`user-bubble${canRewindHere ? ' has-rewind' : ''}${canRewindHere && !pendingRewind && !chatStreaming ? ' can-edit' : ''}`}
                    onClick={canRewindHere && !pendingRewind && !chatStreaming
                      ? () => setEditingMsgId(m.msgId!)
                      : undefined}
                    title={canRewindHere && !pendingRewind && !chatStreaming ? t('chat.editMessage') : undefined}
                  >
                    <PillText text={m.text} />
                    {canRewindHere && (
                      <button
                        type="button"
                        className="rw-here-btn"
                        title={t('chat.rewindHere.tooltip')}
                        aria-label={t('chat.rewindHere.label')}
                        onClick={(e) => { e.stopPropagation(); setRewindConfirm(m.msgId!); }}
                      ><Undo2 size={13} strokeWidth={2} /></button>
                    )}
                  </div>
                </div>
              ) : m.role === 'system' ? (
                <div className={`msg-block sys-block${isRewound ? ' is-rewound' : ''}`}>
                  <div className="ts">{formatTs(m.ts)}</div>
                  <SystemLine m={m} />
                </div>
              ) : (
                <div className={`msg-block${isRewound ? ' is-rewound' : ''}`}>
                  <div className="ts">{formatTs(m.ts)}</div>
                  <ForgeCard
                    status={m.status === 'streaming' ? 'running' : m.status === 'error' ? 'waiting' : 'done'}
                    text={m.text}
                    thought={m.thinking}
                    thoughtCollapsed
                    toolCalls={m.toolCalls}
                    segments={m.segments}
                    subAgents={m.subAgents}
                    errorMessage={m.errorMessage}
                    providerId={m.providerId}
                    cost={m.cost}
                    durationMs={m.durationMs}
                    agentName={activeAgentId ?? undefined}
                    sid={activeSid ?? undefined}
                    agentId={activeAgentId ?? undefined}
                  />
                  {/* SubAgentCards are now rendered inline by ForgeCard next to
                      their associated chip (in main flow or inside TodoFlow
                      nest), with an orphan fallback at the bubble bottom. */}
                </div>
              )}
            </Fragment>
          );
        })}
        {/* code-only 软回退:消息列表不动,横幅挂线程尾部提供恢复入口。
            会话回退但目标消息不在本地列表(刷新边界)时同样兜底渲染在尾部。 */}
        {pendingRewind && activeSid && (pendingRewind.mode === 'code' || rewoundFromIdx === -1) && (
          <RewindBanner sid={activeSid} pending={pendingRewind} />
        )}
        {/* 手改保留/覆盖通知(独立于挂起态;恢复后仍可操作) */}
        {rewindDirtyNotice && activeSid && (
          <DirtyNoticeBar sid={activeSid} notice={rewindDirtyNotice} />
        )}
        </div>

        {unread > 0 && (
          <button
            className="cp-jump-latest"
            onClick={() => scrollToBottom()}
            title={t('chat.jumpLatest.tooltip')}
          >
            <ArrowDown size={13} strokeWidth={2.4} />
            <span>{t('chat.jumpLatest.unread', { count: unread })}</span>
          </button>
        )}
      </div>

      {rewindConfirm && activeSid && (
        <RewindConfirmDialog
          sid={activeSid}
          msgId={rewindConfirm}
          hasCode={checkpointMsgIds?.[rewindConfirm] === true}
          onClose={() => setRewindConfirm(null)}
        />
      )}

      <PermissionPrompt />
      {showFirstHint && (
        <div className="cp-first-hint" role="note">
          <div className="cp-first-hint-copy">
            <span className="cp-first-hint-title">{t('onboarding.nudge.title')}</span>
            <span className="cp-first-hint-text">{t('onboarding.nudge.body')}</span>
          </div>
          <button
            type="button"
            className="cp-first-hint-close"
            aria-label={t('onboarding.nudge.gotIt')}
            title={t('onboarding.nudge.gotIt')}
            onClick={dismissFirstHint}
          >
            <X size={18} />
          </button>
        </div>
      )}
      <Composer highlight={showFirstHint} />
    </aside>
  );
}
