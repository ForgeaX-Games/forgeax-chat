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
  return runningHandoffs(messages, currentAgent, running).length > 0;
}

/** Latest outgoing assignments whose recipients are actually streaming in this session. */
export function runningHandoffs(messages: ChatMessage[], currentAgent: string | null, running: Record<string, boolean>): ChatMessage[] {
  if (!currentAgent) return [];
  const seen = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of [...messages].reverse()) {
    const peer = handoffNavigationTarget(message, currentAgent);
    if (!peer || seen.has(peer)) continue;
    seen.add(peer);
    if (agentIdFromRef(message.from!) === agentIdFromRef(currentAgent) && running[peer]) result.unshift(message);
  }
  return result;
}
