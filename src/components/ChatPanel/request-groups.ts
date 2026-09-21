import type { WorkTimelineItem } from '../../task-flow/model';

interface MessageIdentity { id: string; role: string }
/** Group only within an observed user request in this role's transcript.
 * A missing user anchor (partial history) stays ungrouped. Never merge data. */
export function requestGroups(timeline: readonly WorkTimelineItem[], messages: readonly MessageIdentity[]) {
  const requestByMessage = new Map<string, string>();
  let request: string | undefined;
  for (const message of messages) {
    if (message.role === 'user') request = message.id;
    else if (message.role === 'assistant' && request) requestByMessage.set(message.id, request);
  }
  const groups: { key: string; owner?: string; items: WorkTimelineItem[]; assistantIds: string[] }[] = [];
  for (const item of timeline) {
    if (item.kind === 'process') continue; // ProcessAccordion renders at its message anchor.
    const owner = item.kind === 'message' ? requestByMessage.get(item.messageId) : undefined;
    const previous = groups.at(-1);
    if (owner && previous?.owner === owner) {
      previous.items.push(item);
      previous.assistantIds.push(item.kind === 'message' ? item.messageId : '');
    } else {
      groups.push({ key: owner ? `${owner}:${item.kind === 'message' ? item.messageId : groups.length}` : `row:${groups.length}`, owner, items: [item], assistantIds: owner && item.kind === 'message' ? [item.messageId] : [] });
    }
  }
  return groups;
}
