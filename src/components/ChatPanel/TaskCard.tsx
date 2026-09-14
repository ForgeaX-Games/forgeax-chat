import { AskUserBatch } from './message-parts/AskUserCard';
import { hasPendingAskUser } from '../../task-flow/ask-user-protocol';
import { executionFailureMessages } from './execution-failure';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useTaskFlowUiStore } from '../../task-flow/ui-store';
import type { Task } from '../../task-flow/model';
import { isTaskComplete, taskProgress, taskProgressKey } from '../../task-flow/task-progress';
import { StepRow } from './StepRow';
import { useAgentIdentities } from './agent-identity';
import { useOpenAgentThread } from './use-agent-thread';
import { defaultStepOpen, defaultTaskOpen } from './process-display';
import { ToolGroup } from './ToolGroup';
import { canGroupTool, canBatchAsk, groupProcessItems } from './tool-groups';
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
  const { t, i18n } = useTranslation();
  const failureCopy = executionFailureMessages(i18n?.language);
  const key = `${roundId}:${task.id}`;
  const running = task.status === 'in_progress' && !task.demotedFromActive && !task.terminalState;
  const waitingForAnswer = hasPendingAskUser(task.steps.flatMap(step => step.tool ? [step.tool] : []));
  const open = useTaskFlowUiStore((state) => running || waitingForAnswer
    ? true
    : state.openTasks[key] ?? defaultTaskOpen({ defaultOpen, archive, running }));
  const toggleTask = useTaskFlowUiStore((state) => state.toggleTask);
  const openSteps = useTaskFlowUiStore((state) => state.openSteps);
  const toggleStep = useTaskFlowUiStore((state) => state.toggleStep);
  const identity = useAgentIdentities()(task.agentId ?? fallbackAgentId);
  const openAgent = useOpenAgentThread();
  const done = isTaskComplete(task);
  const progressKey = taskProgressKey(sid, roundId, task.id);
  const previousProgress = useTaskFlowUiStore((state) => state.taskProgress[progressKey] ?? 0);
  const rememberProgress = useTaskFlowUiStore((state) => state.rememberTaskProgress);
  const progress = taskProgress(task, previousProgress);
  useLayoutEffect(() => {
    // Persist across collapse/remount, but never carry a completed 100% into
    // a task that is subsequently reopened by a new plan update.
    if (running) rememberProgress(progressKey, progress);
  }, [running, progressKey, progress, rememberProgress]);
  const stepsRef = useRef<HTMLDivElement>(null);
  const followStepsRef = useRef(true);
  useLayoutEffect(() => {
    const list = stepsRef.current;
    if (!open || !list) return;
    followStepsRef.current = true;
    list.scrollTop = list.scrollHeight;
    // Detail streaming and collapse animations change height after layout.
    const observer = new ResizeObserver(() => {
      if (followStepsRef.current) list.scrollTop = list.scrollHeight;
    });
    for (const child of list.children) observer.observe(child);
    return () => observer.disconnect();
  }, [task.id, task.steps.length, open]);
  return (
    <section
      className={`tx-task tx-task-${task.status} ${open ? 'is-open' : 'is-folded'} ${archive ? 'is-archive' : ''} ${waitingForAnswer ? 'has-pending-question' : ''}`}
    >
      <button
        type="button"
        className="tx-th"
        onClick={() => { if (!running && !waitingForAnswer) toggleTask(key, open); }}
        aria-expanded={open}
        aria-disabled={running || waitingForAnswer}
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
              : <>{task.terminalState === 'interrupted' ? failureCopy.interruptedTask
                : task.terminalState === 'incomplete' ? failureCopy.unfinishedTask
                  : task.status === 'cancelled' ? failureCopy.cancelledTask : t('taskFlow.statusPending')}</>}
        </span>
        {!running && (open
          ? <ChevronDown size={13} className="tx-th-cv" aria-hidden="true" />
          : <ChevronRight size={13} className="tx-th-cv" aria-hidden="true" />)}
      </button>
      {(running || done) && (
        <div className="tx-prog" role="progressbar" aria-label={task.content}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <i style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="tx-steps-wrap">
        <div className="tx-steps thin-scrollbar" ref={stepsRef} tabIndex={0}
          onScroll={(event) => {
            const list = event.currentTarget;
            followStepsRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 2;
          }}>
          {groupProcessItems(task.steps, step => step).map(group => {
            if (group.length > 1 && canBatchAsk(group[0]) && sid) return <AskUserBatch
              key={group[0].id} calls={group.flatMap(step => step.tool ? [step.tool] : [])}
              sid={sid} agentId={fallbackAgentId ?? task.agentId ?? ''} />;
            const rows = group.map(step => {
              const index = task.steps.indexOf(step);
              return (
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
              agentId={step.tool?.name === 'ask_user' ? fallbackAgentId : task.agentId ?? fallbackAgentId}
            />
              );
            });
            return canGroupTool(group[0])
              ? <ToolGroup key={group[0].id} steps={group}>{rows}</ToolGroup>
              : rows;
          })}
          {!task.steps.length && <div className="tx-steps-empty">{t('taskFlow.stepsEmpty')}</div>}
        </div>
      </div>
    </section>
  );
}
