import { dropPermissionSession } from "../permission-stream";
import { deleteSession as deleteSessionBridge } from "../session-bridge";

/** `@forgeax/chat` session-store — chat's OWN message + conversation domain (R4).
 *
 *  The single chokepoint through which chat code (and the product host's boot) reach
 *  the message-content domain chat owns: the conversation store keyed by
 *  `(sid, agentId)`, the WS event → message translator, the daemon-tick bridge,
 *  and the conversation message model.
 *
 *  WHAT LIVES HERE (INDEPENDENT CHAT APP)
 *  --------------------------------------
 *  `useChatStore` — messages / streaming flags / contextPct / send queue /
 *  rewind state, plus the send + WAL-replay + live-stream pipelines.
 *
 *  WHAT IS DELIBERATELY NOT HERE (SHARED INTERFACE BASE)
 *  ------------------------------------------------------
 *  The session REGISTRY (`tabs` / `activeSid` / `switchToSession` / agent
 *  binding) and agent-runtime state (`liveAgents` / `agentFileActivity`) are shared
 *  platform concerns shared by dashboard / page / the shell chrome — chat
 *  reads them from `the product-injected runtime store` on demand but never owns them. The
 *  message *types* (`ChatMessage` etc.) remain Interface contracts re-exported below so
 *  the shared event engine and chat agree on one shape.
 */

export type {
	ChatMessage,
	ChatSegment,
	SubAgentRun,
	ToolCall,
} from "@forgeax/chat/runtime";
export {
	connectForgeaXWs,
	createSession,
	disconnectForgeaXWs,
	emitForgeaXMessage,
	ensureSession,
	type ForgeaXAgentNode,
	fetchSessionList,
	listSessionAgents,
	onSessionEvent,
	type SessionEvent,
	type SessionMeta,
} from "../session-bridge";
// daemon-tick bridge (writes /loop ticks into chat). R5/P1: no longer a
// module-load socket side-effect — chat boot calls subscribeDaemonTick() to
// attach it to the shared Interface broadcast stream.
export { subscribeDaemonTick } from "./daemon-tick";
export { subscribeSessionStream } from "./session-stream";
export {
	appendChatSegment,
	type ConvSlice,
	isOwnUserInput,
	markEmittedClientMsg,
	type PendingRewind,
	type QueuedMessage,
	type RewindDirtyNotice,
	type SendMessageOpts,
	upsertToolSegment,
	useActiveCheckpointMsgIds,
	useActiveContextPct,
	useActiveMessages,
	useActivePendingRewind,
	useActiveRewindDirtyNotice,
	useActiveStreaming,
	useActiveStreamingByAgent,
	useChatStore,
} from "./store";

export async function deleteSession(sid: string): Promise<void> {
	await deleteSessionBridge(sid);
	dropPermissionSession(sid);
}
