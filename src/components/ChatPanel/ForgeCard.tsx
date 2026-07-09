import { Fragment, useEffect, useRef, useState } from 'react';
import { Brain, ChevronDown, ChevronUp, CheckCircle2, Loader2, Clock, AlertCircle } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import agentIcon from '@forgeax/interface/assets/icons/agent-icon.png';
import { useAppStore } from '@forgeax/interface/store';
import { emitDeepLink } from '@forgeax/interface/lib/deep-link-bus';
import type { ToolCall, SubAgentRun, ChatSegment } from '../../session-store';
import { ProviderBadgePill } from '@forgeax/interface/lib/provider-badge';
import { useDownsampledImage } from './useDownsampledImage';
import { AgentAvatarVideo } from '@forgeax/interface/components/AgentAvatarVideo/AgentAvatarVideo';
import { ForgeText } from './message-parts/ForgeText';
import { ToolChipRow } from './message-parts/ToolChipRow';
import { AskUserCard } from './message-parts/AskUserCard';
import { KcCopyBtn } from './message-parts/KcCopyBtn';
import { buildInterleavedSegments, partitionToolCalls } from './message-parts/interleave';
import { groupTodoFlow } from './message-parts/groupTodoFlow';
import { TodoFlow } from './message-parts/TodoFlow';
import { SubAgentCard } from './SubAgentCard';
import { AgentStatusChip } from './AgentStatusChip';

interface ForgeCardProps {
  status: 'done' | 'running' | 'waiting';
  text: string;
  thought?: string;
  thoughtCollapsed?: boolean;
  toolCalls?: ToolCall[];
  /** Time-ordered render units (text/thinking/tool interleaved).  When
   *  populated, renders from this instead of the legacy text+thinking+
   *  toolCalls three-field layout — fixes the issue where tools "jump"
   *  because they were anchored to a snapshot of text length, not to
   *  their own arrival timestamp.  See store.ts:ChatSegment. */
  segments?: ChatSegment[];
  /** Sub-agent runs keyed by emitterId. Rendered inline next to their
   *  associated subagent ToolChipRow (chip + card always co-located). Any
   *  sub-agent without a chip in toolCalls falls back to bottom of bubble. */
  subAgents?: Record<string, SubAgentRun>;
  errorMessage?: string;
  /** Which CliProvider produced this stream — rendered as a small badge. */
  providerId?: string;
  /** Final USD cost of the turn (from done.cost). Renders in footer. */
  cost?: number;
  /** Wall-clock duration ms (from done.durationMs). Renders in footer. */
  durationMs?: number;
  /** Active sub-agent display name; falls back to FORGE when unset. */
  agentName?: string;
  /** Session id —— needed by interactive segments (ask_user) to POST replies. */
  sid?: string;
  /** Emitter agent path of this bubble —— ask-reply routing key with sid. */
  agentId?: string;
}

// PROVIDER_BADGE + providerBadgeFor moved to ../../lib/provider-badge.ts in
// tick 262 so SubAgentCard can share the same dict + fallback logic (it had
// its own copy with the same drop-on-unknown bug tick 242 fixed here).

// Adaptive USD formatter — claude-code surfaces costs ranging from
// $0.0001 (tiny cache hit) to $5+ (long turn). Fixed-4 reads as "$0.0001"
// (boundary-only info) for sub-cent or "$1.0234" (false precision) for $1+.
// 4 decimals for sub-cent, 3 for sub-dollar, 2 for $1+.
//
// Defensive: a NaN/Infinity (malformed SSE payload, JSON parse race) would
// otherwise render "$NaN" in the bubble — emit "$?" instead so the meta row
// stays readable rather than calling attention to itself with garbage text.
function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return '$?';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// SlowHint removed (2026-06-11): the "上游 cli 偶尔静默返回；可在底部 🔌
// 切换到 X 试试" copy nagged users on every >8s turn. Provider-switch is a
// considered choice — repeated reminders aren't useful, especially when the
// suggested provider isn't necessarily the user's preference. The footer's
// 🔌 picker is permanently visible; users can switch any time without the
// chat bubble suggesting it.

// P3.77 — ForgeCard header pill (kc-provider) now deep-links into the Bus
// admin panel for the cli-provider plugin that produced this turn. Reuses
// the pendingBusKindFilter + pendingBusExpandId pipeline (P3.65/67/68) so a
// player one-clicks from any chat message to that cli's plugin row in Bus.
function useProviderBusDeepLink(): (pluginId: string) => void {
  const openOverlay = useAppStore((s) => s.openOverlay);
  return (pluginId: string) => {
    emitDeepLink('bus:filter-kind', 'cli-provider');
    emitDeepLink('bus:expand-plugin', pluginId);
    openOverlay('settings', 'plugins');
  };
}

export function ForgeCard({
  status,
  text,
  thought,
  thoughtCollapsed = false,
  toolCalls = [],
  segments,
  subAgents,
  errorMessage,
  providerId,
  cost,
  durationMs,
  agentName,
  sid,
  agentId,
}: ForgeCardProps) {
  const { t } = useTranslation();
  const displayName = (agentName?.trim() || 'FORGE').toUpperCase();
  const [collapsed, setCollapsed] = useState(false);
  const onProviderBusDeepLink = useProviderBusDeepLink();
  const [thoughtOpen, setThoughtOpen] = useState(!thoughtCollapsed);
  const logoSrc = useDownsampledImage(agentIcon, 20);
  // Elapsed seconds while running — gives the user a "still working, not frozen"
  // signal during long upstream waits (forgeax cli's ~11s silent-done path
  // looked like a hung UI without this).
  const [elapsedS, setElapsedS] = useState(0);
  // Wall-clock between running→done. Used as fallback when the upstream
  // provider doesn't surface duration_ms (forgeax cli currently never does).
  // claude-code's server-provided durationMs always wins; this is purely a
  // fill-in so the kc-meta footer renders something useful regardless of cli.
  const [fallbackDurationMs, setFallbackDurationMs] = useState<number | undefined>(undefined);
  const runStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (status === 'running') {
      runStartRef.current = Date.now();
      setElapsedS(0);
      setFallbackDurationMs(undefined);
      const id = setInterval(() => setElapsedS(Math.floor((Date.now() - (runStartRef.current ?? Date.now())) / 1000)), 1000);
      return () => clearInterval(id);
    }
    if (status === 'done' && runStartRef.current != null) {
      setFallbackDurationMs(Date.now() - runStartRef.current);
      runStartRef.current = null;
      setElapsedS(0);
      return;
    }
    setElapsedS(0);
  }, [status]);

  return (
    <div className={`forge-card kc-${status}`}>
      {status === 'done' && text.length > 0 && <KcCopyBtn text={text} />}
      <button
        className="kc-header"
        onClick={() => setCollapsed((v) => !v)}
        title="Toggle"
      >
        {/* ADR-0019: WEBM 状态机. 没 avatarRules (老资源/默认 agent) 时回退到原 PNG.
         *  size=28 跟 .kc-logo 对齐 (CSS 已从 20→28 + radius 4→50%). */}
        <AgentAvatarVideo
          agentId={agentId ?? null}
          mode="conversational"
          size={28}
          shape="circle"
          fallback={<img className="kc-logo" src={logoSrc} alt={displayName} />}
        />
        <span className="kc-name">{displayName}</span>
        {/* 右上角实时工作状态趣味文案 —— 跟头像同源, 只在 turn 进行中显示. */}
        {(status === 'running' || status === 'waiting') && (
          <AgentStatusChip agentId={agentId ?? null} />
        )}
        {providerId && (
          <ProviderBadgePill
            providerId={providerId}
            className="kc-provider"
            onBusDeepLink={onProviderBusDeepLink}
          />
        )}
        <span className="kc-status">
          {status === 'done' && <CheckCircle2 size={14} className="status-done" />}
          {status === 'running' && <Loader2 size={14} className="status-running spin" />}
          {status === 'waiting' && <Clock size={14} className="status-waiting" />}
        </span>
        <span className="kc-chev">
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>

      {!collapsed && (
        <div className="kc-body">
          {status === 'running' && !text && (
            <div className="kc-loading">
              <span className="dot-pulse" aria-hidden="true">
                <span /><span /><span />
              </span>
              <span className="kc-loading-label">
                {t('forgeCard.thinking', { displayName })}{elapsedS > 0 && <span className="kc-elapsed"> · {elapsedS}s</span>}
              </span>
            </div>
          )}
          {status === 'waiting' && (
            <div className="kc-status-text">Waiting</div>
          )}
          {/* Legacy / replayed messages carry only the flattened `thinking`
              field (no time-ordered segments[] — e.g. reconstructed from the
              ledger after a server restart). Reasoning always PRECEDES the
              answer in a turn, so render this card ABOVE the body. (When
              segments[] exists, thinking renders inline at its real timeline
              position via <ThoughtChunk> and this card is suppressed.) */}
          {thought && !(Array.isArray(segments) && segments.length > 0) && (
            <div className={`thought-card ${thoughtOpen ? 'expanded' : 'collapsed'}`}>
              <button className="tc-row" onClick={() => setThoughtOpen((v) => !v)}>
                <Brain size={14} className="tc-brain" />
                <span className="tc-label">Thought process</span>
                <span className="tc-chev">
                  {thoughtOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </span>
              </button>
              {thoughtOpen && (
                <div className="tc-content">
                  {thought.split('\n\n').map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          {(() => {
            // Two-phase layout: groupTodoFlow splits tool calls into
            //   1. preFlowTools  — fire BEFORE any todo_write or while no
            //                       in_progress todo → main flow interleave
            //   2. nestedToolsByTodoId — fire while a todo is in_progress →
            //                       rendered inside TodoFlow under that todo
            //   3. currentTodoState — the latest todos[] after all merges/
            //                       replaces/clears → TodoFlow at bubble bottom
            // todo_write tools themselves are NOT rendered as chips.
            const { preFlowTools, currentTodoState, nestedToolsByTodoId } = groupTodoFlow(toolCalls);
            const { ordered, orphans } = partitionToolCalls(preFlowTools);
            const canInterleave = status === 'done' && ordered.length > 0 && text.length > 0;

            // Track which subagent ids we've already inline-rendered so we
            // can surface orphans (subAgents not associated with any
            // toolChip we showed) at the bottom as a fallback.
            const renderedSubAgentIds = new Set<string>();
            const renderSubAgentFor = (subagentId: string): React.ReactNode => {
              const run = subAgents?.[subagentId];
              if (!run) return null;
              renderedSubAgentIds.add(subagentId);
              return <SubAgentCard key={`sub-${subagentId}`} run={run} parentAgentId={agentId ?? null} />;
            };
            // Render a tool chip; if it has a subagentId that resolves, the
            // SubAgentCard renders inline right after (chip + card always
            // co-located, both in main flow and inside TodoFlow nest).
            const renderTool = (tc: ToolCall, key: string) => {
              // ask_user —— 复用 tool 段渲染交互式选项卡(单选/多选)而非普通 chip。
              if (tc.name === 'ask_user' && sid) {
                return <AskUserCard key={key} tc={tc} sid={sid} agentId={agentId ?? ''} />;
              }
              return (
                <Fragment key={key}>
                  <ToolChipRow tc={tc} />
                  {tc.subagentId ? renderSubAgentFor(tc.subagentId) : null}
                </Fragment>
              );
            };

            // P-segments (2026-05-17) — when ChatMessage carries time-ordered
            // segments[], render straight from it: text/thinking/tool slots
            // interleave in arrival order.  Falls back to the legacy three-
            // field layout (text+thinking+toolCalls) when segments is absent
            // (any provider/path that hasn't been ported yet).
            const useSegments = Array.isArray(segments) && segments.length > 0;

            const renderThinking = (key: string, body: string, ts: number) => (
              <ThoughtChunk key={key} text={body} ts={ts} animated={status === 'running'} />
            );

            const mainFlow = useSegments ? (
              <div className="kc-segmented">
                {segments!.map((seg, i) => {
                  if (seg.kind === 'text') {
                    return <ForgeText key={`t-${i}-${seg.ts}`} text={seg.text} animated={status === 'running' && i === segments!.length - 1} />;
                  }
                  if (seg.kind === 'thinking') {
                    return renderThinking(`th-${i}-${seg.ts}`, seg.text, seg.ts);
                  }
                  return renderTool(seg.tool, `tc-${seg.tool.callId}`);
                })}
                {/* When upstream cli returns a clean 'done' with no segments
                 *  at all, render an empty-state hint so the bubble isn't
                 *  visually blank — mirrors the legacy fallback below. */}
                {segments!.length === 0 && status === 'done' && !errorMessage && (
                  <div className="kc-empty">
                    {t('forgeCard.emptyResponse')}
                  </div>
                )}
              </div>
            ) : !canInterleave ? (
              <>
                {text && <ForgeText text={text} animated={status === 'running'} />}
                {/* When upstream cli returns a clean 'done' with no token + no
                 * tool calls + no todos, render a low-contrast placeholder so
                 * the bubble isn't visually empty (looks like a render bug). */}
                {!text && toolCalls.length === 0 && status === 'done' && !errorMessage && (
                  <div className="kc-empty">
                    {t('forgeCard.emptyResponse')}
                  </div>
                )}
                {preFlowTools.length > 0 && (
                  <div className="kc-tools">
                    {preFlowTools.map((tc) => renderTool(tc, tc.callId))}
                  </div>
                )}
              </>
            ) : (
              <div className="kc-interleaved">
                {buildInterleavedSegments(text, ordered).map((s, i) =>
                  s.kind === 'text'
                    ? <ForgeText key={i} text={s.value} animated={false} />
                    : renderTool(s.value, `tc-${s.value.callId}`),
                )}
                {orphans.length > 0 && (
                  <div className="kc-tools">
                    {orphans.map((tc) => renderTool(tc, tc.callId))}
                  </div>
                )}
              </div>
            );

            // After main flow + TodoFlow renders, surface any SubAgentCards
            // that didn't get inline'd anywhere (defensive against future
            // data shapes where subAgents exist without a chip).
            const orphanSubAgents = subAgents
              ? Object.values(subAgents).filter((sa) => !renderedSubAgentIds.has(sa.emitterId))
              : [];

            return (
              <>
                {mainFlow}
                {currentTodoState && currentTodoState.length > 0 && (
                  <TodoFlow
                    todos={currentTodoState}
                    nestedToolsByTodoId={nestedToolsByTodoId}
                    renderSubAgent={renderSubAgentFor}
                  />
                )}
                {orphanSubAgents.length > 0 && (
                  <div className="kc-orphan-subs">
                    {orphanSubAgents.map((sa) => (
                      <SubAgentCard key={`orphan-${sa.emitterId}`} run={sa} parentAgentId={agentId ?? null} />
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {errorMessage && (
            <div className="kc-error">
              <AlertCircle size={14} /> {errorMessage}
            </div>
          )}

          {(() => {
            // Prefer server-provided duration_ms (claude-code) over the local
            // wall-clock fallback (forgeax cli, which doesn't surface it).
            // The `~` prefix on fallback signals it's a client estimate, so
            // users can tell the precise number from the rough one.
            const finalDuration = durationMs ?? fallbackDurationMs;
            if (status !== 'done' || (finalDuration === undefined && cost === undefined)) return null;
            const isFallback = durationMs === undefined && fallbackDurationMs !== undefined;
            // Tooltip carries the exact underlying values — display rounds for
            // readability (`2.2s`, `$0.082`) but hovering reveals `2234ms ·
            // $0.082491` so power users can see precise cost/latency without
            // popping devtools.
            const tip = [
              finalDuration !== undefined ? `${isFallback ? '~' : ''}${Math.round(finalDuration)}ms` : null,
              cost !== undefined && cost > 0 ? `$${cost.toFixed(6)}` : null,
              isFallback ? '⏱ client estimate (provider omitted duration_ms)' : null,
            ].filter(Boolean).join(' · ');
            return (
              <div className="kc-meta" title={tip}>
                {finalDuration !== undefined && (
                  <span className="kc-meta-item">
                    ⏱ {isFallback ? '~' : ''}{(finalDuration / 1000).toFixed(1)}s
                  </span>
                )}
                {cost !== undefined && cost > 0 && (
                  <span className="kc-meta-item">💰 {formatCost(cost)}</span>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * Inline thinking/reasoning chunk for the segments[] timeline.  Renders as a
 * collapsible italic block — defaults open during streaming so the player can
 * watch the reasoning flow, auto-collapses when text segments appear after it
 * (handled at the segments builder level by interleaving order).
 *
 * Kept inside this file because it's a private render primitive of ForgeCard;
 * the legacy `thought-card` at the bottom of the bubble is preserved for the
 * non-segments code path.
 */
function ThoughtChunk({ text, ts, animated }: { text: string; ts: number; animated: boolean }) {
  const [open, setOpen] = useState(animated);
  // Re-open on `ts` change so a new thinking segment doesn't stay hidden under
  // an old collapsed one (rare, but matters when same-bubble has two reasoning
  // chunks separated by a tool call).
  useEffect(() => { if (animated) setOpen(true); }, [ts, animated]);
  return (
    <div className={`thought-chunk ${open ? 'open' : 'collapsed'}`} data-ts={ts}>
      <button type="button" className="tc-row" onClick={() => setOpen((v) => !v)}>
        <Brain size={12} className="tc-brain" />
        <span className="tc-label">{animated ? 'Thinking…' : 'Thought'}</span>
        <span className="tc-chev">{open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {open && (
        <div className="tc-content">
          {text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}
    </div>
  );
}
