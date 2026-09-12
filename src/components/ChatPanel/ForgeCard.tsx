import type { FailureContinuation } from './execution-failure';
import { ExecutionFailure } from './ExecutionFailure';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, ChevronDown, ChevronUp, CheckCircle2, Loader2, Clock, AlertCircle } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import agentIcon from '@forgeax/interface/assets/icons/agent-icon.png';
import { useShellStore } from '@forgeax/interface/store';
import { emitDeepLink } from '@forgeax/interface/lib/deep-link-bus';
import type { ToolCall, SubAgentRun, ChatSegment } from '../../session-store';
import { ProviderBadgePill } from '@forgeax/interface/lib/provider-badge';
import { useDownsampledImage } from './useDownsampledImage';
import { AgentAvatarVideo } from '@forgeax/agents/components/AgentAvatarVideo/AgentAvatarVideo';
import { ForgeText } from './message-parts/ForgeText';
import { ToolChipRow } from './message-parts/ToolChipRow';
import { AskUserCard } from './message-parts/AskUserCard';
import { KcCopyBtn } from './message-parts/KcCopyBtn';
import { buildInterleavedSegments, partitionToolCalls } from './message-parts/interleave';
import { SubAgentCard } from './SubAgentCard';
import { AgentStatusChip } from './AgentStatusChip';
import { MAIN_AGENT_ACCENT } from './agent-identity';
import { shortAgentId } from './useAgentNames';
import { formatDuration } from './process-display';
import { deriveExecutionStage, executionStageLabelKey } from './execution-stage';

interface ForgeCardProps {
  status: 'done' | 'running' | 'waiting' | 'error';
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
  failureContinuation?: FailureContinuation;
  /** Which CliProvider produced this stream — rendered as a small badge. */
  providerId?: string;
  /** Final USD cost of the turn (from done.cost). Renders in footer. */
  cost?: number;
  /** Wall-clock duration ms (from done.durationMs). Renders in footer. */
  durationMs?: number;
  /** Active sub-agent display name; falls back to FORGE when unset. */
  agentName?: string;
  /** Human-readable message time shown beside the current agent identity. */
  timestamp?: string;
  /** Session id —— needed by interactive segments (ask_user) to POST replies. */
  sid?: string;
  /** Emitter agent path of this bubble —— ask-reply routing key with sid. */
  agentId?: string;
  /** Host-owned execution trace for this assistant turn. It belongs to the
   *  Forge response container, rather than being a sibling in the chat
   *  timeline between the user message and the response. */
  processContent?: ReactNode;
  /** Index in the remaining message segments before which processContent was
   *  emitted. Preserves Ask User/text segments that chronologically preceded
   *  the first Todo/process event. */
  processInsertAt?: number;
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
function useProviderBusDeepLink(): (extensionId: string) => void {
  const openOverlay = useShellStore((s) => s.openOverlay);
  return (extensionId: string) => {
    emitDeepLink('bus:filter-kind', 'cli-provider');
    emitDeepLink('bus:expand-plugin', extensionId);
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
  failureContinuation,
  providerId,
  cost,
  durationMs,
  agentName,
  timestamp,
  sid,
  agentId,
  processContent,
  processInsertAt,
}: ForgeCardProps) {
  const { t } = useTranslation();
  const isMainAgent = !agentName || shortAgentId(agentName) === 'forge';
  const displayName = (isMainAgent ? 'ForgeaX' : agentName?.trim() || 'ForgeaX').toUpperCase();
  const executionStage = deriveExecutionStage({
    status,
    text,
    thought,
    segments,
    toolCalls,
    subAgents,
  });
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
      <div className="kc-header">
        {/* ADR-0019: WEBM 状态机. 没 avatarRules (老资源/默认 agent) 时回退到原 PNG.
         *  size=28 跟 .kc-logo 对齐 (CSS 已从 20→28 + radius 4→50%). */}
        <AgentAvatarVideo
          agentId={agentId ?? null}
          mode="conversational"
          size={28}
          shape="circle"
          fallback={<img className="kc-logo" src={logoSrc} alt={displayName} />}
        />
        <span className="kc-name" style={isMainAgent ? { color: MAIN_AGENT_ACCENT } : undefined}>{displayName}</span>
        {timestamp && <time className="kc-time">{timestamp}</time>}
        {/* 右上角实时执行阶段；没有事件证据时由 helper 明确显示 unknown. */}
        {(status === 'running' || status === 'waiting') && (
          <AgentStatusChip agentId={agentId ?? null} stage={executionStage} />
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
          {status === 'error' && <AlertCircle size={14} className="status-error" />}
        </span>
        {status === 'done' && text.length > 0 && <KcCopyBtn text={text} />}
      </div>

      <div className="kc-body">
          {status === 'running' && !text && (
            <div className="kc-loading">
              <span className="kc-loading-label">
                {t(executionStageLabelKey(executionStage), { displayName })}{elapsedS > 0 && <span className="kc-elapsed"> · {formatDuration(elapsedS * 1000)}</span>}
              </span>
            </div>
          )}
          {status === 'waiting' && (
            <div className="kc-status-text">{t(executionStageLabelKey(executionStage), { displayName })}</div>
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
                <span className="tc-label">{t('taskFlow.thoughtProcess')}</span>
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
            const { ordered, orphans } = partitionToolCalls(toolCalls);
            const canInterleave = status === 'done' && ordered.length > 0 && text.length > 0;

            // Track which subagent ids we've already inline-rendered so we
            // can surface orphans (subAgents not associated with any
            // toolChip we showed) at the bottom as a fallback.
            const renderedSubAgentIds = new Set<string>();
            const renderSubAgentFor = (subagentId: string): React.ReactNode => {
              const run = subAgents?.[subagentId];
              if (!run) return null;
              renderedSubAgentIds.add(subagentId);
              return <SubAgentCard key={`sub-${subagentId}`} run={run} sid={sid} parentAgentId={agentId ?? null} />;
            };
            // Render a tool chip; if it has a subagentId that resolves, the
            // SubAgentCard renders inline right after it.
            const renderTool = (tc: ToolCall, key: string) => {
              // CLI AskUserQuestion is owned by the permission side-channel;
              // rendering it here would duplicate the PermissionPrompt after
              // a WAL replay.
              if (tc.permissionPrompt) return null;
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

            const renderSegment = (seg: ChatSegment, i: number) => {
              if (seg.kind === 'text') {
                return <ForgeText key={`t-${i}-${seg.ts}`} text={seg.text} animated={status === 'running' && i === segments!.length - 1} />;
              }
              if (seg.kind === 'thinking') {
                return renderThinking(`th-${i}-${seg.ts}`, seg.text, seg.ts);
              }
              return renderTool(seg.tool, `tc-${seg.tool.callId}`);
            };

            const mainFlow = useSegments ? (
              <div className="kc-segmented">
                {segments!.flatMap((seg, i) => [
                  ...(processContent && i === (processInsertAt ?? 0)
                    ? [<Fragment key="process-slot">{processContent}</Fragment>]
                    : []),
                  renderSegment(seg, i),
                ])}
                {processContent && (processInsertAt ?? 0) >= segments!.length && (
                  <Fragment key="process-slot-end">{processContent}</Fragment>
                )}
              </div>
            ) : !canInterleave ? (
              <>
                {processContent}
                {text && <ForgeText text={text} animated={status === 'running'} />}
                {/* Tools and intermediate output may have been moved into
                 * the hosted process. An empty final projection is not an
                 * empty response when that process or a child is visible. */}
                {!text && !processContent && !thought && !Object.keys(subAgents ?? {}).length
                  && toolCalls.length === 0 && status === 'done' && !errorMessage && (
                  <div className="kc-empty">
                    {t('forgeCard.emptyResponse')}
                  </div>
                )}
                {toolCalls.length > 0 && (
                  <div className="kc-tools">
                    {toolCalls.map((tc) => renderTool(tc, tc.callId))}
                  </div>
                )}
              </>
            ) : (
              <div className="kc-interleaved">
                {processContent}
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

            // Surface any SubAgentCards that didn't get inline'd anywhere.
            const orphanSubAgents = subAgents
              ? Object.values(subAgents).filter((sa) => !renderedSubAgentIds.has(sa.emitterId))
              : [];

            return (
              <>
                {mainFlow}
                {orphanSubAgents.length > 0 && (
                  <div className="kc-orphan-subs">
                    {orphanSubAgents.map((sa) => (
                      <SubAgentCard key={`orphan-${sa.emitterId}`} run={sa} sid={sid} parentAgentId={agentId ?? null} />
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {errorMessage && <ExecutionFailure error={errorMessage} continuation={failureContinuation} />}

          {(() => {
            // Prefer server-provided duration_ms (claude-code) over the local
            // wall-clock fallback (forgeax cli, which doesn't surface it).
            // The `~` prefix on fallback signals it's a client estimate, so
            // users can tell the precise number from the rough one.
            const finalDuration = durationMs ?? fallbackDurationMs;
            // ProcessAccordion owns the turn duration as the single visible
            // `Worked for …` summary. Keep only provider cost here when a
            // Process exists; rendering both timers duplicates the same fact.
            const showDuration = !processContent && finalDuration !== undefined;
            if (status !== 'done' || (!showDuration && cost === undefined)) return null;
            const isFallback = durationMs === undefined && fallbackDurationMs !== undefined;
            // Tooltip carries the exact underlying values — display rounds for
            // readability (`2.2s`, `$0.082`) but hovering reveals `2234ms ·
            // $0.082491` so power users can see precise cost/latency without
            // popping devtools.
            const tip = [
              showDuration ? `${isFallback ? '~' : ''}${Math.round(finalDuration)}ms` : null,
              cost !== undefined && cost > 0 ? `$${cost.toFixed(6)}` : null,
              isFallback ? '⏱ client estimate (provider omitted duration_ms)' : null,
            ].filter(Boolean).join(' · ');
            return (
              <div className="kc-meta" title={tip}>
                {showDuration && (
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(animated);
  // Re-open on `ts` change so a new thinking segment doesn't stay hidden under
  // an old collapsed one (rare, but matters when same-bubble has two reasoning
  // chunks separated by a tool call).
  useEffect(() => { if (animated) setOpen(true); }, [ts, animated]);
  return (
    <div className={`thought-chunk ${open ? 'open' : 'collapsed'}`} data-ts={ts}>
      <button type="button" className="tc-row" onClick={() => setOpen((v) => !v)}>
        <Brain size={12} className="tc-brain" />
        <span className="tc-label">{animated ? t('taskFlow.thinkingActive') : t('taskFlow.thought')}</span>
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
