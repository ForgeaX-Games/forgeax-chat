import { agentIdFromRef } from './handoff-focus';
import type { ChatMessage } from '../../session-store';

/** Routine delegation traffic has its own bounded feed; alerts stay in the main conversation. */
export function isAgentHandoff(message: ChatMessage): boolean {
  return message.role === 'system' && message.level !== 'error' && message.level !== 'warning'
    && !!message.from && !!message.to;
}

/** Navigate to the other participant in this message, never a globally parked agent. */
export function handoffNavigationTarget(message: ChatMessage, currentAgent: string | null): string | null {
  if (!isAgentHandoff(message) || !currentAgent) return null;
  const current = agentIdFromRef(currentAgent);
  const from = agentIdFromRef(message.from!);
  const to = agentIdFromRef(message.to!);
  if (!from || !to || from === to) return null;
  if (from === current) return to;
  if (to === current) return from;
  return null;
}

/** Keep Stop reachable while the visible owner awaits a live dispatched role.
 * The latest exchange for each peer closes an earlier handoff; unrelated
 * session activity and incoming handoffs do not confer cancellation ownership.
 */
export function hasRunningHandoff(messages: ChatMessage[], currentAgent: string | null, running: Record<string, boolean>): boolean {
  if (!currentAgent) return false;
  const current = agentIdFromRef(currentAgent);
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const peer = handoffNavigationTarget(message, currentAgent);
    if (!peer || seen.has(peer)) continue;
    seen.add(peer);
    if (agentIdFromRef(message.from!) === current && running[peer]) return true;
  }
  return false;
}
