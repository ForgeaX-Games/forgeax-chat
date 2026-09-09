import type { ChatMessage } from '../../session-store';

/** Routine delegation traffic has its own bounded feed; alerts stay in the main conversation. */
export function isAgentHandoff(message: ChatMessage): boolean {
  return message.role === 'system' && message.level !== 'error' && message.level !== 'warning'
    && !!message.from && !!message.to;
}
