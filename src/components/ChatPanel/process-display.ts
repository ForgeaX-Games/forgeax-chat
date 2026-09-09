/** Presentation helpers shared by the process and Todo renderers. Kept free of
 * React so lifecycle/default-state behavior can be tested independently. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0.1, Number.isFinite(durationMs) ? durationMs / 1000 : 0.1);
  if (seconds < 10) {
    const precise = seconds.toFixed(1).replace(/\.0$/, '');
    return `${precise}s`;
  }
  const wholeSeconds = Math.round(seconds);
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  if (wholeSeconds >= 3600) {
    return `${Math.floor(wholeSeconds / 3600)}h${String(Math.floor(wholeSeconds % 3600 / 60)).padStart(2, '0')}m${String(wholeSeconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(wholeSeconds / 60)}m${String(wholeSeconds % 60).padStart(2, '0')}s`;
}

export function defaultTodoExecutionOpen(live: boolean): boolean {
  return live;
}

export function defaultTaskOpen({
  defaultOpen,
  archive,
  running,
}: {
  defaultOpen: boolean;
  archive: boolean;
  running: boolean;
}): boolean {
  return defaultOpen || (!archive && running);
}

/** A failed tool is terminal, not active. Keep its details folded until the
 * user explicitly opens them; only live execution may force details visible. */
export function defaultStepOpen({
  status,
  parentRunning = false,
  latest = false,
}: {
  status: 'pending' | 'running' | 'done' | 'error' | 'frozen';
  parentRunning?: boolean;
  latest?: boolean;
}): boolean {
  if (status === 'error') return false;
  return status === 'running' || (parentRunning && latest);
}

export function effectiveStepOpen(open: boolean, status: 'pending' | 'running' | 'done' | 'error' | 'frozen'): boolean {
  return open || status === 'running';
}
