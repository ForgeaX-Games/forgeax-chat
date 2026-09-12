import { getLocale, useTranslation } from '@forgeax/interface/i18n';
import { CheckCircle2, CircleAlert, CirclePause, Loader2 } from 'lucide-react';
import type { ProcessPhase, Task } from '../../task-flow/model';
import { useAgentIdentities } from './agent-identity';
import { useOpenAgentThread } from './use-agent-thread';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';

/**
 * Round plan overview: one row per planned task, in plan order.
 *
 * The row leads with a status dot and the owning agent's avatar, and closes
 * with that agent's function label — the same identity the task card repeats
 * in its header, so a reader can scan the plan and the execution in one pass.
 */
export function PlanCard({ tasks, phase, fallbackAgentId }: { tasks: Task[]; phase: ProcessPhase; fallbackAgentId?: string }) {
  const { t } = useTranslation();
  const identify = useAgentIdentities();
  const openAgent = useOpenAgentThread();
  if (!tasks.length) return null;
  const owner = identify(fallbackAgentId);
  const settled = tasks.every((task) => task.status === 'completed' || task.status === 'cancelled');
  const live = phase === 'running' || phase === 'waiting_for_input';
  const failed = phase === 'error' || phase === 'aborted';
  const state = failed ? 'stopped' : settled ? 'done' : live ? 'running' : 'stopped';
  const title = t('taskFlow.planTitle', { count: tasks.length });
  const marker = String(tasks.length);
  const at = title.indexOf(marker);
  return (
    <section className="tx-plan">
      <header className="tx-plan-owner">
        <AgentIdentityAvatar identity={owner} agentId={fallbackAgentId} size={24} className="tx-plan-owner-av" />
        <span className="tx-plan-owner-name" style={owner ? { color: owner.accent } : undefined}>
          {owner?.name ?? 'FORGEAX'}
        </span>
        <span className="tx-plan-owner-role">{getLocale() === 'zh' ? '当前执行计划' : 'Current execution plan'}</span>
        <span className={`tx-plan-owner-state is-${state}`}>
          {failed ? <CircleAlert size={14} />
            : settled ? <CheckCircle2 size={14} />
              : live ? <Loader2 size={14} className="spin" /> : <CirclePause size={14} />}
        </span>
      </header>
      <header className="tx-plan-title">
        {at >= 0
          ? <>{title.slice(0, at)}<b className="tx-plan-count">{marker}</b>{title.slice(at + marker.length)}</>
          : title}
      </header>
      <div className="tx-plan-list">
        {tasks.map((task) => {
          const identity = identify(task.agentId ?? fallbackAgentId);
          return (
            <div className={`tx-plan-row tx-status-${task.demotedFromActive ? 'pending' : task.status}`} key={task.id}>
              <span className="tx-plan-dot" aria-hidden="true" />
              {identity && (
                <button
                  type="button"
                  className="tx-plan-av is-clickable"
                  style={{ '--tx-ac': identity.accent } as React.CSSProperties}
                  title={t('taskFlow.openAgentThread', { name: identity.name })}
                  onClick={() => { if (task.agentId) openAgent(task.agentId); }}
                >
                  <AgentIdentityAvatar identity={identity} agentId={task.agentId ?? fallbackAgentId} size={16} />
                </button>
              )}
              <span className="tx-plan-nm">{task.content}</span>
              {identity?.roleLabel && (
                <span className="tx-plan-asg">
                  <span className="tx-plan-arr" aria-hidden="true">↗</span>
                  <span className="tx-plan-role">{identity.roleLabel}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
