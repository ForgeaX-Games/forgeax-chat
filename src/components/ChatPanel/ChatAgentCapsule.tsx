import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import { workbenchAgentsUrl } from '@forgeax/interface/lib/workbench-lang';
import { useShellStore } from '@forgeax/interface/store';
import { useBusSnapshot } from '@forgeax/interface/lib/use-bus-snapshot';
import { publish } from '@forgeax/interface/lib/bus';
import { useActiveStreamingByAgent } from '../../session-store';
import { onSessionEvent } from '../../session-bridge';
import { AgentAvatarVideo } from '@forgeax/ai-workbench/components/AgentAvatarVideo/AgentAvatarVideo';
import { resolveNaming } from '@forgeax/ai-workbench/lib/agent-name';

type WorkbenchAgent = {
  id: string;
  name: string;
  role: string;
  status?: string;
  isMain?: boolean;
  naming?: { title: string; sub: string };
};

const EMPTY_UNINSTALLED: string[] = [];
const MAX_PAGE_SIZE = 5;
const MIN_PAGE_SIZE = 2;
const HOVER_AGENT_SLOT_PX = 70;
const HOVER_CAPSULE_CHROME_PX = 56;
const WHEEL_DELTA_MIN = 15;
const DRAG_PAGE_THRESHOLD_PX = 36;
const DRAG_CAPTURE_THRESHOLD_PX = 6;
const WHEEL_COOLDOWN_MS = 280;
const EDGE_HOVER_ZONE_PX = 38;
const EDGE_AUTO_PAGE_DELAY_MS = 880;
const EDGE_AUTO_PAGE_INTERVAL_MS = 1500;
const PAGE_ANIMATION_MS = 320;

// ── "拍了拍你" 气泡 —— agent 回复完成后, 胶囊下方冒一条简短趣味文案, 维持 5s 消失 ──
const PAT_BUBBLE_HOLD_MS = 5000;
const PAT_BUBBLE_EXIT_MS = 280; // 跟 CSS transition 时长对齐, 退场后再 unmount
// 刚把活交给别人后这个窗口内, active agent 的 turnEnd 不再弹"拍了拍你"(让 handoff 气泡接管).
const HANDOFF_SUPPRESS_SELF_MS = 6000;

const PAT_ACTIONS = [
  '丢给你一颗糖',
  '塞给你一杯热咖啡',
  '比了个耶',
  '偷偷给你点了个赞',
  '递上一张小纸条',
  '蹭了蹭你',
  '送你一朵小红花',
  '悄悄把 bug 藏了起来',
  '跟你击了个掌',
  '摸了摸你的头',
  '递来一块小饼干',
  '朝你眨了眨眼',
  '变了个小魔术',
  '塞了个彩蛋给你',
  '给你比了个心',
  '打了个响指',
  '递给你一杯快乐水',
  '帮你把摸鱼藏好了',
];

// agent → agent 流转任务时的趣味后缀.
const PAT_HANDOFF_ACTIONS = [
  '把接力棒递了过去',
  '甩给 ta 一个大活',
  '托付了重任',
  '把摊子交给了 ta',
  '说了句"交给你了"',
  '把键盘推了过去',
  '附赠一句加油',
  '拜托 ta 接着干',
  '移交了作战指挥权',
  '把任务卡塞了过去',
  '比了个"靠你了"的手势',
  '顺手丢了个锅',
];

function randomPatAction(): string {
  return PAT_ACTIONS[Math.floor(Math.random() * PAT_ACTIONS.length)]!;
}

function randomHandoffAction(): string {
  return PAT_HANDOFF_ACTIONS[Math.floor(Math.random() * PAT_HANDOFF_ACTIONS.length)]!;
}

/** agent 引用 (path / fullId) → 末段 base id, 去掉 "forge/" 前缀和 "#1" 实例后缀. */
function tailOf(ref: string): string {
  const last = ref.split('/').pop() ?? ref;
  return last.split('#')[0] ?? last;
}

function pageSizeForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MAX_PAGE_SIZE;
  const availableSlots = Math.floor((width - HOVER_CAPSULE_CHROME_PX) / HOVER_AGENT_SLOT_PX);
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, availableSlots));
}

function handleFor(id: string): string {
  if (id.includes('cc-coder')) return 'cc-coder';
  return id.split('-')[0] ?? id;
}
function initialFor(id: string): string {
  const handle = handleFor(id);
  const parts = handle.split(/[-_.]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return handle.slice(0, 2).toUpperCase();
}

/**
 * Horizontal facepile strip — shows up to PAGE_SIZE agents at a time.
 * When there are more agents, hover reveals left/right pagination arrows,
 * a page-dot indicator, and wheel / horizontal-drag paging on the strip.
 *
 * States:
 *   • hover    → avatar scales up, name slides in below (CSS only, zero JS)
 *   • loading  → spinning ring overlaid on the avatar while that agent streams
 *   • unread   → red dot in corner when a non-active agent receives new output
 *   • selected → 2px brand-color border on the avatar circle
 *
 * TODO (ADR-0019 §9, P5): collapse same-portrait agents into one "group head"
 * capsule + click-down popover. Today the catalog returns ≥4 capsules sharing
 * the "通用 coder" placeholder portrait (cc-coder / claude-code-default /
 * codex-default / cursor-default / kaede / kumo / mochi / rin / sakura) and
 * ≥5 sharing "Iro" (iro / mira / animator-2d / character-designer-2d /
 * vfx-artist-3d / lowpoly), which is visual noise. P5 will keep this file's
 * logic untouched except for an extra fold step over `visibleAgents` before
 * `pagedAgents`. Config lives in a new `agent-groups.ts`; server / store /
 * setTabAgent semantics stay untouched. See ADR-0019 §9 for the membership
 * table and full constraints.
 */
export function ChatAgentCapsule() {
  const { t, i18n } = useTranslation();
  const activeSid = useShellStore((s) => s.activeSid);
  const tabs = useShellStore((s) => s.tabs);
  const setTabAgent = useShellStore((s) => s.setTabAgent);
  // ① agent 安装偏好来自 settings（bus 'prefs:agents'）—— chat 只读，零 import settings。
  const prefs = useBusSnapshot('prefs:agents') as
    | { uninstalledAgentIds?: string[]; defaultBootstrapAgent?: string | null }
    | undefined;
  const uninstalledIds = prefs?.uninstalledAgentIds ?? EMPTY_UNINSTALLED;
  const defaultBootstrap = prefs?.defaultBootstrapAgent ?? null;
  const activeAgentId = tabs.find((t) => t.sid === activeSid)?.agentId ?? null;

  const streamingByAgent = useActiveStreamingByAgent();

  const [agents, setAgents] = useState<WorkbenchAgent[]>([]);
  const [unreadAgents, setUnreadAgents] = useState<Set<string>>(new Set());
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(MAX_PAGE_SIZE);
  const [wrapHovered, setWrapHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverEdge, setHoverEdge] = useState<'prev' | 'next' | null>(null);
  const [pageMotion, setPageMotion] = useState<'prev' | 'next' | null>(null);
  // "拍了拍你" 气泡: text 决定内容, show 决定进/退场 class, tailX 决定尖角横向位置.
  const [patBubble, setPatBubble] = useState<{ text: string; id: number } | null>(null);
  const [patShown, setPatShown] = useState(false);
  const [patTailX, setPatTailX] = useState(24);
  // 追踪 active agent 上一次的 streaming 态 (带 agentId, 避免切 agent 时误判 true→false).
  const prevActiveStreamingRef = useRef<{ id: string | null; streaming: boolean }>({
    id: null,
    streaming: false,
  });
  const patHideTimerRef = useRef<number | null>(null);
  const patRemoveTimerRef = useRef<number | null>(null);
  // 最近一次"派活"的发起者 + 时间, 用于抑制紧随其后的 self-pat.
  const recentHandoffFromRef = useRef<{ id: string; ts: number } | null>(null);
  // 去重: 同一条 handoff 事件 (两条 ledger 可能各触发一次) 只弹一次.
  const lastHandoffKeyRef = useRef<string | null>(null);
  const prevStreamingRef = useRef<Record<string, boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const wheelCooldownRef = useRef(false);
  const edgeAutoDelayRef = useRef<number | null>(null);
  const edgeAutoIntervalRef = useRef<number | null>(null);
  const pageMotionTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    pointerId: number;
    captured: boolean;
  } | null>(null);

  const manifestMainId = agents.find((a) => a.isMain)?.id ?? null;
  const effectiveMainId = defaultBootstrap ?? manifestMainId;
  const activePriorityKey = useMemo(() => {
    const working = Object.entries(streamingByAgent)
      .filter(([, running]) => running)
      .map(([agentId]) => agentId)
      .sort()
      .join('|');
    const unread = [...unreadAgents].sort().join('|');
    return `${activeAgentId ?? ''}::${working}::${unread}`;
  }, [activeAgentId, streamingByAgent, unreadAgents]);
  const visibleAgents = useMemo(() => {
    const priorityScore = (agent: WorkbenchAgent): number => {
      if (agent.id === activeAgentId && streamingByAgent[agent.id]) return 0;
      if (streamingByAgent[agent.id]) return 1;
      if (agent.id === activeAgentId) return 2;
      if (unreadAgents.has(agent.id)) return 3;
      if (agent.id === effectiveMainId) return 4;
      return 5;
    };
    return agents
      .filter((a) => !uninstalledIds.includes(a.id) || a.id === activeAgentId)
      .map((agent, index) => ({ agent, index }))
      .sort((a, b) => {
        const score = priorityScore(a.agent) - priorityScore(b.agent);
        if (score !== 0) return score;
        return a.index - b.index;
      })
      .map(({ agent }) => agent);
  }, [agents, activeAgentId, effectiveMainId, streamingByAgent, uninstalledIds, unreadAgents]);

  const totalPages = Math.ceil(visibleAgents.length / pageSize) || 1;
  const needsPaging = visibleAgents.length > pageSize;
  const clampedPage = Math.min(pageIndex, totalPages - 1);
  const pagedAgents = visibleAgents.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);
  const hasPrev = clampedPage > 0;
  const hasNext = clampedPage < totalPages - 1;

  const updateHoverEdgeFromPoint = (clientX: number) => {
    if (!needsPaging || dragging) {
      setHoverEdge(null);
      return;
    }
    const capsule = wrapRef.current?.querySelector<HTMLElement>('.chat-agent-capsule');
    if (!capsule) return;
    const rect = capsule.getBoundingClientRect();
    const edgeWidth = Math.min(EDGE_HOVER_ZONE_PX, rect.width * 0.28);
    if (clientX - rect.left <= edgeWidth) {
      setHoverEdge(hasPrev ? 'prev' : null);
      return;
    }
    if (rect.right - clientX <= edgeWidth) {
      setHoverEdge(hasNext ? 'next' : null);
      return;
    }
    setHoverEdge(null);
  };

  const changePage = (dir: 1 | -1) => {
    setPageMotion(dir > 0 ? 'next' : 'prev');
    if (pageMotionTimerRef.current !== null) window.clearTimeout(pageMotionTimerRef.current);
    pageMotionTimerRef.current = window.setTimeout(() => {
      setPageMotion(null);
      pageMotionTimerRef.current = null;
    }, PAGE_ANIMATION_MS);
    setPageIndex((p) => Math.min(totalPages - 1, Math.max(0, p + dir)));
  };

  const resetPageToActiveAgent = () => {
    if (!activeAgentId) {
      setPageIndex(0);
      return;
    }
    const idx = visibleAgents.findIndex((a) => a.id === activeAgentId);
    setPageIndex(idx === -1 ? 0 : Math.floor(idx / pageSize));
  };

  useEffect(() => () => {
    if (pageMotionTimerRef.current !== null) window.clearTimeout(pageMotionTimerRef.current);
    if (edgeAutoDelayRef.current !== null) window.clearTimeout(edgeAutoDelayRef.current);
    if (edgeAutoIntervalRef.current !== null) window.clearInterval(edgeAutoIntervalRef.current);
  }, []);

  useEffect(() => {
    const host = wrapRef.current?.parentElement;
    if (!host) return;
    const update = (width: number) => {
      setPageSize((current) => {
        const next = pageSizeForWidth(width);
        return next === current ? current : next;
      });
    };
    update(host.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(workbenchAgentsUrl())
      .then((r) => r.json())
      .then((j: { agents?: WorkbenchAgent[] }) => {
        if (cancelled) return;
        const list = j.agents ?? [];
        const main = list.find((a) => a.isMain)?.id;
        // ① 首跑 seed：把 agent 列表发给 settings owner（bus 命令）。owner 未初始化则 no-op。
        publish('prefs:seed', { allIds: list.map((a) => a.id), mainId: main } as never);
        setAgents(list);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [i18n.language]);

  // When the active agent changes, jump to the page that contains it.
  useEffect(() => {
    if (!activeAgentId) return;
    const idx = visibleAgents.findIndex((a) => a.id === activeAgentId);
    if (idx === -1) return;
    setPageIndex(Math.floor(idx / pageSize));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId, pageSize]);

  // Active / working / unread agents are promoted to the front; keep that new
  // priority visible instead of leaving the strip on a stale later page.
  useEffect(() => {
    if (visibleAgents.length === 0) return;
    setPageIndex(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePriorityKey, pageSize]);

  // When a non-active agent transitions from idle → streaming, mark it unread.
  useEffect(() => {
    const prev = prevStreamingRef.current;
    for (const [agentId, isStreaming] of Object.entries(streamingByAgent)) {
      if (isStreaming && !prev[agentId] && agentId !== activeAgentId) {
        setUnreadAgents((s) => new Set([...s, agentId]));
      }
    }
    prevStreamingRef.current = { ...streamingByAgent };
  }, [streamingByAgent, activeAgentId]);

  // 尖角对准胶囊里第一个 (可见) 头像的横向中心, 相对 wrap (= 气泡左边缘) 的偏移.
  const measurePatTail = useCallback(() => {
    const wrapEl = wrapRef.current;
    const firstAvatar = wrapEl?.querySelector<HTMLElement>('.cas-btn .cas-avatar-wrap');
    if (!wrapEl || !firstAvatar) return;
    const wr = wrapEl.getBoundingClientRect();
    const ar = firstAvatar.getBoundingClientRect();
    setPatTailX(ar.left - wr.left + ar.width / 2);
  }, []);

  // 弹出一条气泡 (两种状态共用同一槽位 → 永不并存); 测尖角 → 显示 → 5s 退场 → unmount.
  const showPatBubble = useCallback((text: string) => {
    if (patHideTimerRef.current !== null) window.clearTimeout(patHideTimerRef.current);
    if (patRemoveTimerRef.current !== null) window.clearTimeout(patRemoveTimerRef.current);
    measurePatTail();
    setPatBubble({ text, id: Date.now() });
    setPatShown(true);
    patHideTimerRef.current = window.setTimeout(() => {
      setPatShown(false);
      patRemoveTimerRef.current = window.setTimeout(() => setPatBubble(null), PAT_BUBBLE_EXIT_MS);
    }, PAT_BUBBLE_HOLD_MS);
  }, [measurePatTail]);

  // 状态①: active agent 回复结束 (streaming true→false) → "XX拍了拍你，并XX".
  useEffect(() => {
    const cur = activeAgentId ? !!streamingByAgent[activeAgentId] : false;
    const prev = prevActiveStreamingRef.current;
    prevActiveStreamingRef.current = { id: activeAgentId, streaming: cur };
    // 切 agent 那一拍只记录基线, 不触发 (否则从一个正在跑的 agent 切走会误判完成).
    if (prev.id !== activeAgentId) return;
    if (!(prev.streaming && !cur && activeAgentId)) return;
    // 刚把活交给别的 agent → 由 handoff 气泡接管, 不再弹"拍了拍你".
    const ho = recentHandoffFromRef.current;
    if (ho && ho.id === activeAgentId && Date.now() - ho.ts < HANDOFF_SUPPRESS_SELF_MS) return;

    const name = agents.find((a) => a.id === activeAgentId)?.name ?? handleFor(activeAgentId);
    showPatBubble(`${name}拍了拍你，并${randomPatAction()}`);
  }, [streamingByAgent, activeAgentId, agents, showPatBubble]);

  // 状态②: agent 把任务流转给另一个 agent (inter-agent user_input) → "XX拍了拍XX，并XX".
  useEffect(() => {
    if (!activeSid) return;
    const resolveName = (ref: string): string => {
      const tail = tailOf(ref);
      const hit = agents.find((a) => a.id === tail || handleFor(a.id) === tail);
      return hit?.name ?? tail;
    };
    return onSessionEvent('chat-agent-capsule-pat', (msg) => {
      if (msg.sid !== activeSid) return;
      const ev = msg.event;
      if (ev.type !== 'user_input' || ev.source !== 'agent') return;
      const from = msg.emitterId ?? '';
      const to = typeof ev.to === 'string' ? ev.to : '';
      if (!from || !to) return;
      if ((ev.payload as { narrativeAutoNudge?: boolean })?.narrativeAutoNudge) return;
      const fromTail = tailOf(from);
      const toTail = tailOf(to);
      if (!fromTail || !toTail || fromTail === toTail) return;
      const key = `${from}->${to}@${ev.ts}`;
      if (lastHandoffKeyRef.current === key) return; // 同一事件去重
      lastHandoffKeyRef.current = key;
      recentHandoffFromRef.current = { id: fromTail, ts: Date.now() };
      showPatBubble(`${resolveName(from)}拍了拍${resolveName(to)}，并${randomHandoffAction()}`);
    });
  }, [activeSid, agents, showPatBubble]);

  // 气泡显示期间, 让尖角实时跟随第一个头像 (hover 放大 / resize / 分页都会改变
  // wrap 尺寸 → ResizeObserver 逐帧回调重测; 再补一个 window resize 兜底).
  useEffect(() => {
    if (!patBubble) return;
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    measurePatTail();
    const ro = new ResizeObserver(() => measurePatTail());
    ro.observe(wrapEl);
    const capsule = wrapEl.querySelector<HTMLElement>('.chat-agent-capsule');
    if (capsule) ro.observe(capsule);
    window.addEventListener('resize', measurePatTail);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measurePatTail);
    };
  }, [patBubble, wrapHovered, measurePatTail]);

  // 卸载时清掉气泡定时器.
  useEffect(() => () => {
    if (patHideTimerRef.current !== null) window.clearTimeout(patHideTimerRef.current);
    if (patRemoveTimerRef.current !== null) window.clearTimeout(patRemoveTimerRef.current);
  }, []);

  // Clear unread badge the moment the user switches to that agent.
  useEffect(() => {
    if (!activeAgentId) return;
    setUnreadAgents((prev) => {
      if (!prev.has(activeAgentId)) return prev;
      const next = new Set(prev);
      next.delete(activeAgentId);
      return next;
    });
  }, [activeAgentId]);

  // Wheel + horizontal drag to paginate while the strip is hovered.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !needsPaging || !wrapHovered) return;

    const maxPage = Math.max(0, Math.ceil(visibleAgents.length / pageSize) - 1);

    const step = (dir: 1 | -1) => {
      setPageMotion(dir > 0 ? 'next' : 'prev');
      if (pageMotionTimerRef.current !== null) window.clearTimeout(pageMotionTimerRef.current);
      pageMotionTimerRef.current = window.setTimeout(() => {
        setPageMotion(null);
        pageMotionTimerRef.current = null;
      }, PAGE_ANIMATION_MS);
      setPageIndex((p) => Math.min(maxPage, Math.max(0, p + dir)));
    };

    const onWheel = (e: WheelEvent) => {
      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < WHEEL_DELTA_MIN) return;
      e.preventDefault();
      if (wheelCooldownRef.current) return;
      wheelCooldownRef.current = true;
      window.setTimeout(() => {
        wheelCooldownRef.current = false;
      }, WHEEL_COOLDOWN_MS);
      step(delta > 0 ? 1 : -1);
    };

    const clearDrag = (pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      if (drag.captured && el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
      dragRef.current = null;
      setDragging(false);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Never steal clicks from chevrons or agent tabs.
      const target = e.target as HTMLElement;
      if (target.closest('.cas-nav-btn, .cas-btn')) return;
      dragRef.current = {
        active: true,
        startX: e.clientX,
        pointerId: e.pointerId,
        captured: false,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag?.active || drag.pointerId !== e.pointerId || drag.captured) return;
      if (Math.abs(e.clientX - drag.startX) < DRAG_CAPTURE_THRESHOLD_PX) return;
      drag.captured = true;
      setDragging(true);
      el.setPointerCapture(e.pointerId);
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag?.active || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      clearDrag(e.pointerId);
      if (!drag.captured) return;
      if (dx <= -DRAG_PAGE_THRESHOLD_PX) step(1);
      else if (dx >= DRAG_PAGE_THRESHOLD_PX) step(-1);
    };

    const onPointerCancel = (e: PointerEvent) => {
      clearDrag(e.pointerId);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [needsPaging, wrapHovered, visibleAgents.length, pageSize]);

  useEffect(() => {
    if (!needsPaging || !hoverEdge || dragging) return;
    if (hoverEdge === 'prev' && !hasPrev) return;
    if (hoverEdge === 'next' && !hasNext) return;
    const dir = hoverEdge === 'next' ? 1 : -1;
    const step = () => {
      changePage(dir);
    };
    edgeAutoDelayRef.current = window.setTimeout(() => {
      step();
      edgeAutoIntervalRef.current = window.setInterval(step, EDGE_AUTO_PAGE_INTERVAL_MS);
    }, EDGE_AUTO_PAGE_DELAY_MS);
    return () => {
      if (edgeAutoDelayRef.current !== null) window.clearTimeout(edgeAutoDelayRef.current);
      if (edgeAutoIntervalRef.current !== null) window.clearInterval(edgeAutoIntervalRef.current);
      edgeAutoDelayRef.current = null;
      edgeAutoIntervalRef.current = null;
    };
  }, [needsPaging, hoverEdge, dragging, hasPrev, hasNext, totalPages]);

  return (
    <div
      ref={wrapRef}
      className={[
        'chat-agent-capsule-wrap',
        needsPaging && 'has-paging',
        dragging && 'is-paging-drag',
        hoverEdge === 'prev' && 'is-edge-hover-prev',
        hoverEdge === 'next' && 'is-edge-hover-next',
        pageMotion === 'prev' && 'is-page-motion-prev',
        pageMotion === 'next' && 'is-page-motion-next',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseEnter={(event) => {
        setWrapHovered(true);
        updateHoverEdgeFromPoint(event.clientX);
      }}
      onMouseMove={(event) => updateHoverEdgeFromPoint(event.clientX)}
      onMouseLeave={() => {
        setWrapHovered(false);
        setHoverEdge(null);
        if (edgeAutoDelayRef.current !== null) window.clearTimeout(edgeAutoDelayRef.current);
        if (edgeAutoIntervalRef.current !== null) window.clearInterval(edgeAutoIntervalRef.current);
        edgeAutoDelayRef.current = null;
        edgeAutoIntervalRef.current = null;
        dragRef.current = null;
        setDragging(false);
        resetPageToActiveAgent();
      }}
    >
      <div className="cas-hover-moat" aria-hidden="true" />
      <div className="chat-agent-capsule" role="tablist" aria-label="Agents">
        {needsPaging && (
          <button
            type="button"
            className={['cas-nav-btn cas-nav-prev', !hasPrev && 'is-disabled'].filter(Boolean).join(' ')}
            aria-label={t('chatAgentCapsule.prevPage')}
            disabled={!hasPrev}
            onClick={() => changePage(-1)}
          >
            ‹
          </button>
        )}
        {pagedAgents.map((a) => {
          const selected = a.id === activeAgentId;
          const isLoading = !!streamingByAgent[a.id];
          const isUnread = !selected && unreadAgents.has(a.id);
          const agentTitle = resolveNaming(a).title;
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={[
                'cas-btn',
                selected && 'is-selected',
                isLoading && 'is-loading',
                isUnread && 'is-unread',
              ]
                .filter(Boolean)
                .join(' ')}
              title={agentTitle}
              onClick={() => {
                if (activeSid) setTabAgent(activeSid, a.id);
              }}
            >
              <span className="cas-avatar-wrap">
                {/* ADR-0019: WEBM 状态机优先; 没 avatarRules 的 agent (老 SVG/initial 路径)
                 *  自动 fall back 到原来的 initials span. 不传 className=cas-avatar 给
                 *  AgentAvatarVideo —— .cas-avatar 的 position:absolute/inset:0 跟组件
                 *  内联 width 冲突会让头像歪. wrap 控制大小, 组件 absolute inset:0 填满
                 *  (CSS 里 .cas-avatar-wrap > .agent-avatar-video 做的). */}
                <AgentAvatarVideo
                  agentId={a.id}
                  mode="conversational"
                  shape="circle"
                  fallback={
                    <span className="cas-avatar" aria-hidden>
                      {initialFor(a.id)}
                    </span>
                  }
                />
                {isLoading && <span className="cas-spinner" aria-hidden />}
                {isUnread && <span className="cas-unread-dot" aria-label={t('chatAgentCapsule.unreadMessage')} />}
              </span>
              <span className="cas-name" aria-hidden="true">
                {agentTitle}
              </span>
            </button>
          );
        })}
        {needsPaging && (
          <button
            type="button"
            className={['cas-nav-btn cas-nav-next', !hasNext && 'is-disabled'].filter(Boolean).join(' ')}
            aria-label={t('chatAgentCapsule.nextPage')}
            disabled={!hasNext}
            onClick={() => changePage(1)}
          >
            ›
          </button>
        )}
      </div>
      {needsPaging && (
        <div className="cas-page-dots" aria-hidden="true">
          {Array.from({ length: totalPages }, (_, i) => (
            <span
              key={i}
              className={['cas-page-dot', i === clampedPage && 'is-active'].filter(Boolean).join(' ')}
            />
          ))}
        </div>
      )}
      {patBubble && (
        <div
          className={['cas-pat-bubble', patShown && 'is-show'].filter(Boolean).join(' ')}
          role="status"
          style={{ '--pat-tail-x': `${patTailX}px` } as CSSProperties}
        >
          <span className="cas-pat-text" key={patBubble.id}>
            {patBubble.text}
          </span>
        </div>
      )}
    </div>
  );
}
