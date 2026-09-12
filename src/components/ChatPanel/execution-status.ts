import type { ProcessTrace } from '../../task-flow/model';

/** Permission facts apply only to the live process owned by that agent. */
export function processWaitsForPermission(process: ProcessTrace, pending: { agent: string } | null): boolean {
  return (process.phase === 'running' || process.phase === 'waiting_for_input') &&
    !!pending && pending.agent === process.agentIds[0];
}
