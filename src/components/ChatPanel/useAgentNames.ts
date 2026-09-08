import { useEffect, useState } from 'react';
import { getLocale, subscribe, type Locale } from '@forgeax/interface/i18n';
import { agentCatalogUrl } from '@forgeax/agents/lib/agent-api-url';

/**
 * Module-cached agent id → display name resolver.
 *
 * Source of truth is the same `/api/agents` catalog the capsule
 * (ChatAgentCapsule) and settings use, so names read consistently across
 * surfaces (e.g. "主线制作人" / "核心玩法师"). The catalog is fetched ONCE
 * per page load and shared across every consumer via a module-level cache —
 * a SubAgentCard-heavy transcript must not fan out N identical requests.
 */
export interface AgentProfile {
  id: string;
  name: string;
  personName?: string;
  role?: string;
  title?: string;
  subtitle?: string;
  avatar?: string;
  color?: string;
}

let cache: Record<string, AgentProfile> | null = null;
let cacheLang: Locale | null = null;
let inflight: Promise<Record<string, AgentProfile>> | null = null;
const subscribers = new Set<() => void>();

function load(lang: Locale): Promise<Record<string, AgentProfile>> {
  if (cache && cacheLang === lang) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch(agentCatalogUrl())
      .then((r) => r.json() as Promise<{
        agents?: Array<{
          id?: string;
          name?: string;
          personName?: string;
          role?: string;
          naming?: { title?: string; sub?: string };
          avatar?: string;
          color?: string;
        }>;
      }>)
      .then((j) => {
        const map: Record<string, AgentProfile> = {};
        for (const a of j.agents ?? []) {
          if (a.id) {
            map[a.id] = {
              id: a.id,
              name: a.name?.trim() || a.id,
              personName: a.personName?.trim() || undefined,
              role: a.role?.trim() || undefined,
              title: a.naming?.title?.trim() || undefined,
              subtitle: a.naming?.sub?.trim() || undefined,
              avatar: a.avatar?.trim() || undefined,
              color: a.color?.trim() || undefined,
            };
          }
        }
        cache = map;
        cacheLang = lang;
        subscribers.forEach((fn) => fn());
        return map;
      })
      .catch(() => {
        cache = {};
        cacheLang = lang;
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Normalize an emitter ref to its short agent id. Emitter ids may arrive as a
 * path / instance ref (e.g. `main/iori#3`); the catalog is keyed by the bare
 * short id (`iori`), so strip any path prefix and `#instance` suffix.
 */
export function shortAgentId(ref: string): string {
  const tail = ref.split('/').pop() ?? ref;
  return tail.split('#')[0] ?? tail;
}

function useAgentCatalog(): (id: string | null | undefined) => AgentProfile | null {
  const lang = getLocale();
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subscribers.add(fn);
    const offLocale = subscribe(() => {
      cache = null;
      cacheLang = null;
      void load(getLocale());
      fn();
    });
    void load(lang);
    return () => {
      subscribers.delete(fn);
      offLocale();
    };
  }, [lang]);
  return (id) => {
    if (!id) return null;
    const short = shortAgentId(id);
    return (cache && (cache[id] ?? cache[short])) ?? {
      id: short,
      name: short,
    };
  };
}

export function useAgentNames(): (id: string | null | undefined) => string {
  const resolve = useAgentCatalog();
  return (id) => resolve(id)?.name ?? '';
}

export function useAgentProfiles(): (id: string | null | undefined) => AgentProfile | null {
  return useAgentCatalog();
}
