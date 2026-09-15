import type { ChatMessage } from '../../session-store';
import type { DelegationMessage } from '../../event-engine/delegation-status';
import { agentIdFromRef } from './handoff-focus';

export type CollaborationStatus = 'dispatched' | 'queued' | 'running' | 'waiting_permission' | 'waiting_input' | 'stopping' | 'responded' | 'returned' | 'failed' | 'cancelled';
export interface CollaborationWork {
  id: string;
  agent: string;
  brief: string;
  status: CollaborationStatus;
  detail: string;
  since: number;
  updatedAt: number;
}

export function isCollaborationActive(status: CollaborationStatus): boolean {
  return !['responded', 'returned', 'failed', 'cancelled'].includes(status);
}

/** Presentation only: unwrap the public result envelope emitted by Session.
 * Never infer lifecycle or success from natural-language result text. */
export function collaborationSummary(text: string): string {
  const content = text.split(/\n--- [^\n]+ 的产出 ---\n/).at(-1) ?? text;
  const line = content.split('\n').find(line => line.trim())?.trim() ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** Public session messages are the authority. Silence never implies success or failure. */
export function collaborationWork(messages: ChatMessage[], owner: string | null, running: Record<string, boolean>, permissionAgent?: string, waitingForInput: string[] = []): CollaborationWork[] {
  if (!owner) return [];
  const current = agentIdFromRef(owner);
  const legacy = new Map<string, CollaborationWork>();
  const lifecycle = new Map<string, CollaborationWork>();
  const busy = new Set(Object.entries(running).filter(([, value]) => value).map(([id]) => agentIdFromRef(id)));
  for (const message of [...messages].sort((a, b) => a.ts - b.ts)) {
    const snapshot = (message as ChatMessage & DelegationMessage).delegation;
    if (snapshot) {
      if (message.to && agentIdFromRef(message.to) !== current) continue;
      const agent = agentIdFromRef(snapshot.agent);
      if (agent === current) continue;
      const id = `${snapshot.ownerTaskId}:${snapshot.delegationId}`;
      const previous = lifecycle.get(id);
      lifecycle.set(id, {
        id, agent, brief: previous?.brief || legacy.get(agent)?.brief || '',
        status: snapshot.status === 'returned' ? snapshot.outcome === 'failed' ? 'failed' : snapshot.outcome === 'cancelled' ? 'cancelled' : 'returned' : snapshot.status,
        detail: message.text, since: previous?.since ?? legacy.get(agent)?.since ?? message.ts, updatedAt: message.ts,
      });
      continue;
    }
    if (message.role !== 'system' || !message.from || !message.to) continue;
    const from = agentIdFromRef(message.from);
    const to = agentIdFromRef(message.to);
    if (from === to) continue;
    if (from === current) {
      // Only a real dispatch is an assignment. A specialist's outgoing result
      // must not create a fictitious task delegated back to its parent.
      if (!message.source?.includes('user_input') || message.level === 'error' || message.level === 'warning') continue;
      legacy.set(to, { id: message.id, agent: to, brief: message.text, status: busy.has(to) ? 'running' : 'dispatched', detail: '', since: message.ts, updatedAt: message.ts });
    } else if (to === current) {
      const previous = legacy.get(from);
      if (previous) legacy.set(from, { ...previous, status: message.level === 'error' ? 'failed' : busy.has(from) ? 'running' : 'responded', detail: message.text, updatedAt: message.ts });
    }
  }
  // Structured task identities remain separate, including late results from an older task.
  const result = [...lifecycle.values()];
  for (const work of legacy.values()) {
    if (!result.some(item => item.agent === work.agent && item.updatedAt >= work.since)) result.push(work);
  }
  return result.sort((a, b) => a.updatedAt - b.updatedAt).map(work => isCollaborationActive(work.status) && permissionAgent && agentIdFromRef(permissionAgent) === work.agent
    ? { ...work, status: 'waiting_permission' as const }
      : isCollaborationActive(work.status) && waitingForInput.some(agent => agentIdFromRef(agent) === work.agent)
        ? { ...work, status: 'waiting_input' as const } : work);
}

export function collaborationStatusLabel(status: CollaborationStatus, zh: boolean): string {
  const labels: Record<CollaborationStatus, [string, string]> = {
    dispatched: ['已派发，等待进展', 'Assigned · awaiting an update'], queued: ['等待开始', 'Waiting to start'],
    running: ['正在执行', 'Working'], waiting_input: ['需要你补充信息', 'Your input is needed'], waiting_permission: ['需要授权', 'Approval needed'], stopping: ['正在收尾', 'Finishing safely'],
    responded: ['已收到回复', 'Reply received'], returned: ['已返回结果', 'Result returned'], failed: ['执行失败', 'Failed'], cancelled: ['已取消', 'Cancelled'],
  };
  return labels[status][zh ? 0 : 1];
}
