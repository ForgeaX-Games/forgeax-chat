import type { ChatMessage } from '../../session-store';
import type { DelegationMessage } from '../../event-engine/delegation-status';
import { agentIdFromRef } from './handoff-focus';

function startedAt(message: ChatMessage): number {
  // Replay may create the assistant row at its first output/turn end. The
  // public live anchor retains the actual turn start across live and replay.
  const anchor = message.role === 'assistant' ? message.msgId?.match(/^live:.+:(\d+)$/) : null;
  return anchor ? Number(anchor[1]) : message.ts;
}

/** Fold only text responses between a peer reply and the remaining replies.
 * Reconstruct from the ordered public history, not today's streaming flags:
 * finishing/reloading a batch must not resurrect its intermediate cards.
 * User input and actionable work always retain their own timeline entries. */
export function collaborationUpdates(messages: ChatMessage[], owner: string | null): ChatMessage[] {
  if (!owner) return [];
  const current = agentIdFromRef(owner);
  const pending = new Set<string>();
  const updates: ChatMessage[] = [];
  let receivedReply = false;
  let actionable = false;
  for (const message of [...messages].sort((a, b) => startedAt(a) - startedAt(b))) {
    if (message.role === 'user') {
      pending.clear();
      receivedReply = false;
      actionable = false;
      continue;
    }
    if (message.level === 'error' || message.level === 'warning') actionable = true;
    const delegation = (message as ChatMessage & DelegationMessage).delegation;
    if (delegation && (!message.to || agentIdFromRef(message.to) === current)) {
      const agent = agentIdFromRef(delegation.agent);
      if (agent === current) continue;
      if (delegation.status === 'returned') {
        pending.delete(agent);
        receivedReply = true;
        if (delegation.outcome !== 'completed') actionable = true;
      } else {
        pending.add(agent);
        if (delegation.status === 'waiting_permission' || delegation.status === 'stopping') actionable = true;
      }
      continue;
    }
    if (message.role === 'system' && message.from && message.to) {
      const from = agentIdFromRef(message.from);
      const to = agentIdFromRef(message.to);
      if (from === current && to !== current && message.source?.includes('user_input')) {
        if (!pending.size) receivedReply = false;
        pending.add(to);
      } else if (to === current && pending.has(from) && !message.source?.includes('user_input')) {
        pending.delete(from);
        receivedReply = true;
      }
      continue;
    }
    if (message.role !== 'assistant' || !receivedReply || !pending.size || actionable) continue;
    if (message.status === 'error' || message.errorMessage || message.turnAborted || message.artifact
      || message.toolCalls.length || message.segments?.some(segment => segment.kind === 'tool')) continue;
    updates.push(message);
  }
  return updates;
}
