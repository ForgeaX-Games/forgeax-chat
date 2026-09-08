/** In-memory composer drafts keyed by session + bound agent.
 * Same lifetime as ChatPanel editDrafts: survives tab remounts, dies on reload. */
const drafts = new Map<string, string>();

export function composerDraftKey(sid: string, agentId: string): string {
  return `${sid}::${agentId}`;
}

export function readComposerDraft(
  sid: string | null | undefined,
  agentId: string | null | undefined,
): string {
  if (!sid || !agentId) return '';
  return drafts.get(composerDraftKey(sid, agentId)) ?? '';
}

export function writeComposerDraft(
  sid: string | null | undefined,
  agentId: string | null | undefined,
  value: string,
): void {
  if (!sid || !agentId) return;
  const key = composerDraftKey(sid, agentId);
  if (value) drafts.set(key, value);
  else drafts.delete(key);
}

export function clearComposerDraft(
  sid: string | null | undefined,
  agentId: string | null | undefined,
): void {
  if (!sid || !agentId) return;
  drafts.delete(composerDraftKey(sid, agentId));
}

export function resetComposerDrafts(): void {
  drafts.clear();
}
