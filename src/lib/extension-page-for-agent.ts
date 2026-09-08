/** Keep aligned with @forgeax/agents `extension-page-for-agent`. */
export interface ExtensionWithAgentPages {
  id: string;
  contributes?: {
    pages?: readonly { id: string; preferredAgent?: string }[];
  };
}

/** `@forgeax-extension/agent-gen3d` / `gen3d#1` / `gen3d` → `gen3d`. */
export function agentLookupKey(ref: string): string {
  const last = (ref.split('/').pop() ?? ref).trim();
  const noHash = last.split('#')[0] ?? last;
  return noHash.startsWith('agent-') ? noHash.slice('agent-'.length) : noHash;
}

export function extensionIdForAgent(
  agentId: string,
  extensions: readonly ExtensionWithAgentPages[],
): string | null {
  const key = agentLookupKey(agentId);
  if (!key) return null;
  const matches = extensions.filter((extension) => {
    return extension.contributes?.pages?.some((page) => {
      const preferred = page.preferredAgent;
      return Boolean(preferred) && agentLookupKey(preferred!) === key;
    });
  });
  return matches.length === 1 ? matches[0]!.id : null;
}
