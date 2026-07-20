/** `@forgeax/chat` session-store — chat's OWN message + conversation domain (R4).
 *
 *  The single chokepoint through which chat code (and the L3 host's boot) reach
 *  the message-content domain chat owns: the conversation store keyed by
 *  `(sid, agentId)`, the WS event → message translator, the daemon-tick bridge,
 *  and the conversation message model.
 *
 *  WHAT LIVES HERE (chat, L2)
 *  --------------------------
 *  `useChatStore` — messages / streaming flags / contextPct / send queue /
 *  rewind state, plus the send + WAL-replay + live-stream pipelines.
 *
 *  WHAT IS DELIBERATELY NOT HERE (interface, L1)
 *  ---------------------------------------------
 *  The session REGISTRY (`tabs` / `activeSid` / `switchToSession` / agent
 *  binding) and agent-runtime state (`liveAgents` / `agentFileActivity`) are L1
 *  platform concerns shared by dashboard / workbench / the shell chrome — chat
 *  reads them from `@forgeax/interface/store` on demand but never owns them. The
 *  message *types* (`ChatMessage` etc.) remain L1 contracts re-exported below so
 *  the shared event-engine (also L1) and chat agree on one shape.
 */

// daemon-tick bridge (writes /loop ticks into chat). R5/P1: no longer a
// module-load socket side-effect — chat boot calls subscribeDaemonTick() to
// attach it to the shared L1 broadcast stream.
export { subscribeDaemonTick } from './daemon-tick';

export type {
  ChatMessage,
  ChatSegment,
  ToolCall,
  SubAgentRun,
} from '@forgeax/interface/store';

export {
  useChatStore,
  appendChatSegment,
  upsertToolSegment,
  markEmittedClientMsg,
  isOwnUserInput,
  useActiveMessages,
  useActiveStreaming,
  useActiveContextPct,
  useActivePendingRewind,
  useActiveRewindDirtyNotice,
  useActiveCheckpointMsgIds,
  useActiveStreamingByAgent,
  type ConvSlice,
  type QueuedMessage,
  type SendMessageOpts,
  type PendingRewind,
  type RewindDirtyNotice,
} from './store';

export { subscribeSessionStream } from './session-stream';

export {
  fetchSessionList,
  createSession,
  deleteSession,
  emitForgeaXMessage,
  listSessionAgents,
  connectForgeaXWs,
  disconnectForgeaXWs,
  onSessionEvent,
  type SessionMeta,
  type SessionEvent,
  type ForgeaXAgentNode,
} from '../session-bridge';
