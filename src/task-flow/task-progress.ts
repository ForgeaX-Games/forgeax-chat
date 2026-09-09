import type { Task } from './model';

export const MAX_RUNNING_PROGRESS = 95;

export function taskProgressKey(sid: string | undefined, roundId: string, taskId: string): string {
  return JSON.stringify([sid ?? '', roundId, taskId]);
}

export function isTaskComplete(task: Task): boolean {
  return task.status === 'completed' && !task.terminalState
    && !task.steps.some((step) => step.status === 'running' || step.status === 'pending');
}

/** The stream has no authoritative total. Estimate from successful work with
 * a fixed reserve instead of dividing by a denominator that keeps growing. */
export function taskProgress(task: Task, previous = 0): number {
  if (isTaskComplete(task)) return 100;
  const finished = new Set(task.steps.filter((step) => step.status === 'done').map((step) => step.id)).size;
  const estimate = Math.floor(8 + 87 * finished / (finished + 4));
  return Math.min(MAX_RUNNING_PROGRESS, Math.max(8, previous, estimate));
}
