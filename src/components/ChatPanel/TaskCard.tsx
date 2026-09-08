import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useTaskFlowUiStore } from '../../task-flow/ui-store';
import type { Task } from '../../task-flow/model';
import { StepRow } from './StepRow';
import { useAgentIdentities } from './agent-identity';
import { useOpenAgentThread } from './use-agent-thread';
import { defaultStepOpen, defaultTaskOpen } from './process-display';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';

export function TaskCard({
  task,
  roundId,
  archive = false,
  fallbackAgentId,
  defaultOpen = false,
  sid,
}: {
  task: Task;
  roundId: string;
  archive?: boolean;
  fallbackAgentId?: string;
  defaultOpen?: boolean;
  sid?: string;
}) {
  const { t } = useTranslation();
  const key = `${roundId}:${task.id}`;
  const running = task.status === 'in_progress' && !task.demotedFromActive;
  const open = useTaskFlowUiStore((state) => running
    ? true
    : state.openTasks[key] ?? defaultTaskOpen({ defaultOpen, archive, running }));
  const toggleTask = useTaskFlowUiStore((state) => state.toggleTask);
  const openSteps = useTaskFlowUiStore((state) => state.openSteps);
  const toggleStep = useTaskFlowUiStore((state) => state.toggleStep);
  const identity = useAgentIdentities()(task.agentId ?? fallbackAgentId);
  const openAgent = useOpenAgentThread();
  const done = task.status === 'completed';
  return (
    <section
      className={`tx-task tx-task-${task.status} ${open ? 'is-open' : 'is-folded'} ${archive ? 'is-archive' : ''}`}
    >
      <button
        type="button"
        className="tx-th"
        onClick={() => { if (!running) toggleTask(key, open); }}
        aria-expanded={open}
        aria-disabled={running}
      >
        {identity && (
          <>
            <span
              className="tx-th-av is-clickable"
              style={{ '--tx-ac': identity.accent } as React.CSSProperties}
              role="button"
              tabIndex={0}
              title={t('taskFlow.openAgentThread', { name: identity.name })}
              onClick={(e) => { e.stopPropagation(); if (task.agentId) openAgent(task.agentId); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (task.agentId) openAgent(task.agentId); } }}
            >
              <AgentIdentityAvatar identity={identity} agentId={task.agentId ?? fallbackAgentId} size={22} />
            </span>
            <span className="tx-th-who" style={{ color: identity.accent }}>{identity.name}</span>
          </>
        )}
        <span className="tx-th-goal">
          {task.activeForm && running ? task.activeForm : task.content}
        </span>
        <span className="tx-th-st">
          {done
            ? <><CheckCircle2 size={13} aria-hidden="true" />{t('taskFlow.statusDone')}</>
            : running
              ? <><span className="tx-spin" aria-hidden="true" />{t('taskFlow.statusRunning')}</>
              : <>{t('taskFlow.statusPending')}</>}
        </span>
        {!running && (open
          ? <ChevronDown size={13} className="tx-th-cv" aria-hidden="true" />
          : <ChevronRight size={13} className="tx-th-cv" aria-hidden="true" />)}
      </button>
      {running && (
        <div className="tx-prog" aria-hidden="true">
          <i style={{ width: `${progressOf(task)}%` }} />
        </div>
      )}
      <div className="tx-steps-wrap">
        <div className="tx-steps">
          {task.steps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              // While the task is running, keep the latest step's detail open so
              // the current activity (thinking / log / asset pill / diff) stays
              // visible — local tools finish in ms, so without this the running
              // step would collapse to a ✓ row before anything is readable.
              open={openSteps[`${key}:${step.id}`]
                ?? defaultStepOpen({
                  status: step.status,
                  parentRunning: running,
                  latest: index === task.steps.length - 1,
                })}
              onToggle={() => {
                const stepKey = `${key}:${step.id}`;
                const currentOpen = openSteps[stepKey] ?? defaultStepOpen({
                  status: step.status,
                  parentRunning: running,
                  latest: index === task.steps.length - 1,
                });
                toggleStep(stepKey, currentOpen);
              }}
              sid={sid}
              agentId={task.agentId ?? fallbackAgentId}
            />
          ))}
          {!task.steps.length && <div className="tx-steps-empty">{t('taskFlow.stepsEmpty')}</div>}
        </div>
      </div>
    </section>
  );
}

function progressOf(task: Task): number {
  if (!task.steps.length) return 8;
  const finished = task.steps.filter((step) => step.status !== 'running' && step.status !== 'pending').length;
  return Math.max(8, Math.round((finished / task.steps.length) * 100));
}
