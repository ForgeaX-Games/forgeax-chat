import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useAppStore } from '@forgeax/interface/store';
import { emitDeepLink } from '@forgeax/interface/lib/deep-link-bus';
import type { SubAgentRun } from '../../session-store';
import { ProviderBadgePill } from '@forgeax/interface/lib/provider-badge';
import { AgentAvatarVideo } from '@forgeax/interface/components/AgentAvatarVideo/AgentAvatarVideo';
import { ForgeText } from './message-parts/ForgeText';
import { ToolChipRow } from './message-parts/ToolChipRow';
import { KcCopyBtn } from './message-parts/KcCopyBtn';
import { buildInterleavedSegments, partitionToolCalls } from './message-parts/interleave';
import { useAgentNames, shortAgentId } from './useAgentNames';

// Handoff "拍一拍" phrases — the delegating agent (initiator) hands the task
// off to this sub-agent. Read as: "{from}拍了拍{to}，并{action}". A stable
// index is picked per run (see patActionFor) so the phrase doesn't reshuffle
// on every re-render / stream tick.
const PAT_HANDOFF_ACTIONS = [
  '把活儿交给了 ta',
  '请 ta 来搭把手',
  '甩了个大活过去',
  '喊 ta 出场救场',
  '把接力棒递了过去',
  '派 ta 去开工',
  '托付了一件大事',
  '让 ta 接手了',
  '拜托 ta 帮个忙',
  '把任务塞进了 ta 手里',
  '点名 ta 上场',
  '请 ta 接力一棒',
];

function patActionFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PAT_HANDOFF_ACTIONS[Math.abs(h) % PAT_HANDOFF_ACTIONS.length]!;
}

const ROSTER: Record<string, { displayName: string; roleKey: string; color: string; emoji: string }> = {
  iori: { displayName: 'Iori', roleKey: 'subAgent.role.iori', color: 'var(--color-role-art)', emoji: '🏛️' },
  suzu: { displayName: 'Suzu', roleKey: 'subAgent.role.suzu', color: 'var(--color-role-orchestrator)', emoji: '📐' },
  kotone: { displayName: 'Kotone', roleKey: 'subAgent.role.kotone', color: 'var(--color-role-narrative)', emoji: '💬' },
  iro: { displayName: 'Iro', roleKey: 'subAgent.role.iro', color: 'var(--accent-mint)', emoji: '🎨' },
  tsumugi: { displayName: 'Tsumugi', roleKey: 'subAgent.role.tsumugi', color: 'var(--color-role-design)', emoji: '🛠️' },
  'cc-coder': { displayName: 'CC Coder', roleKey: 'subAgent.role.ccCoder', color: 'var(--color-role-orchestrator)', emoji: '🧠' },
};

function profileFor(emitterId: string): { displayName: string; roleKey: string; color: string; emoji: string } {
  const idLower = emitterId.toLowerCase();
  for (const key of Object.keys(ROSTER)) {
    if (idLower.includes(key)) return ROSTER[key];
  }
  return { displayName: emitterId, roleKey: 'subAgent.role.fallback', color: 'var(--prim-color-neutral-450)', emoji: '🤖' };
}

export function SubAgentCard({ run, parentAgentId }: { run: SubAgentRun; parentAgentId?: string | null }) {
  // Default collapsed for completed runs (replay history + finished live)
  // so long chat scrollbacks aren't dominated by sub-agent walls of text.
  // Streaming sub-agents stay expanded so the user can watch progress.
  const { t } = useTranslation();
  const [open, setOpen] = useState(run.status === 'streaming');
  // P3.77 — mirror ForgeCard's provider-pill deep-link. SubAgentCard header
  // is also a <button>, so the pill renders as span-with-role inside.
  const openOverlay = useAppStore((s) => s.openOverlay);
  const onProviderBusDeepLink = (pluginId: string) => {
    emitDeepLink('bus:filter-kind', 'cli-provider');
    emitDeepLink('bus:expand-plugin', pluginId);
    openOverlay('settings', 'plugins');
  };
  const resolveName = useAgentNames();
  const prof = profileFor(run.emitterId);
  // Handoff framing: the message owner (parentAgentId — the agent that
  // delegated this sub-run) is the pat INITIATOR; the sub-agent (run.emitterId)
  // is the recipient. Only frame as a pat when there's a real, distinct
  // initiator; otherwise fall back to the plain emoji + name header.
  const initiatorId = parentAgentId ?? null;
  const isHandoff =
    !!initiatorId && shortAgentId(initiatorId) !== shortAgentId(run.emitterId);
  const fromName = isHandoff ? resolveName(initiatorId) : '';
  const toName = resolveName(run.emitterId) || prof.displayName;
  const patText = isHandoff
    ? `${fromName}拍了拍${toName}，并${patActionFor(`${run.emitterId}:${run.startedAt}`)}`
    : '';
  const isStreaming = run.status === 'streaming';
  const text = run.text ?? '';
  const { ordered, orphans } = partitionToolCalls(run.toolCalls);
  // Interleave when the run is settled (not streaming) and has both text +
  // ordered tool chips with `at`. Mirrors ForgeCard's canInterleave gate.
  const canInterleave = !isStreaming && ordered.length > 0 && text.length > 0;
  return (
    <div className="sub-agent-card" style={{ borderLeftColor: prof.color }}>
      <button className="sac-header" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {isHandoff ? (
          <>
            {/* 拍一拍发起者的头像 (delegating agent) + 拍一拍文案 */}
            <AgentAvatarVideo
              agentId={initiatorId}
              mode="idle"
              size={18}
              shape="circle"
              className="sac-pat-avatar"
              fallback={<span className="sac-emoji">{profileFor(initiatorId ?? '').emoji}</span>}
            />
            <span className="sac-pat-text">{patText}</span>
          </>
        ) : (
          <>
            <span className="sac-emoji">{prof.emoji}</span>
            <span className="sac-name" style={{ color: prof.color }}>{prof.displayName}</span>
            <span className="sac-role">{t(prof.roleKey)}</span>
          </>
        )}
        {run.providerId && (
          <ProviderBadgePill
            providerId={run.providerId}
            className="sac-provider"
            onBusDeepLink={onProviderBusDeepLink}
          />
        )}
        <span className={`sac-status ${run.status}`}>
          {isStreaming ? t('subAgent.status.running') : run.status === 'error' ? t('subAgent.status.error') : t('subAgent.status.done')}
        </span>
        <span className="sac-tools">{run.toolCalls.length} tool calls</span>
      </button>
      {open && (
        <div className="sac-body">
          {/* Copy button — only when sub has settled and produced text */}
          {!isStreaming && text.length > 0 && <KcCopyBtn text={text} size="sm" />}

          {/* Thinking — collapsed by default; markdown-rendered when expanded */}
          {run.thinking && (
            <details className="sac-thinking">
              <summary>thinking ({run.thinking.length} chars)</summary>
              <ForgeText text={run.thinking} animated={false} size="sm" />
            </details>
          )}

          {/* Body: interleaved when settled, sequential when streaming */}
          {canInterleave ? (
            <div className="kc-interleaved mp-sm">
              {buildInterleavedSegments(text, ordered).map((s, i) =>
                s.kind === 'text'
                  ? <ForgeText key={i} text={s.value} animated={false} size="sm" />
                  : <ToolChipRow key={`tc-${s.value.callId}`} tc={s.value} size="sm" />,
              )}
              {orphans.length > 0 && (
                <div className="kc-tools mp-sm">
                  {orphans.map((tc) => <ToolChipRow key={tc.callId} tc={tc} size="sm" />)}
                </div>
              )}
            </div>
          ) : (
            <>
              {text && <ForgeText text={text} animated={isStreaming} size="sm" />}
              {run.toolCalls.length > 0 && (
                <div className="kc-tools mp-sm">
                  {run.toolCalls.map((tc) => <ToolChipRow key={tc.callId} tc={tc} size="sm" />)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
