import { Brain, ChevronDown, ChevronRight, CircleAlert, FileCog, MessageSquareText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useTaskFlowUiStore } from '../../task-flow/ui-store';
import type { ProcessEntry, ProcessTrace } from '../../task-flow/model';
import { StepRow } from './StepRow';
import { MarkdownView } from './MarkdownView';
import { defaultProcessOpen } from './process-visibility';
import { PlanCard } from './PlanCard';
import { TaskCard } from './TaskCard';
import { splitTodoProcessWindow, tasksFromProcess } from '../../task-flow/process-tasks';
import { defaultStepOpen, defaultTodoExecutionOpen, formatDuration } from './process-display';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';
import { useAgentIdentities } from './agent-identity';

export { formatDuration } from './process-display';

/** The process is owned by the Forge response body. Todo is rendered as one of
 * its entries, never as a sibling owned by an artifact or by a user message. */
export function ProcessAccordion({ process, hasArtifact }: { process: ProcessTrace; hasArtifact: boolean }) {
  const { t } = useTranslation();
  const live = process.phase === 'running' || process.phase === 'waiting_for_input';
  const failed = process.phase === 'error' || process.phase === 'aborted';
  const openOverride = useTaskFlowUiStore((state) => state.openProcesses[process.id]);
  const open = live ? true : openOverride ?? defaultProcessOpen(false, hasArtifact, failed);
  const toggle = useTaskFlowUiStore((state) => state.toggleProcess);
  const reset = useTaskFlowUiStore((state) => state.resetProcess);

  useEffect(() => {
    // A delivered artifact starts phase two of the turn. Only that transition
    // folds the whole execution phase; a text-only turn keeps its public
    // execution narration visible and folds just the internal detail blocks.
    if (hasArtifact) reset(process.id);
  }, [hasArtifact, process.id, reset]);

  const now = useProcessClock(live);
  const duration = formatDuration(process.durationMs ?? Math.max(0, now - process.startedAt));
  const phaseLabel = process.phase === 'error' ? t('taskFlow.processError')
    : process.phase === 'aborted' ? t('taskFlow.processAborted')
      : process.phase === 'waiting_for_input' ? t('taskFlow.processWaiting') : '';

  return (
    <section
      className={`tx-proc tx-process tx-phase-${process.phase} ${open ? 'is-open' : ''}`}
      data-testid="chat-process"
      data-process-id={process.id}
      data-phase={process.phase}
    >
      <button
        type="button"
        className="tx-proc-head"
        onClick={() => { if (!live) toggle(process.id, open); }}
        disabled={live}
        aria-expanded={open}
        aria-disabled={live}
        aria-label={open ? t('taskFlow.collapseProcess') : t('taskFlow.expandProcess')}
      >
        {!live && <ChevronRight size={13} className="tx-proc-cv" aria-hidden="true" />}
        <Brain size={15} className="tx-proc-brain" aria-hidden="true" />
        <span className="tx-proc-lbl">
          {t('taskFlow.workedFor', { duration })}
          {!live && phaseLabel ? ` · ${phaseLabel}` : ''}
        </span>
        {live && <span className="tx-proc-mt">{process.phase === 'waiting_for_input' ? t('taskFlow.processWaiting') : t('taskFlow.processRunning')}</span>}
      </button>

      {open && (
        <div className="tx-proc-body">
          {process.todo
            ? <TodoProcess process={process} live={live} />
            : (
              <div className="tx-process-entries">
                {process.entries.map((entry, index) => (
                  <Entry
                    key={entry.id}
                    entry={entry}
                    active={live && index === process.entries.length - 1}
                    durationMs={Math.max(0, (process.entries[index + 1]?.ts ?? process.finishedAt ?? Date.now()) - entry.ts)}
                    live={live}
                    sid={process.sid}
                    agentId={process.agentIds[0]}
                  />
                ))}
              </div>
            )}
        </div>
      )}
    </section>
  );
}

/** Keep the persistent Worked-for header truthful even while the model is
 * silent in a long tool call or waiting for user input. */
function useProcessClock(live: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

function ProcessEntries({ entries, process, live }: { entries: ProcessEntry[]; process: ProcessTrace; live: boolean }) {
  return entries.length ? (
    <div className="tx-process-entries">
      {entries.map((entry, index) => (
        <Entry
          key={entry.id}
          entry={entry}
          active={live && index === entries.length - 1}
          durationMs={Math.max(0, (entries[index + 1]?.ts ?? process.finishedAt ?? Date.now()) - entry.ts)}
          live={live}
          sid={process.sid}
          agentId={process.agentIds[0]}
        />
      ))}
    </div>
  ) : null;
}

function TodoProcess({ process, live }: { process: ProcessTrace; live: boolean }) {
  const window = splitTodoProcessWindow(process);
  return (
    <>
      <ProcessEntries entries={window.before} process={process} live={live} />
      <TodoExecution process={process} />
      <ProcessEntries entries={window.after} process={process} live={live} />
    </>
  );
}

function TodoExecution({ process }: { process: ProcessTrace }) {
  const { t } = useTranslation();
  const tasks = tasksFromProcess(process);
  const fallbackAgentId = process.agentIds[0];
  const visibleTasks = tasks.filter((task) => task.steps.length > 0 || task.status === 'in_progress');
  const live = process.phase === 'running' || process.phase === 'waiting_for_input';
  const [open, setOpen] = useState(defaultTodoExecutionOpen(live));
  const identify = useAgentIdentities();
  useEffect(() => { setOpen(defaultTodoExecutionOpen(live)); }, [live]);
  const stepCount = tasks.reduce((count, task) => count + task.steps.length, 0);
  const duration = formatDuration(process.durationMs ?? Math.max(0, Date.now() - process.startedAt));
  return (
    <div className={`tx-todo-execution ${open ? 'is-open' : 'is-folded'}`} data-testid="todo-execution-flow">
      <button
        type="button"
        className="tx-todo-toggle"
        onClick={() => { if (!live) setOpen((value) => !value); }}
        aria-expanded={open}
        aria-disabled={live}
      >
        {!live && (open
          ? <ChevronDown size={13} className="tx-todo-toggle-cv" aria-hidden="true" />
          : <ChevronRight size={13} className="tx-todo-toggle-cv" aria-hidden="true" />)}
        <span className="tx-todo-toggle-avatars" aria-hidden="true">
          {(process.agentIds.length ? process.agentIds : ['forge']).slice(0, 3).map((agentId) => (
            <span className="tx-todo-toggle-avatar-shell" key={agentId}>
              <AgentIdentityAvatar identity={identify(agentId)} agentId={agentId} size={20} />
            </span>
          ))}
        </span>
        <span className="tx-todo-toggle-title">{t('taskFlow.process')}</span>
        <span className="tx-todo-toggle-meta">{t('taskFlow.processMeta', { steps: stepCount, duration })}</span>
      </button>
      {open && (
        <div className="tx-live-task-flow">
          <PlanCard tasks={tasks} phase={process.phase} fallbackAgentId={fallbackAgentId} />
          {visibleTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              roundId={process.id}
              fallbackAgentId={fallbackAgentId}
              sid={process.sid}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Entry({
  entry,
  active,
  durationMs,
  live,
  sid,
  agentId,
}: {
  entry: ProcessEntry;
  active: boolean;
  durationMs: number;
  live: boolean;
  sid?: string;
  agentId?: string;
}) {
  switch (entry.kind) {
    case 'thinking_summary':
      return <ThinkingEntry text={entry.text} active={active} durationMs={durationMs} />;
    case 'assistant_intermediate':
      return <div className="tx-process-entry tx-process-intermediate"><MessageSquareText size={13} /><MarkdownView text={entry.text} /></div>;
    case 'tool':
      return <ToolEntry entry={entry} sid={sid} agentId={agentId} />;
    case 'subagent':
      return <div className="tx-process-entry tx-process-subagent"><CircleAlert size={13} />{entry.agentId}</div>;
    case 'todo_snapshot':
      return null;
  }
}

function ThinkingEntry({ text, active, durationMs }: { text: string; active: boolean; durationMs: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(active);
  useEffect(() => { setOpen(active); }, [active]);
  return (
    <section className={`tx-process-detail tx-process-thinking ${open ? 'is-open' : ''}`} data-visibility="public_summary">
      <button
        type="button"
        className="tx-process-entry-head"
        aria-expanded={open}
        aria-disabled={active}
        onClick={() => { if (!active) setOpen((value) => !value); }}
      >
        {!active && <ChevronRight size={13} className="tx-process-entry-cv" />}
        <Brain size={13} />
        <span>{active
          ? t('taskFlow.thinkingActive')
          : t('taskFlow.thoughtFor', { duration: formatDuration(durationMs) })}</span>
      </button>
      {open && <div className="tx-process-detail-body">{text}</div>}
    </section>
  );
}

function ToolEntry({ entry, sid, agentId }: { entry: Extract<ProcessEntry, { kind: 'tool' }>; sid?: string; agentId?: string }) {
  const active = defaultStepOpen({ status: entry.step.status });
  const isAskUser = entry.step.tool?.name === 'ask_user';
  const [open, setOpen] = useState(active);
  useEffect(() => { setOpen(active); }, [active]);
  return (
    <div className={`tx-process-entry tx-process-tool${isAskUser ? ' tx-process-ask' : ''}`}>
      {!isAskUser && <FileCog size={13} />}
      <StepRow step={entry.step} open={open} onToggle={() => setOpen((value) => !value)} sid={sid} agentId={agentId} />
    </div>
  );
}
