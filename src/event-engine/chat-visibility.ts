/** Chat is a user-facing projection, not an EventBus/diagnostic viewer.
 * Keep this policy shared by live dispatch and ledger replay. New event types
 * must opt in here after acquiring a user-facing contract; a text/summary/error
 * field (or a kernel source) is never sufficient authorization to render.
 * This only controls presentation: ledger persistence and state updates remain
 * owned by their existing consumers.
 */
const CHAT_MESSAGE_EVENTS = new Set([
  'compaction.status',
  'user_input',
  'message',
  'agent_command',
  'media_attachment',
  'hook:assistantMessage',
  'hook:toolCall',
  'hook:toolResult',
  'hook:turnEnd',
  'hook:llmFallback',
  'hook:llmRetry',
  'stream:llm',
  'stream:tool_use',
  'stream:tool_result',
  'subagent_launched',
  'subagent_task',
  'subagent_result',
  'subagent_error',
  'agent_crash',
]);

export function isChatMessageEvent(type: string, payload: Record<string, unknown>): boolean {
  if (payload.visibility === 'private_reasoning') return false;
  if (type === 'agent_log') return payload.visibility === 'public_summary';
  return CHAT_MESSAGE_EVENTS.has(type);
}
