import { canonicalToolName } from '../../event-engine/tool-name';
import type { SessionEvent } from '../../session-bridge';

/** agent 引用 (path / fullId) → 末段 base id, 去掉前缀路径和 "#1" 实例后缀. */
export function agentIdFromRef(ref: string): string {
  const last = ref.split('/').pop() ?? ref;
  return last.split('#')[0] ?? last;
}

/**
 * Teammate id from an inter-agent `user_input`. Used to park "回到 Gen3D"
 * and to label the pat bubble — the visible tab stays on the sender so
 * per-turn specialist summon is not yanked into the teammate's thread.
 * Null = not a real handoff.
 */
export function focusAgentIdFromHandoff(from: string, to: string): string | null {
  const fromId = agentIdFromRef(from);
  const toId = agentIdFromRef(to);
  if (!fromId || !toId || fromId === toId) return null;
  return toId;
}

/**
 * Resolve a real inter-agent dispatch into the teammate that should be
 * *parked*. This intentionally cannot request a visible-tab switch: a
 * specialist summon stays in Forge's conversation until the user explicitly
 * chooses to open the teammate.
 */
export function parkedAgentIdFromInterAgentHandoff(
  message: Pick<SessionEvent, 'emitterId' | 'event'>,
): string | null {
  const event = message.event;
  if (event.type !== 'user_input' || event.source !== 'agent') return null;
  if ((event.payload as { narrativeAutoNudge?: boolean })?.narrativeAutoNudge) return null;
  return focusAgentIdFromHandoff(
    message.emitterId ?? '',
    typeof event.to === 'string' ? event.to : '',
  );
}

/** Narrow adapter for the one handoff effect that must not change tabs. */
export type SessionEventSubscriber = (
  key: string,
  handler: (message: SessionEvent) => void,
) => () => void;

/**
 * Subscribe to agent-to-agent dispatches for one session. The only permitted
 * effect is parking the teammate; callers receive no activation callback.
 */
export function subscribeToParkedHandoff(
  subscribe: SessionEventSubscriber,
  activeSid: string | null,
  onPark: (agentId: string) => void,
): () => void {
  if (!activeSid) return () => {};
  return subscribe('chat-agent-thread-park', (message) => {
    if (message.sid !== activeSid) return;
    const agentId = parkedAgentIdFromInterAgentHandoff(message);
    if (agentId) onPark(agentId);
  });
}

/**
 * Keep the last sub-agent the user visited, or the last handoff target.
 * Stays put when they remain on (or return to) the root so "回到 Gen3D" works.
 */
export function rememberLastSubAgent(
  prevBySid: Record<string, string>,
  sid: string | null,
  activeAgentId: string | null,
  rootAgentId: string | null,
): Record<string, string> {
  if (!sid || !activeAgentId || !rootAgentId || activeAgentId === rootAgentId) {
    return prevBySid;
  }
  if (prevBySid[sid] === activeAgentId) return prevBySid;
  return { ...prevBySid, [sid]: activeAgentId };
}

/** On the main thread, the parked sub-agent to jump back into. Null if none. */
export function parkedSubAgentId(
  sid: string | null,
  activeAgentId: string | null,
  rootAgentId: string | null,
  lastBySid: Record<string, string>,
): string | null {
  if (!sid || !activeAgentId || !rootAgentId || activeAgentId !== rootAgentId) {
    return null;
  }
  return lastBySid[sid] ?? null;
}

const ASK_USER_LIVE_TYPES = new Set(['hook:toolCall', 'stream:tool_use', 'tool-call']);

export function askUserToolNameFromPayload(payload: Record<string, unknown>): string {
  if (typeof payload.name === 'string' && payload.name) return payload.name;
  const toolCall = payload.toolCall;
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const name = (toolCall as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
  }
  return '';
}

export function askUserCallIdFromPayload(payload: Record<string, unknown>): string {
  if (typeof payload.callId === 'string' && payload.callId) return payload.callId;
  if (typeof payload.toolUseId === 'string' && payload.toolUseId) return payload.toolUseId;
  const toolCall = payload.toolCall;
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const id = (toolCall as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return '';
}

/**
 * A teammate's native ask_user card lives on that teammate's thread.
 * Dispatch stays on Forge; only a pending card may pull focus.
 * CLI permission asks (`permissionPrompt: true`) already overlay globally.
 */
export function focusAgentIdFromAskUser(input: {
  emitterId: string;
  rootAgentId: string | null;
  eventType: string;
  toolName: string;
  permissionPrompt?: unknown;
}): string | null {
  if (!ASK_USER_LIVE_TYPES.has(input.eventType)) return null;
  if (canonicalToolName(input.toolName) !== 'ask_user') return null;
  if (input.permissionPrompt === true) return null;
  const emitter = agentIdFromRef(input.emitterId);
  const root = input.rootAgentId ? agentIdFromRef(input.rootAgentId) : '';
  if (!emitter || !root || emitter === root) return null;
  return emitter;
}
