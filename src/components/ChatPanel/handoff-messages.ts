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
