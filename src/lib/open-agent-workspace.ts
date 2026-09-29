import {
	listExtensions,
	openExtensionPage,
	useShellStore,
} from "@forgeax/chat/runtime";
import { extensionIdForAgent } from "./extension-page-for-agent";
/**
 * Open the unique extension page that recommends an agent.
 *
 * Lives in chat — not `@forgeax/agents` — because application packages
 * cannot import each other.
 */

export interface OpenAgentWorkspaceOptions {
	switchChat?: boolean;
	fallback?: "none";
}

export async function openAgentWorkspace(
	agentId: string,
	opts: OpenAgentWorkspaceOptions = {},
): Promise<void> {
	if (!agentId) return;
	const { switchChat = true } = opts;
	const store = useShellStore.getState();
	if (switchChat && store.activeSid)
		store.setTabAgent(store.activeSid, agentId);
	try {
		const { items } = await listExtensions();
		const extensionId = extensionIdForAgent(agentId, items);
		if (extensionId) await openExtensionPage(extensionId);
	} catch {
		/* bus missing / page host not ready */
	}
}
