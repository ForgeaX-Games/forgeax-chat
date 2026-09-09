import type { ChatMessage } from '../../session-store';
import { isAgentHandoff } from './handoff-messages';

/** One public model return is one unit, even when tokens keep extending it. */
export function messageReadSnapshot(messages: ChatMessage[]): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const message of messages) {
    if (isAgentHandoff(message)) continue;
    if (message.role !== 'assistant') {
      snapshot.set(message.id, message.text.length);
      continue;
    }
    const texts = (message.segments ?? []).filter(segment => segment.kind === 'text');
    if (texts.length) {
      texts.forEach((segment, index) => {
        if (segment.text.length) snapshot.set(`${message.id}:text:${index}`, segment.text.length);
      });
    } else if (message.text.length) {
      snapshot.set(`${message.id}:text:0`, message.text.length);
    }
  }
  return snapshot;
}

export function unreadMessageCount(messages: ChatMessage[], seen: Map<string, number>): number {
  let unread = 0;
  for (const [id, length] of messageReadSnapshot(messages)) {
    const previous = seen.get(id);
    if (previous === undefined || length > previous) unread++;
  }
  return unread;
}
