import { accentForRoleTribe } from '@forgeax/interface/components/AgentAvatar/AgentAvatar';
import { t } from '@forgeax/interface/i18n';
import { shortAgentId, useAgentProfiles, type AgentProfile } from './useAgentNames';

/**
 * Task-flow agent identity: the four fields every task-flow surface renders
 * (plan rows, task headers, process avatar stack).
 *
 * `accent` comes from the shared role-tribe palette so a given agent reads the
 * same colour here, in the capsule, and in the agent switcher.
 */
export interface AgentIdentity {
  id: string;
  /** Natural display name, e.g. `Forge`. Task headers uppercase it in CSS. */
  name: string;
  /** Two-character avatar text. */
  initials: string;
  /** Explicit avatar token/path. Video avatar rules still take precedence. */
  avatar?: string;
  /** Function label shown on the right of a plan row, e.g. `Core gameplay`. */
  roleLabel?: string;
  /** CSS colour expression from the shared role palette. */
  accent: string;
}

export const MAIN_AGENT_ACCENT = '#A8E6B8';

/** Marketplace roles may carry a trailing status (`coding · placeholder`). */
function roleTribe(role: string | undefined): string {
  return (role?.split('·')[0] ?? '').trim().toLowerCase();
}

/** The role palette's tribes, which also have localized labels under `taskFlow.role.*`. */
const KNOWN_TRIBES = new Set(['orchestrator', 'pillar', 'design', 'narrative', 'art', 'coding']);

/**
 * Localized function label for a known role tribe (`orchestrator → 编排`). A raw
 * tribe id is an internal enum, not display text, so it must never surface as-is.
 * Returns undefined for unknown roles, letting the caller fall back.
 */
function localizeTribe(role: string | undefined): string | undefined {
  const tribe = roleTribe(role);
  return KNOWN_TRIBES.has(tribe) ? t(`taskFlow.role.${tribe}`) : undefined;
}

function initialsOf(source: string): string {
  const parts = source.split(/[-_\s]/).filter(Boolean);
  if (parts.length >= 2 && parts[0] && parts[1]) return (parts[0][0]! + parts[1][0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function identityOf(profile: AgentProfile): AgentIdentity {
  const main = shortAgentId(profile.id) === 'forge';
  const name = main ? 'ForgeaX' : profile.personName ?? profile.title ?? profile.name;
  // Prefer a human subtitle/title from the profile; otherwise localize the raw
  // role tribe rather than leaking the internal enum id.
  const explicit = [profile.subtitle, profile.title]
    .find((value) => value && value !== name && value !== profile.name);
  const roleLabel = explicit ?? localizeTribe(profile.role)
    ?? (profile.role && profile.role !== name && profile.role !== profile.name ? profile.role : undefined);
  return {
    id: profile.id,
    name,
    initials: initialsOf(name),
    ...(profile.avatar?.trim() ? { avatar: profile.avatar.trim() } : {}),
    roleLabel,
    accent: main ? MAIN_AGENT_ACCENT : profile.color?.trim() || accentForRoleTribe(roleTribe(profile.role)),
  };
}

/** Resolve an agent id to its task-flow identity, or null when unknown. */
export function useAgentIdentities(): (id: string | null | undefined) => AgentIdentity | null {
  const resolve = useAgentProfiles();
  return (id) => {
    const profile = resolve(id);
    return profile ? identityOf(profile) : null;
  };
}
