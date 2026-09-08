/**
 * Open the unique extension page that recommends an agent.
 *
 * Lives in chat — not `@forgeax/agents` — because application packages
 * cannot import each other.
 */

import { useShellStore } from '@forgeax/interface/store';
import { listExtensions } from '@forgeax/interface/lib/extension-api';
import { openExtensionPage } from '@forgeax/interface/core/page-navigation';
import { extensionIdForAgent } from './extension-page-for-agent';

export interface OpenAgentWorkspaceOptions {
  switchChat?: boolean;
  fallback?: 'none';
}

export async function openAgentWorkspace(
  agentId: string,
  opts: OpenAgentWorkspaceOptions = {},
): Promise<void> {
  if (!agentId) return;
  const { switchChat = true } = opts;
  const store = useShellStore.getState();
  if (switchChat && store.activeSid) store.setTabAgent(store.activeSid, agentId);
  try {
    const { items } = await listExtensions();
    const extensionId = extensionIdForAgent(agentId, items);
    if (extensionId) await openExtensionPage(extensionId);
  } catch {
    /* bus missing / page host not ready */
  }
}
