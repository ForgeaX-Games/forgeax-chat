import { askRequestId } from './message-parts/ask-user-batch';
import type { Step } from '../../task-flow/model';

export function canGroupTool(step: Step): boolean {
  return !!step.tool && !/ask_?user|AskUserQuestion|subagent|delegate|handoff|deliver|todo|permission|approval/i.test(step.tool.name);
}

export function groupConsecutive<T>(items: T[], eligible: (item: T) => boolean): T[][] {
  const groups: T[][] = [];
  let collecting = false;
  for (const item of items) {
    const next = eligible(item);
    if (next && collecting) groups[groups.length - 1].push(item);
    else groups.push([item]);
    collecting = next;
  }
  return groups;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;
export function toolGroupLabel(steps: Step[], t: Translate): string {
  const count = steps.length;
  const failed = steps.filter(step => step.status === 'error').length;
  const running = steps.some(step => step.status === 'running' || step.status === 'pending');
  const frozen = steps.some(step => step.status === 'frozen');
  const base = t(`taskFlow.${running ? 'groupRunning' : frozen ? 'groupStopped' : 'groupDone'}`, { count });
  if (failed) return `${base}${t('taskFlow.groupFailures', { count: failed })}`;
  if (running || frozen) return base;
  const counts = new Map<string, number>();
  for (const step of steps) {
    const kind = step.tool?.name === 'read_file' ? 'groupReads'
      : step.tool?.name === 'list_dir' ? 'groupDirectories'
        : /^(bash|shell)$/.test(step.tool?.name ?? '') ? 'groupCommands' : 'unknown';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size > 2 || counts.has('unknown')) return base;
  // Count calls, not files: repeated reads and missing paths stay truthful.
  return [...counts].map(([kind, count]) => t(`taskFlow.${kind}`, { count })).join(t('taskFlow.groupSeparator'));
}

export function canBatchAsk(step: Step): boolean {
  return step.tool?.name === 'ask_user' && !!askRequestId(step.tool);
}

/** Keep tool summaries and input requests in separate consecutive groups. */
export function groupProcessItems<T>(items: T[], stepOf: (item: T) => Step | undefined): T[][] {
  const groups: T[][] = [];
  let previous = '';
  for (const item of items) {
    const step = stepOf(item);
    const kind = step && canBatchAsk(step) ? 'ask' : step && canGroupTool(step) ? 'tool' : '';
    if (kind && kind === previous) groups[groups.length - 1].push(item);
    else groups.push([item]);
    previous = kind;
  }
  return groups;
}
