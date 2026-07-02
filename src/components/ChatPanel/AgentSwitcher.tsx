import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import {
  AgentAvatar,
  accentForRoleTribe,
  resolveAvatarGlyphId,
} from '@forgeax/interface/components/AgentAvatar/AgentAvatar';
import { useAppStore } from '@forgeax/interface/store';
import { emitDeepLink } from '@forgeax/interface/lib/deep-link-bus';
import { useChatStore, useActiveStreaming } from '../../session-store';

/**
 * AgentSwitcher — horizontal scrollable list of the cli daemon's live agents.
 *
 * Single-click = pin this agent to the active tab (`setTabAgent(activeTabId,
 * a.id)`). The ChatPanel useEffect that watches `activeTab.agentId` then
 * fires the WAL replay. No imperative loadSession here — single trigger.
 *
 * Double-click = update the active EMITTER for the current thread (PATCH
 * /api/threads/:id, server-side routing for the next send). setActiveEmitter
 * internally re-pins the active tab's agentId so the same effect fires.
 *
 * The 'main agent' is derived from the agent-tree, not hardcoded — root
 * agent = parentId === null (sorted first; rendered first; auto-pinned to
 * the active tab when the tab has no agentId yet, or the persisted one no
 * longer exists in the fetched roster).
 */

interface AgentItem {
  id: string;
  role: string;
  parentId: string | null;
  initial: string;
  gradient: string;
  status: 'done' | 'running' | 'waiting';
  // P3.18 — placeholder mode: when cli daemon is idle and list_agents
  // returns empty, AgentSwitcher falls back to /api/workbench/agents
  // (marketplace + bus union) and renders the 7 known agents as dim,
  // click-disabled placeholders. `placeholder=true` flips the avatar
  // into dim opacity, removes the status dot, and routes click to the
  // existing `.as-hint` toast ("cli daemon 未启动") instead of switching.
  placeholder?: boolean;
  // P3.91 — if the placeholder maps to a bus-registered plugin (cc-coder
  // today, via the `agents_from_bus[]` payload), keep its pluginId so the
  // ctrl/cmd+click deep-link can land on that specific row in Bus admin.
  busPluginId?: string;
}

// P3.18 — role-tribe key extraction (mirrors AgentsPanel/Sidebar.tsx roleKey).
// Marketplace `role` can carry trailing status (`coding · 占位`); the leading
// segment before `·` is the stable tribe key paired by CSS to one of 6 hues
// (orchestrator / pillar / design / narrative / art / coding). Returns the
// bare key suitable for a data-role slot; unknown roles fall through to a
// low-contrast neutral ring (no data-role match → no CSS rule fires).
function roleKey(role: string): string {
  const base = (role.split('·')[0] ?? '').trim().toLowerCase();
  return base;
}

// Deterministic palette derived from agent id — same id always gets same color.
const GRADIENTS = [
  'linear-gradient(135deg, var(--primary), var(--accent-cyan))',
  'linear-gradient(135deg, var(--accent-orange), var(--accent-pink))',
  'linear-gradient(135deg, var(--accent-purple), var(--accent-cyan))',
  'linear-gradient(135deg, var(--accent-cyan), var(--accent-green))',
  'linear-gradient(135deg, var(--color-status-amber), var(--accent-orange))',
  'linear-gradient(135deg, var(--accent-error), var(--accent-pink))',
];
function gradFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length]!;
}
function initialFor(id: string): string {
  const parts = id.split(/[-_]/);
  if (parts.length >= 2 && parts[0] && parts[1]) return (parts[0][0]! + parts[1][0]!).toUpperCase();
  return id.slice(0, 2).toUpperCase();
}

export function AgentSwitcher() {
  const { t } = useTranslation();
  const isStreaming = useActiveStreaming();
  const setActiveEmitter = useAppStore((s) => s.setActiveEmitter);
  const setTabAgent = useAppStore((s) => s.setTabAgent);
  const activeSid = useAppStore((s) => s.activeSid);
  // P3.86 — Bus deep-link slot: setPendingBusKindFilter('agent') + openSettings('plugins')
  // lands the player on Bus admin with the `agent` kind soloed, mirroring the
  // P3.80 cp-agent-bar-id / P3.72 ThreadsList Active emitter cell pattern.
  // No expand slot here: AgentSwitcher does not target a specific agent plugin
  // row — the entry point is the whole agent kind, so users see all 7 placeholder
  // + 1 bus agent rows at once instead of auto-expanding cc-coder.
  const openOverlay = useAppStore((s) => s.openOverlay);
  // P3.91 — per-placeholder deep-link slot. cli-idle placeholders (P3.18) used
  // to fire only a toast ("cli 未启动"). Now `ctrl/cmd+click` on a placeholder
  // routes to Bus admin: kind=agent solo, and if the placeholder maps to a bus
  // plugin (only `cc-coder` today via `agents_from_bus`), also expand that row
  // for a single-row landing. Plain click keeps the toast — discoverable via
  // the new `· ctrl/⌘+click → Bus` hint suffix in `title`.
  // Active tab's bound agent — first-class key for highlight + chat routing.
  const activeAgentId = useAppStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  const trackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  // Track last successful fetch time. If the user resumes after a long
  // hidden period (lock-screen, tab-switch hours), the rendered status is
  // stale until the post-resume fetch lands; mark pre-resume render stale
  // so users get a visual cue rather than trust 8-hour-old badges.
  const [lastFetchAt, setLastFetchAt] = useState(0);
  // Click-feedback hint. P3.18 added `text` so placeholder clicks can show
  // "cli daemon 未启动" instead of the generic "未初始化" inherited from the
  // pre-3.18 not-ready hover state.
  const [hint, setHint] = useState<{ id: string; left: number; top: number; text?: string } | null>(null);
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(null), 2000);
    return () => clearTimeout(id);
  }, [hint]);

  // Poll cli daemon's agent-tree.json via /api/commands/list_agents/query.
  // 1.5s while streaming (so subagent_launched events surface fast),
  // 5s while idle. Pause when hidden; burst on streaming→idle transition.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // Source of truth = cli daemon agent-tree (commands transport). No
    // client-side persona / dedupe logic — the cli authoritative list is
    // already canonical and the previous filesystem-walk impl was prone
    // to historical-residue noise.
    // P3.18 — fallback fetch for cli-idle state. /api/workbench/agents returns
    // the 7 marketplace agents (forge/iori/suzu/kotone/iro/tsumugi/cc-coder)
    // with `role` field; we render them as dim placeholders so the row never
    // collapses to a single `+` button (which leaves players with no signal
    // about who's available when cli daemon is down). 0 click side-effect:
    // clicking a placeholder fires the existing `.as-hint` toast.
    // R3 (2026-05-20) —— marketplace placeholder（K/I/S/K/Ir/T/CC 7 头像）
    // 已被钉死下线：server `POST /api/sessions` 现在默认 bootstrap 一个 `root`
    // agent，`list_agents` 不会再返空。空时显示空态行而不是塞 7 个假人头 ——
    // 真后端没有该 session 的 agent，UI 必须如实反映，不能用 marketplace
    // 列表骗用户「这些 agent 就在你 session 里」。
    //
    // 旧 `fetchPlaceholders()` + `/api/workbench/agents` 已删；marketplace 视图
    // 只在 Bus Admin（plugins 面板）里露出，不再侵入聊天头像行。
    const emptyPlaceholders = (): AgentItem[] => [];
    const fetchAgents = async () => {
      // 没活跃 sid（boot 中 / initSessions 失败）：直接置空，等 store 把 sid
      // 写好后 effect 依赖 activeSid 触发重跑。
      if (!activeSid) {
        if (!cancelled) {
          setAgents(emptyPlaceholders());
          setLastFetchAt(Date.now());
        }
        return;
      }
      try {
        const { listSessionAgents } = await import('@forgeax/interface/lib/forgeax-bridge');
        const items = await listSessionAgents(activeSid);
        if (cancelled) return;
        if (items.length === 0) {
          if (!cancelled) {
            setAgents(emptyPlaceholders());
            setLastFetchAt(Date.now());
            // Do NOT wipe tab.agentId here. ChatAgentStrip pins marketplace
            // personas (mochi / rin / …) before they exist in the session
            // tree — wiping the pin during the cold-boot or post-reload
            // window where list_agents has yet to reflect a fresh scaffold
            // would force the next message to route to root. The pin is
            // user intent; we surface the underlying tree state via the
            // tree-resident roster only (rendered list).
          }
          return;
        }
        const list: AgentItem[] = items.map((a) => ({
          id: a.path,
          role: a.parent === null ? 'orchestrator' : '',
          parentId: a.parent,
          initial: initialFor(a.display),
          gradient: gradFor(a.path),
          status: a.running ? ('running' as const) : a.hasLedger ? ('done' as const) : ('waiting' as const),
        }));
        list.sort((a, b) => {
          if (a.parentId === null && b.parentId !== null) return -1;
          if (a.parentId !== null && b.parentId === null) return 1;
          return 0;
        });
        setAgents(list);
        setLastFetchAt(Date.now());
        useAppStore.getState().setLiveAgents(activeSid, items.map((a) => ({
          path: a.path,
          display: a.display,
          parent: a.parent,
          running: a.running,
          depth: a.depth,
        })));

        // Pin active tab to root agent ONLY when its agentId is unbound.
        // Do NOT reset on "stale" (pin not in tree-resident list) — the
        // ChatAgentStrip pins marketplace personas before the session
        // tree has them; the auto-scaffold runs on first message-send.
        // Race-resetting here is the bug the user reported as "我点击
        // mochi头像，对话，并不是mochi回答" — the switcher poll fires in
        // the gap between pin and scaffold, kicks tab.agentId back to
        // root, and the user's first message lands on root with mochi
        // never reached. The pin is sacred user intent; render-time
        // styling already shows when an agentId isn't in the live list
        // (no avatar lights up as `is-active-emitter`).
        if (list.length > 0) {
          const s = useAppStore.getState();
          const tab = s.tabs.find((t) => t.sid === s.activeSid);
          const cur = tab?.agentId ?? null;
          if (s.activeSid && !cur) {
            setTabAgent(s.activeSid, list[0]!.id);
          }
        }
      } catch {
        if (!cancelled) {
          setAgents(emptyPlaceholders());
          setLastFetchAt(Date.now());
        }
      }
    };
    // R3 (2026-05-20) —— P3.18 的 eager placeholder bootstrap 整段下线，跟
    // marketplace fallback 一起退场。server 现在 boot session 时同步 scaffold
    // 一个 root agent，`list_agents` 不会再返空；首屏 ~50ms 内 fetchAgents
    // 自己就拉到了，不需要 placeholder 占位。
    const start = () => {
      if (timer) clearInterval(timer);
      fetchAgents();
      timer = setInterval(fetchAgents, isStreaming ? 1500 : 5000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    let docVisible = !document.hidden;
    let ioVisible = true;
    const sync = () => {
      if (docVisible && ioVisible) start();
      else stop();
    };
    const onVis = () => {
      docVisible = !document.hidden;
      sync();
    };
    const io = new IntersectionObserver(
      (entries) => {
        ioVisible = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0);
        sync();
      },
      { root: null, threshold: 0 },
    );
    if (rootRef.current) io.observe(rootRef.current);
    sync();
    document.addEventListener('visibilitychange', onVis);
    // Catch-up burst only on the actual streaming→idle transition. The cli's
    // empirical idle→done flip lags the SSE 'done' event by 0.5-2s; the burst
    // targets p25/p75 of that window. Skip the burst when the just-ended
    // turn errored (cli goes idle immediately on error, no flip delay).
    const BURST_DELAYS_MS = [750, 2250] as const;
    const justEnded = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;
    const bursts: ReturnType<typeof setTimeout>[] = [];
    const { activeSid: curSid } = useAppStore.getState();
    const curAgent = curSid ? (useAppStore.getState().tabs.find((tb) => tb.sid === curSid)?.agentId ?? null) : null;
    const last = curSid && curAgent ? useChatStore.getState().readMessages(curSid, curAgent).at(-1) : undefined;
    const erroredOut = last?.role === 'assistant' && last.status === 'error';
    if (justEnded && !document.hidden && !erroredOut) {
      for (const d of BURST_DELAYS_MS) bursts.push(setTimeout(fetchAgents, d));
    }
    return () => {
      cancelled = true;
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      bursts.forEach((b) => clearTimeout(b));
    };
    // activeSid 加入依赖：切 session 时立刻重拉新 sid 的 agent 列表，
    // 否则旧 sid 的 agents 残留在 chip row 里直到下一次 5s tick。
  }, [isStreaming, setTabAgent, activeSid]);

  // Horizontal drag + wheel-to-horizontal scroll.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    let isDown = false;
    let startX = 0;
    let startScroll = 0;
    let dragMoved = false;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      isDown = true;
      dragMoved = false;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      el.classList.add('dragging');
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) dragMoved = true;
      el.scrollLeft = startScroll - dx;
    };
    const onPointerUp = () => {
      isDown = false;
      el.classList.remove('dragging');
    };
    // Suppress click after drag so users don't accidentally switch agent.
    const onClickCapture = (e: MouseEvent) => {
      if (dragMoved) {
        e.stopPropagation();
        e.preventDefault();
        dragMoved = false;
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    el.addEventListener('click', onClickCapture, true);
    el.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('click', onClickCapture, true);
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  // STALE_MS = 6× the longest poll interval (5000ms idle); anything beyond
  // that means we missed a poll cycle or visibility paused us.
  const STALE_MS = 30_000;
  const isStale = lastFetchAt > 0 && Date.now() - lastFetchAt > STALE_MS;
  return (
    <div className="agent-switcher" ref={rootRef}>
      <div
        className="as-track"
        ref={trackRef}
        style={isStale ? { opacity: 0.55, transition: 'opacity 0.18s' } : undefined}
        aria-busy={isStale || undefined}
      >
        {agents
          // R3 (2026-05-20) —— `/api/threads/:id/used-agents` 下线后没有
          // "used agents" narrow 数据源；改成展示 session.tree 全部 agent。
          // 等 commands.list_run_events 进来后可以重做 narrow（依据是哪条
          // event 真的发到了某个 EventQueue）。
          .map((a) => {
          const isActive = activeAgentId === a.id;
          // P3.18 + PR-#9 merge — placeholder click: show "cli 未启动" hint
          // (marketplace placeholder, no cli runtime yet), skip the
          // setTabAgent rewire so the next chat send doesn't get wedged
          // with a non-runnable id. Real agents flow through setTabAgent
          // which is the single trigger watched by ChatPanel for WAL replay.
          //
          // P3.91 — ctrl/cmd+click upgrades placeholder click into a Bus
          // admin deep-link: kind=agent solo, plus an expand-target row when
          // the placeholder maps to a bus plugin (only `cc-coder` today).
          // Plain click / alt+click keeps the original "cli 未启动" toast so
          // existing muscle memory and the "placeholder cannot run" affordance
          // are preserved. Drag-suppression already handled by trackRef's
          // onClickCapture (sets dragMoved before this handler runs).
          const onPlaceholderClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            const dl = e.ctrlKey || e.metaKey;
            if (dl) {
              emitDeepLink('bus:filter-kind', 'agent');
              if (a.busPluginId) emitDeepLink('bus:expand-plugin', a.busPluginId);
              openOverlay('settings', 'plugins');
              return;
            }
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setHint({
              id: a.id,
              left: rect.left + rect.width / 2,
              top: rect.top,
              text: a.busPluginId ? t('agentSwitcher.hintBusExpand') : t('agentSwitcher.hintBusList'),
            });
          };
          return (
            <button
              key={a.id}
              className={`as-avatar-btn ${isActive && !a.placeholder ? 'active is-active-emitter' : ''} ${a.placeholder ? 'placeholder' : ''} ${a.placeholder && a.busPluginId ? 'has-bus' : ''}`}
              data-role={roleKey(a.role)}
              data-bus-plugin-id={a.placeholder ? (a.busPluginId ?? '') : undefined}
              onClick={a.placeholder
                ? onPlaceholderClick
                : () => {
                    // Re-bind the active tab to this agent. ChatPanel's
                    // useEffect([activeTab.agentId]) is the single trigger
                    // that then re-pulls the WAL for the new agent.
                    if (activeSid) setTabAgent(activeSid, a.id);
                  }}
              onDoubleClick={a.placeholder
                ? undefined
                : () => {
                    // PATCH /api/threads/:id activeEmitterId so server-side
                    // routing for the next send goes to this agent (covers
                    // cases where the user wants to address a specific child
                    // without rewiring the whole tab).
                    void setActiveEmitter(a.id);
                  }}
              title={a.placeholder
                ? `${t('agentSwitcher.titlePlaceholder', { id: a.id, role: a.role })}${a.busPluginId ? t('agentSwitcher.titlePlaceholderExpand', { busPluginId: a.busPluginId }) : t('agentSwitcher.titlePlaceholderAgentKind')}`
                : t('agentSwitcher.titleAgent', { id: a.id, role: a.role })}
              aria-label={a.id}
            >
              {(() => {
                const tribe = roleKey(a.role);
                const glyphId = resolveAvatarGlyphId(a.id, tribe);
                const accent = accentForRoleTribe(tribe);
                const art = (
                  <AgentAvatar
                    agentId={glyphId}
                    accent={accent}
                    fallback={a.initial}
                    size={26}
                    glass
                  />
                );
                if (a.placeholder) {
                  return <span className="as-avatar as-avatar--placeholder">{art}</span>;
                }
                return art;
              })()}
              {!a.placeholder && <span className={`as-status ${a.status}`} />}
            </button>
          );
        })}
        {/* 2026-05-17 — `+ New agent` 占位按钮删除。原 stub 仅 `disabled`
           且 title 写 `coming soon`,等真接 cli daemon `spawn_agent`
           (或主 agent 的 spawn_subagent 工具) 再加回来,免得误导用户以为
           能用。 */}
      </div>
      {/* 2026-05-17 — `.as-bus-btn` 删除 (Bus 入口第 5 个镜像)。Bus admin
         有顶栏 + 底栏 GlobalStatusBar BUS KINDS 两个稳定入口。 */}
      <button className="as-more" title="More agents">
        <ChevronDown size={12} />
      </button>
      {hint && (
        <span
          className="as-hint"
          role="status"
          style={{ position: 'fixed', left: hint.left, top: hint.top - 22 }}
        >
          {hint.text ?? t('agentSwitcher.hintNotInitialized')}
        </span>
      )}
    </div>
  );
}
