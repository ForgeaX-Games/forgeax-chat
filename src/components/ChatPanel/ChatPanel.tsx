import { ForgeText } from './message-parts/ForgeText';
import { collaborationUpdates } from './collaboration-updates';
import { CollaborationDock } from './CollaborationDock';
import { collaborationWork, isCollaborationActive } from './collaboration-status';
import { DelegationCard } from './DelegationCard';
import type { DelegationMessage } from '../../event-engine/delegation-status';
import { failureContinuation } from './execution-failure';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, ArrowDown, ArrowLeft, ArrowRight, Undo2, ChevronDown, X } from 'lucide-react';
import { loadOnboarding, saveOnboarding } from '@forgeax/interface/components/Onboarding/types';
import { APP_EVENTS } from '@forgeax/interface/lib/storageKeys';
import { usePendingPermission } from '@forgeax/interface/lib/permission-stream';
import { ForgeCard } from './ForgeCard';
import { Composer } from './Composer';
import { PermissionPrompt } from './PermissionPrompt';
import { isAgentHandoff, handoffNavigationTarget, hasRunningHandoff } from './handoff-messages';
import { dropAskUserSession } from './message-parts/AskUserCard';
import { ChatAgentCapsule } from './ChatAgentCapsule';
import { RewindConfirmDialog, RewindBanner, DirtyNoticeBar, RewindInlineEditor, BubbleEditInline } from './RewindControls';
import { AgentAvatarVideo } from '@forgeax/agents/components/AgentAvatarVideo/AgentAvatarVideo';
import { useHost } from '@forgeax/interface/core/app-shell';
import { useAgentNames, shortAgentId } from './useAgentNames';
import { useShellStore } from '@forgeax/interface/store';
import {
  useChatStore,
  useActiveMessages,
  useActiveStreaming,
  useActiveStreamingByAgent,
  useActivePendingRewind,
  useActiveRewindDirtyNotice,
  useActiveCheckpointMsgIds,
} from '../../session-store';
import type { ChatMessage } from '../../session-store';
import { parseDisplaySegments } from '@forgeax/interface/lib/composer-bridge';
import { PillChip } from '../Composer/PillChip';
import type { ChatAttachment } from '@forgeax/interface/store';
import { getLocale, useTranslation, t } from '@forgeax/interface/i18n';
import { projectWorkTimeline } from '../../task-flow/project';
import { hasPendingAskUser } from '../../task-flow/ask-user-protocol';
import { openAgentWorkspace } from '../../lib/open-agent-workspace';
import { useAgentThreadNav, useAskUserThreadFocus } from './use-agent-thread';
import type { WorkTimelineItem } from '../../task-flow/model';
import { ProcessAccordion } from './ProcessAccordion';
import { ArtifactCard } from './ArtifactCard';
import { createDeliverActions } from './deliver-actions';
import { SummonSelectionContext } from './summon-selection';
import { isProjectedRemnant } from './message-projection';
import { canSummonSpecialistFromActiveThread } from './agent-key';
import { messageReadSnapshot, unreadMessageCount } from './unread-messages';
import { createScrollFollow } from './scroll-follow';
import './ChatPanel.css';
import './TaskFlow.css';

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

function PillText({ text }: { text: string }) {
  const segs = parseDisplaySegments(text);
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

function attachmentSrc(att: ChatAttachment, sid: string | null): string | null {
  if (att.data) {
    if (att.data.startsWith('data:')) return att.data;
    const media = att.mediaType || 'image/png';
    return `data:${media};base64,${att.data}`;
  }
  // History reload: ledger keeps path-only refs under <session>/uploads/.
  const fileName = (att.path ? att.path.split(/[/\\]/).pop() : att.name) || '';
  if (!sid || !fileName) return null;
  return `/api/sessions/${encodeURIComponent(sid)}/uploads/${encodeURIComponent(fileName)}`;
}

/** Inline attachment strip — square thumbs; click opens a window-level lightbox. */
function UserAttachments({ attachments, sid }: { attachments: ChatAttachment[]; sid: string | null }) {
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    if (!preview) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPreview(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [preview]);

  return (
    <>
      <div className="user-att-strip">
        {attachments.map((att, i) => {
          const key = `${att.name ?? att.path ?? att.kind}-${i}`;
          if (att.kind === 'image') {
            const src = attachmentSrc(att, sid);
            if (!src) {
              return (
                <span key={key} className="user-att-file" title={att.name || att.path || 'image'}>
                  <span aria-hidden="true">🖼</span>
                  <span className="user-att-file-name">{att.name || 'image'}</span>
                </span>
              );
            }
            const alt = att.name || 'image';
            return (
              <button
                key={key}
                type="button"
                className="user-att-img-wrap"
                title={alt}
                aria-label={alt}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setPreview({ src, alt });
                }}
              >
                <img className="user-att-img" src={src} alt={alt} draggable={false} />
              </button>
            );
          }
          return (
            <span key={key} className="user-att-file" title={att.name || att.path}>
              <span aria-hidden="true">{att.kind === 'document' ? '📄' : '📎'}</span>
              <span className="user-att-file-name">{att.name || att.kind}</span>
            </span>
          );
        })}
      </div>
      {preview && createPortal(
        <div
          className="user-att-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={preview.alt}
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            className="user-att-lightbox-close"
            aria-label="Close"
            onClick={(e) => { e.stopPropagation(); setPreview(null); }}
          >
            <X size={18} strokeWidth={2} />
          </button>
          <img
            className="user-att-lightbox-img"
            src={preview.src}
            alt={preview.alt}
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body,
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
const capFirst = (s: string): string => (s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Day-divider label: '今天' / '昨天' for the two most recent days (greatly
// reduces eye-load in long sessions), then degrade to MM-DD same-year, then
// full YYYY-MM-DD for old archives. Mirrors formatTs's progressive disclosure.
function dayLabel(ms: number, now: number = Date.now()): string {
  const RTF = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
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

function SystemLine({ m, onExpand, navigationTarget, onNavigate }: { m: ChatMessage; onExpand?: () => void; navigationTarget?: string | null; onNavigate?: (agentId: string) => void }) {
  const { t } = useTranslation();
  const resolveName = useAgentNames();
  const isError = m.level === 'error';
  const isWarning = m.level === 'warning';
  const isIncoming = m.direction === 'incoming';
  const isOutgoing = m.direction === 'outgoing';
  // Inter-agent traffic (有 from + to) gets the "拍一拍" treatment: the emitter's
  // avatar replaces the emoji, and a pat phrase frames the from→to relationship.
  // 紫色派活 (source 含 user_input) = handoff; 蓝色回报 = task update.
  const isInterAgent = isAgentHandoff(m);
  const isHandoff = isInterAgent && (m.source ?? '').includes('user_input');
  const fromName = isInterAgent ? resolveName(m.from) : '';
  const toName = isInterAgent ? resolveName(m.to) : '';
  const patText = isInterAgent
    ? `${fromName} → ${toName} · ${getLocale() === 'zh' ? (isHandoff ? '交接任务' : '任务进展') : (isHandoff ? 'Task handoff' : 'Task update')}`
    : '';
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

  // Both delegation briefs and results start folded, regardless of the sender.
  if (isInterAgent) {
    return (
      <div className={cls} data-direction={m.direction} data-level={m.level} data-pat="1" data-expanded={open}>
        <div className="sys-body sys-pat-body">
          <div className="sys-pat-heading">
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
            {navigationTarget && onNavigate && <button
              type="button"
              className="sys-pat-navigate"
              title={t('taskFlow.goToSub', { name: resolveName(navigationTarget) || navigationTarget })}
              aria-label={t('taskFlow.goToSub', { name: resolveName(navigationTarget) || navigationTarget })}
              onClick={() => onNavigate(navigationTarget)}
            ><ArrowRight size={14} aria-hidden="true" /></button>}
          </div>
          {m.text.trim() && (
            <div className="sys-pat-content">
              <span className="sys-text">{open ? m.text.trim() : m.text.trim().split('\n')[0]}</span>
            </div>
          )}
          {m.text.trim() && (
            <div className="sys-pat-foot">
              <button
                type="button"
                className="sys-pat-toggle"
                aria-expanded={open}
                onClick={() => { if (!open) onExpand?.(); setOpen((v) => !v); }}
              >
                {open ? t('taskFlow.collapseHandoff') : t('taskFlow.expandHandoff')}
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

function HandoffFeed({ messages, currentAgent, onNavigate }: { messages: ChatMessage[]; sid: string; currentAgent: string | null; onNavigate: (agentId: string) => void }) {
  const { t } = useTranslation();
  const resolveName = useAgentNames();
  const zh = getLocale() === 'zh';
  const [limit, setLimit] = useState(20);
  const historyRef = useRef<HTMLDetailsElement>(null);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (saved) {
      const thread = historyRef.current?.closest('.cp-thread');
      if (thread) thread.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
      anchor.current = null;
    }
  }, [limit]);
  if (!messages.length) return null;
  return <>
    <details ref={historyRef} className="cp-collaboration-history">
    <summary>{t('taskFlow.handoffs')} · {messages.length} {getLocale() === 'zh' ? '条消息' : 'messages'}</summary>
    {messages.length > limit && <button type="button" className="cp-load-earlier" onClick={() => {
      const element = historyRef.current?.querySelector<HTMLElement>('.cp-handoff-log-entry');
      if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
      setLimit(value => value + 20);
    }}>{t('chat.loadEarlier.label', { count: messages.length - limit })}</button>}
    {messages.slice(-limit).map(message => {
      const target = handoffNavigationTarget(message, currentAgent);
      const label = message.source?.includes('user_input') ? (zh ? '派发任务' : 'Assigned task') : (zh ? '收到消息' : 'Message received');
      return <details className="cp-handoff-log-entry" key={message.id}>
        <summary><span>{resolveName(message.from ?? '') || message.from} → {resolveName(message.to ?? '') || message.to} · {label}</span><time>{new Date(message.ts).toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</time></summary>
        <div className="cp-handoff-log-body">
          <ForgeText text={message.text} animated={false} size="sm" />
          {target && <button type="button" className="cp-collaboration-toggle" onClick={() => onNavigate(target)}>{zh ? '查看角色对话' : 'View conversation'} <ArrowRight size={12} aria-hidden="true" /></button>}
        </div>
      </details>;
    })}
  </details></>;
}

export function ChatPanel() {
  const collaborationExpansion = useRef(new Map<string, boolean>());
  const resolveName = useAgentNames();
  const { t } = useTranslation();
  const host = useHost();
  const deliverActions = useMemo(
    () => createDeliverActions((id, args) => host.commands.execute(id, args)),
    [host],
  );
  const messages = useActiveMessages();
  const streamingByAgent = useActiveStreamingByAgent();
  const handoffMessages = useMemo(() => messages.filter(isAgentHandoff), [messages]);
  // The session's bound agent owns every turn it streams, so it is also the
  // default attribution for the round's tasks (`providerId` names the kernel,
  // not the persona).
  const ownerAgentId = useShellStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  const groupedUpdates = useMemo(() => collaborationUpdates(messages, ownerAgentId), [messages, ownerAgentId]);
  const mainMessages = useMemo(() => {
    const groupedIds = new Set(groupedUpdates.map(message => message.id));
    return messages.filter(message => !isAgentHandoff(message) && !groupedIds.has(message.id));
  }, [messages, groupedUpdates]);
  const projectionSid = useShellStore((s) => s.activeSid);
  const sessionTabs = useShellStore((s) => s.tabs);
  const knownSessionSidsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const current = new Set(sessionTabs.map((tab) => tab.sid));
    const previous = knownSessionSidsRef.current;
    if (previous) {
      for (const sid of previous) {
        if (!current.has(sid)) dropAskUserSession(sid);
      }
    }
    knownSessionSidsRef.current = current;
  }, [sessionTabs]);
  // Project the complete thread before applying the DOM render window. The
  // current UI consumes independent message/process/artifact items; legacy
  // Round parsing remains available only to old WAL fixtures.
  const taskFlowProjection = useMemo(
    () => projectWorkTimeline(messages, {
      ownerAgentId: ownerAgentId ?? undefined,
      sid: projectionSid ?? undefined,
    }),
    [messages, ownerAgentId, projectionSid],
  );
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
  // This stays local to the mounted chat surface. Composer owns the interaction
  // rules; sibling rewind editors consume the same value only to snapshot it
  // for their replacement message.
  const [summonAgentId, setSummonAgentId] = useState<string | null>(null);
  const [summonManual, setSummonManual] = useState(false);
  // Composer owns the visible agent catalog. A mutable ref lets sibling rewind
  // editors snapshot that same render-time resolution without an effect-shaped
  // interval where a vanished agent could still be sent.
  const resolvedSummonAgentIdRef = useRef<string | null>(null);
  const summonSelection = useMemo(() => ({
    summonAgentId,
    setSummonAgentId,
    summonManual,
    setSummonManual,
    resolvedSummonAgentIdRef,
  }), [summonAgentId, summonManual]);
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
  const scrollFollowRef = useRef<ReturnType<typeof createScrollFollow> | null>(null);
  // Resize/input listeners read the latest messages without reattaching on tokens.
  const scrollMessagesRef = useRef(messages);
  scrollMessagesRef.current = messages;
  const seenUnitsRef = useRef(new Map<string, number>());
  const lastUserMsgIdRef = useRef<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [following, setFollowing] = useState(true);
  // How many of the most recent message blocks to MOUNT (memleak case-02).
  // Grows by one window when the user scrolls to the top (上拉分页) and collapses
  // back to one window when they return to the live bottom — so DOM stays
  // bounded whether they leave or chat forever. History is never lost (it lives
  // in the store + ledger); only what React mounts is paged.
  const [renderLimit, setRenderLimit] = useState(MEMLEAK_CASE02_RENDER_WINDOW);
  const renderLimitRef = useRef(renderLimit);
  renderLimitRef.current = renderLimit;
  // Set right before a scroll-up page-load; consumed by a useLayoutEffect to
  // restore the scroll position after the older page mounts (anti-jump anchor).
  const topAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const scrollToBottom = () => {
    scrollFollowRef.current?.follow();
  };

  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const follower = createScrollFollow(el, {
      onUnpin: () => {
        setFollowing(false);
        seenUnitsRef.current = messageReadSnapshot(scrollMessagesRef.current);
        setUnread(0);
      },
      onBottom: () => {
        setFollowing(true);
        seenUnitsRef.current = messageReadSnapshot(scrollMessagesRef.current);
        setUnread(0);
        setRenderLimit(MEMLEAK_CASE02_RENDER_WINDOW);
      },
      onReadingScroll: () => {
        if (el.scrollTop >= MEMLEAK_CASE02_TOP_LOAD_PX || topAnchorRef.current) return;
        const count = scrollMessagesRef.current.length;
        if (count <= renderLimitRef.current) return;
        topAnchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
        setRenderLimit(Math.min(count, renderLimitRef.current + MEMLEAK_CASE02_RENDER_WINDOW));
      },
    });
    scrollFollowRef.current = follower;
    return () => {
      follower.dispose();
      scrollFollowRef.current = null;
    };
  }, []);

  // memleak case-02 — anti-jump anchor for scroll-up paging. After an older page
  // mounts (renderLimit grew via handleScroll/click), the thread got taller above
  // the viewport; offset scrollTop by exactly that growth so the message the user
  // was looking at stays put. No-op on initial mount / bottom-collapse (no anchor).
  useLayoutEffect(() => {
    const el = threadRef.current;
    const anchor = topAnchorRef.current;
    if (!el || !anchor) return;
    el.scrollTop = el.scrollHeight - anchor.prevHeight + anchor.prevTop;
    scrollFollowRef.current?.recordPosition();
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
  const activeSid = projectionSid;
  const {
    inSubAgentView,
    rootAgentId,
    activeAgentId,
    backToMain,
    openAgent,
  } = useAgentThreadNav();
  useAskUserThreadFocus(rootAgentId);
  const navigateHandoff = useCallback((agentId: string) => {
    openAgent(agentId);
    void openAgentWorkspace(agentId, { switchChat: false, fallback: 'none' });
  }, [openAgent]);
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
  const pendingPermission = usePendingPermission(activeSid);
  const peerMessages = useChatStore(state => activeSid ? state.bySid[activeSid]?.messagesByAgent : undefined);
  const collaboration = useMemo(() => {
    const waiting = Object.entries(peerMessages ?? {}).filter(([, rows]) => {
      const latest = rows.filter(row => row.role === 'assistant').at(-1);
      return latest?.status === 'streaming' && hasPendingAskUser([
        ...latest.toolCalls, ...(latest.segments?.flatMap(segment => segment.kind === 'tool' ? [segment.tool] : []) ?? []),
      ]);
    }).map(([agent]) => agent);
    return collaborationWork(messages, activeAgentId ?? rootAgentId, streamingByAgent, pendingPermission?.agent, waiting);
  }, [messages, activeAgentId, rootAgentId, streamingByAgent, pendingPermission?.agent, peerMessages]);
  const collaboratorCount = new Set(collaboration.filter(item => isCollaborationActive(item.status)).map(item => item.agent)).size;
  const latestAssistant = messages.filter((message) => message.role === 'assistant').at(-1);
  const waitingForAnswer = latestAssistant?.status === 'streaming' && hasPendingAskUser([
    ...latestAssistant.toolCalls,
    ...(latestAssistant.segments?.flatMap((segment) => segment.kind === 'tool' ? [segment.tool] : []) ?? []),
  ]);
  const showActivity = chatStreaming && !pendingPermission && !waitingForAnswer;
  // Only inspect this turn: completed turns must never lend a stale tool label.
  const activeTools = latestAssistant?.status === 'streaming'
    ? [...latestAssistant.toolCalls,
      ...(latestAssistant.segments?.flatMap((segment) => segment.kind === 'tool' ? [segment.tool] : []) ?? [])]
    : [];
  const latestRunningTool = activeTools.filter((tool) => tool.status === 'running').at(-1);
  const activityLabel = latestRunningTool
    ? `${t('taskFlow.processRunning')} · ${latestRunningTool.name.replace(/_/g, ' ')}`
    : collaboratorCount > 0
      ? (getLocale() === 'zh' ? `正在处理任务 · ${collaboratorCount} 位角色协作中` : `Working on the task · ${collaboratorCount} ${collaboratorCount === 1 ? 'collaborator' : 'collaborators'}`)
      : `${t('taskFlow.thinking')}…`;
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

  // A newly selected thread starts at its own live bottom, including agent
  // threads that have no user message to trigger the send-to-bottom path.
  useLayoutEffect(() => {
    topAnchorRef.current = null;
    lastUserMsgIdRef.current = null;
    setRenderLimit(MEMLEAK_CASE02_RENDER_WINDOW);
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSid, activeAgentId]);

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

    if (userJustSent || scrollFollowRef.current?.isPinned()) {
      // 2) 用户刚发新消息 → 永远回底部;3) 贴底跟随 → 跟随最新输出。
      scrollToBottom();
    } else {
      // 1) 已 unpin → 不打扰,按模型返回单元数累加 unread,由浮层提示。
      setUnread(unreadMessageCount(messages, seenUnitsRef.current));
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

  const visibleMessages = mainMessages.length > renderLimit ? mainMessages.slice(mainMessages.length - renderLimit) : mainMessages;
  const visibleIds = new Set(visibleMessages.map((message) => message.id));
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const visibleTimeline = taskFlowProjection.timeline.filter((item: WorkTimelineItem) => {
    if (item.kind === 'message') return visibleIds.has(item.messageId);
    if (item.kind === 'process') {
      const process = taskFlowProjection.processesById[item.processId];
      return (process?.sourceMessageIds ?? [process?.anchorMessageId ?? '']).some((id) => visibleIds.has(id));
    }
    return visibleIds.has(taskFlowProjection.artifactMessageIds[item.artifactId] ?? '');
  });
  // A process is owned by its Forge response. Keep that ownership in the
  // render tree instead of emitting the process as a top-level timeline row.
  // When paging hides the original anchor, attach it to the first still-visible
  // source message so the process remains inspectable with partial history.
  const hostedCompactionIds = new Set<string>();
  const processesByHostMessageId = new Map<string, typeof taskFlowProjection.processesById[string][]>();
  for (const item of visibleTimeline) {
    if (item.kind !== 'process') continue;
    const process = taskFlowProjection.processesById[item.processId];
    if (!process) continue;
    const visibleSources = (process.sourceMessageIds ?? []).filter((id) => visibleIds.has(id));
    const hostMessageId = process.anchorMessageId && visibleIds.has(process.anchorMessageId)
      ? process.anchorMessageId
      : visibleSources[0];
    if (!hostMessageId) continue;
    const hosted = processesByHostMessageId.get(hostMessageId) ?? [];
    const compactions = mainMessages.filter(message => message.role === 'system'
      && message.id.startsWith('compaction:') && !!message.turnId && message.turnId === process.turnId);
    compactions.forEach(message => hostedCompactionIds.add(message.id));
    hosted.push({ ...process, entries: [...process.entries, ...compactions.map(message => ({
      kind: 'lifecycle_status' as const, id: message.id, text: message.text, ts: message.ts,
    }))].sort((a, b) => a.ts - b.ts) });
    processesByHostMessageId.set(hostMessageId, hosted);
  }
  return (
    <SummonSelectionContext.Provider value={summonSelection}>
    <aside className="chat-panel chat-rail glass-subtle" data-testid="chat-panel">
      <nav className="cp-role-context" aria-label={getLocale() === 'zh' ? '当前对话角色' : 'Current conversation role'}>
        {inSubAgentView && <button type="button" onClick={backToMain} title={t('taskFlow.backToMain')} aria-label={t('taskFlow.backToMain')}><ArrowLeft size={14} aria-hidden="true" /><span>{t('taskFlow.backToMain')}</span></button>}
        <span>{resolveName(activeAgentId ?? rootAgentId) || 'Forge'}</span>
        <span className="cp-role-context-kind">{getLocale() === 'zh' ? (inSubAgentView ? '子角色对话' : '主对话') : (inSubAgentView ? 'Specialist conversation' : 'Main conversation')}</span>
      </nav>
      <div className="cp-body">
        <ChatAgentCapsule />

        <div className="cp-thread thin-scrollbar" ref={threadRef} tabIndex={0}>
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

        {mainMessages.length > renderLimit && (
          <button
            className="cp-load-earlier"
            onClick={() => {
              scrollFollowRef.current?.pause();
              const el = threadRef.current;
              if (el) topAnchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
              setRenderLimit((n) => Math.min(mainMessages.length, n + MEMLEAK_CASE02_RENDER_WINDOW));
            }}
            title={t('chat.loadEarlier.tooltip')}
          >
            ↑ {t('chat.loadEarlier.label', { count: mainMessages.length - renderLimit })}
          </button>
        )}

        {visibleTimeline.map((timelineItem) => {
          if (timelineItem.kind === 'process') {
            // Rendered inside the owning ForgeCard below.
            return null;
          }
          if (timelineItem.kind === 'artifact') {
            const artifact = taskFlowProjection.artifactsById[timelineItem.artifactId];
            if (!artifact) return null;
            return (
              <ArtifactCard
                key={`artifact-${artifact.id}`}
                artifact={artifact}
                timestamp={(() => {
                  const hostMessageId = taskFlowProjection.artifactMessageIds[artifact.id];
                  const hostMessage = hostMessageId ? messageById.get(hostMessageId) : undefined;
                  return hostMessage ? formatTs(hostMessage.ts) : undefined;
                })()}
                onReveal={deliverActions.onReveal}
                onNext={deliverActions.onNext}
              />
            );
          }
          const m = messageById.get(timelineItem.messageId);
          if (!m || hostedCompactionIds.has(m.id)) return null;
          const view = visibleMessages;
          const idx = view.findIndex((message) => message.id === m.id);
          const prev = idx > 0 ? view[idx - 1] : null;
          const showDivider = !prev || !sameDay(prev.ts, m.ts);
          // checkpoint:绝对下标(分页 slice 偏移)→ 是否落在被回退置灰区。
          const absIdx = messages.indexOf(m);
          // Cursor 软回退:目标消息原地变编辑框(isEditTarget),它**之后**的
          // 消息变灰(isRewound 严格 > 目标)。
          const isEditTarget = rewoundFromIdx >= 0 && absIdx === rewoundFromIdx;
          const isRewound = rewoundFromIdx >= 0 && absIdx > rewoundFromIdx;
          // 编辑态目标:点气泡进入,渲染 BubbleEditInline(发送时按需弹回退确认)。
          const isLocalEditTarget = m.role === 'user' && !!editingMsgId && m.msgId === editingMsgId;
          const canRewindHere =
            m.role === 'user' && !!m.msgId && checkpointMsgIds?.[m.msgId] !== undefined
            && !isRewound && !isEditTarget && m.msgId !== editingMsgId;
          const projectedSegments = m.role === 'assistant' && m.segments
            ? m.segments.filter((segment, index) => timelineItem.segmentIndexes.includes(index)
              && (segment.kind !== 'thinking' || segment.visibility === 'public_summary'))
            : m.segments;
          const projectedText = projectedSegments
            ?.filter((segment) => segment.kind === 'text')
            .map((segment) => segment.kind === 'text' ? segment.text : '')
            .join('') ?? m.text;
          const projectedTools = projectedSegments
            ?.filter((segment) => segment.kind === 'tool')
            .map((segment) => segment.kind === 'tool' ? segment.tool : null)
            .filter((tool): tool is NonNullable<typeof tool> => tool !== null) ?? m.toolCalls;
          // When an assistant message's task-flow content was projected into a
          // round, the leftover message item can be an empty shell (e.g. a
          // delegation turn whose thinking wasn't consumed): no projected text,
          // no projected tools, no sub-agents. Skip it — the round already
          // renders its content, so rendering the shell shows a bare THOUGHT card.
          const projectedRemnant = m.role === 'assistant' && m.segments !== undefined
            && isProjectedRemnant({
              status: m.status,
              segmentCount: m.segments.length,
              projectedSegmentCount: timelineItem.segmentIndexes?.length ?? 0,
              projectedText,
              projectedToolCount: projectedTools?.length ?? 0,
              subAgentCount: Object.keys(m.subAgents ?? {}).length,
              // An empty segment shell can still be the intentional owner of a
              // ProcessAccordion. Dropping it also drops Worked-for and every
              // Todo/process entry nested inside it.
              ownsProcess: processesByHostMessageId.has(m.id),
            });
          if (projectedRemnant) return null;
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
                    <PillText text={
                      m.attachments?.length
                      && (m.text === '(see attached file)' || !m.text.trim())
                        ? ''
                        : m.text
                    } />
                    {m.attachments && m.attachments.length > 0 && (
                      <UserAttachments attachments={m.attachments} sid={activeSid} />
                    )}
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
                  {(m as DelegationMessage).delegation
                    ? <DelegationCard snapshot={(m as DelegationMessage).delegation!} text={m.text} />
                    : <SystemLine m={m} />}
                </div>
              ) : (
                <div className={`msg-block${isRewound ? ' is-rewound' : ''}`}>
                  <ForgeCard
                    status={m.status === 'streaming' ? 'running' : m.status === 'error' ? 'error' : 'done'}
                    text={projectedText}
                    // Raw provider reasoning is fail-closed. Public summaries
                    // are projected into ProcessAccordion, never duplicated in
                    // the final assistant message.
                    thought={undefined}
                    thoughtCollapsed
                    activityTools={[...m.toolCalls, ...(m.segments?.flatMap(segment => segment.kind === 'tool' ? [segment.tool] : []) ?? [])]}
                    toolCalls={projectedTools}
                    segments={projectedSegments}
                    subAgents={m.subAgents}
                    errorMessage={m.errorMessage}
                    failureContinuation={m.errorMessage ? failureContinuation(
                      mainMessages.slice(mainMessages.indexOf(m) + 1).filter(message => message.role === 'assistant').map(message => message.status),
                      Boolean(activeAgentId ?? rootAgentId) && Object.entries(streamingByAgent).some(([agentId, running]) => running && agentId !== (activeAgentId ?? rootAgentId)),
                    ) : undefined}
                    providerId={m.providerId}
                    cost={m.cost}
                    durationMs={m.durationMs}
                    agentName={activeAgentId ?? undefined}
                    timestamp={formatTs(m.ts)}
                    sid={activeSid ?? undefined}
                    agentId={activeAgentId ?? undefined}
                    processInsertAt={(() => {
                      const hosted = processesByHostMessageId.get(m.id);
                      if (!hosted?.length || !m.segments?.length) return undefined;
                      const processCallIds = new Set(hosted.flatMap((process) => process.entries.flatMap((entry) =>
                        entry.kind === 'tool' || entry.kind === 'todo_snapshot'
                          ? [entry.kind === 'tool' ? entry.step.id : entry.id.slice('todo:'.length)]
                          : [])));
                      const processTextIndexes = new Set(hosted.flatMap((process) => process.entries.flatMap((entry) => {
                        const prefix = `${entry.kind === 'thinking_summary' ? 'thinking' : 'text'}:${m.id}:`;
                        if ((entry.kind === 'thinking_summary' || entry.kind === 'assistant_intermediate') && entry.id.startsWith(prefix)) {
                          const index = Number(entry.id.slice(prefix.length));
                          return Number.isInteger(index) ? [index] : [];
                        }
                        return [];
                      })));
                      const anchor = m.segments.findIndex((segment, index) =>
                        processTextIndexes.has(index)
                        || (segment.kind === 'tool' && processCallIds.has(segment.tool.callId)));
                      // Ask User may suspend the kernel and resume the same
                      // logical turn in a later provider message.  In that
                      // case the hosted process has no segment anchor in the
                      // original Ask message.  Keep the answered Ask cards in
                      // front of the resumed execution instead of hoisting the
                      // Process block above them.
                      if (anchor < 0) return (timelineItem.segmentIndexes ?? []).length;
                      return (timelineItem.segmentIndexes ?? []).filter((index) => index < anchor).length;
                    })()}
                    processContent={processesByHostMessageId.get(m.id)?.map((process) => {
                      const turn = taskFlowProjection.turnsById[process.id];
                      const hasArtifact = (turn?.artifactIds ?? []).some(
                        (artifactId) => !!taskFlowProjection.artifactsById[artifactId],
                      );
                      return <ProcessAccordion key={`process-${process.id}`} process={process} hasArtifact={hasArtifact} />;
                    })}
                  />
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
        {/* Approval belongs to the scrollable conversation, not the composer
            dock. Keep it outside collapsed execution/handoff groups. */}
        <PermissionPrompt />
      {(collaboration.length > 0 || handoffMessages.length > 0) && <CollaborationDock key={`${activeSid}:${activeAgentId}`} work={collaboration} updates={groupedUpdates} onNavigate={navigateHandoff}
        initialExpanded={collaborationExpansion.current.get(JSON.stringify([activeSid, activeAgentId ?? rootAgentId])) ?? false}
        onExpandedChange={open => { collaborationExpansion.current.set(JSON.stringify([activeSid, activeAgentId ?? rootAgentId]), open); }}
        history={handoffMessages.length > 0 ? <HandoffFeed sid={activeSid ?? ''} messages={handoffMessages} currentAgent={activeAgentId ?? rootAgentId} onNavigate={navigateHandoff} /> : undefined} /> }
        </div>

        {(unread > 0 || (pendingPermission && !following)) && (
          <button
            className="cp-jump-latest"
            onClick={() => scrollToBottom()}
            title={t('chat.jumpLatest.tooltip')}
          >
            <ArrowDown size={13} strokeWidth={2.4} />
            <span>{pendingPermission
              ? t('permission.commandAriaLabel')
              : t('chat.jumpLatest.unread', { count: unread })}</span>
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
      {showActivity && (
        <div className="cp-live-activity" role="status" aria-live="polite" aria-atomic="true">
          <span className="cp-live-activity-label" title={activityLabel}>{activityLabel}</span>
        </div>
      )}
      <Composer
        highlight={showFirstHint}
        delegatedWorkRunning={hasRunningHandoff(handoffMessages, activeAgentId ?? rootAgentId, streamingByAgent)}
        specialistSummonEnabled={canSummonSpecialistFromActiveThread(activeAgentId, rootAgentId)}
      />
    </aside>
    </SummonSelectionContext.Provider>
  );
}
