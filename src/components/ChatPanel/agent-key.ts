/** Normalise a preferredAgent manifest value to the runtime agent key. */
export function extensionIdToAgentKey(extensionId?: string): string | null {
  if (!extensionId) return null;
  return extensionId.replace(/^@forgeax-(?:extension|plugin)\/agent-/, '') || null;
}

/** Resolve the page-level ManifestV2 preferred agent for the active page. */
export function preferredAgentKeyForPage(
  extensions: readonly {
    id: string;
    contributes?: {
      pages?: readonly { id: string; preferredAgent?: string }[];
    };
  }[],
  activeOwner: string | undefined,
  activeTypeId: string | undefined,
): string | null {
  if (!activeOwner || !activeTypeId) return null;
  const pagePrefix = `${activeOwner}#page/`;
  if (!activeTypeId.startsWith(pagePrefix)) return null;
  const localPageId = activeTypeId.slice(pagePrefix.length);
  if (!localPageId) return null;
  const extension = extensions.find((item) => item.id === activeOwner);
  const page = extension?.contributes?.pages?.find((item) => item.id === localPageId);
  return extensionIdToAgentKey(page?.preferredAgent);
}

/** A stable compact label when the server avatar is an emoji or absent. */
export function avatarInitials(id: string, serverAvatar?: string): string {
  const avatar = serverAvatar?.trim();
  if (avatar && /^[A-Za-z]{1,2}$/.test(avatar)) return avatar;
  const parts = id.split(/[-_]+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 2).map((part) => part[0]!.toUpperCase()).join('');
  return (parts[0] ?? id).slice(0, 2).toUpperCase();
}

/** Allocate initials for a visible list, resolving collisions deterministically. */
export function avatarInitialsForAgents(agents: Array<{ id: string; avatar?: string }>): Record<string, string> {
  const hasAsciiAvatar = (agent: { avatar?: string }) => !!agent.avatar?.trim() && /^[A-Za-z]{1,2}$/.test(agent.avatar.trim());
  const fallbackFor = (id: string) => id.split(/[-_]+/)[0]!.slice(0, 2).toUpperCase();
  const byBase = new Map<string, Array<{ id: string; avatar?: string }>>();
  for (const agent of agents) {
    const base = avatarInitials(agent.id, agent.avatar);
    byBase.set(base, [...(byBase.get(base) ?? []), agent]);
  }
  const used = new Set<string>();
  const result: Record<string, string> = {};
  const allocate = (candidate: string): string => {
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
    const stem = candidate[0] ?? 'A';
    for (let suffix = 2; ; suffix += 1) {
      const next = `${stem}${suffix}`;
      if (!used.has(next)) { used.add(next); return next; }
    }
  };
  for (const base of [...byBase.keys()].sort()) {
    const group = byBase.get(base)!.slice().sort((a, b) =>
      Number(hasAsciiAvatar(b)) - Number(hasAsciiAvatar(a)) || a.id.localeCompare(b.id));
    group.forEach((agent, index) => {
      result[agent.id] = allocate(index === 0 ? base : fallbackFor(agent.id));
    });
  }
  return result;
}

/** Match a preferred key against the runtime id (including multi-instance #N). */
export function agentMatches(candidateId: string, key: string): boolean {
  return candidateId === key || candidateId.startsWith(`${key}#`);
}

/** Pure state transition used when panel data arrives or the active panel changes. */
export function reconcileSummonSelection(
  current: { summonAgentId: string | null; manual: boolean },
  preferredAgentId: string | null,
  panelChanged: boolean,
  availableAgentIds?: readonly string[],
): { summonAgentId: string | null; manual: boolean } {
  if (panelChanged) return { summonAgentId: preferredAgentId, manual: false };
  // Loading/failure is not evidence that the selected agent disappeared.
  // Preserve both the raw id and its provenance; resolveSummonAgentId keeps
  // the wire/UI fail-closed until a concrete catalog arrives again.
  if (availableAgentIds === undefined) return current;
  if (current.summonAgentId && availableAgentIds && !availableAgentIds.includes(current.summonAgentId)) {
    // Preserve whether this was an automatic default or an explicit choice.
    // An automatic default can recover when the registry supplies a later
    // preferred agent; a removed manual selection must remain intentionally
    // clear instead of silently switching experts.
    return { summonAgentId: null, manual: current.manual };
  }
  return current.manual ? current : { summonAgentId: preferredAgentId, manual: false };
}

/**
 * New messages may only carry an expert that is present in the current visible
 * agent list. `undefined` is deliberately fail-closed: the list is loading or
 * failed, so a stale raw selection must not cross the wire invisibly.
 */
export function resolveSummonAgentId(
  summonAgentId: string | null,
  availableAgentIds: readonly string[] | undefined,
  summonEnabled = true,
): string | null {
  return summonEnabled && summonAgentId && availableAgentIds?.includes(summonAgentId) ? summonAgentId : null;
}

/**
 * A persistent Composer may summon only from an affirmatively identified root
 * thread. Unknown root identity is deliberately fail-closed: it might be a
 * direct sub-agent view while the manifest/live tree is still loading.
 */
export function canSummonSpecialistFromActiveThread(
  activeAgentId: string | null,
  rootAgentId: string | null,
): boolean {
  return rootAgentId !== null && activeAgentId === rootAgentId;
}

/** Build immutable queued-send options from the queued item's snapshot. */
export function queuedSendOptions(summonAgentId: string | null | undefined, steer: boolean, hasSnapshot: boolean): { handoff?: 'steer'; summonAgentId?: string | null } {
  return {
    ...(steer ? { handoff: 'steer' as const } : {}),
    ...(hasSnapshot ? { summonAgentId: summonAgentId ?? null } : {}),
  };
}
