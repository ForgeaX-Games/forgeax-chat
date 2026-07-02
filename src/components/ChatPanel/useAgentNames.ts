import { useEffect, useState } from 'react';

/**
 * Module-cached agent id → display name resolver.
 *
 * Source of truth is the same `/api/workbench/agents` catalog the capsule
 * (ChatAgentCapsule) and settings use, so names read consistently across
 * surfaces (e.g. "主线制作人" / "核心玩法师"). The catalog is fetched ONCE
 * per page load and shared across every consumer via a module-level cache —
 * a SubAgentCard-heavy transcript must not fan out N identical requests.
 */
let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;
const subscribers = new Set<() => void>();

function load(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch('/api/workbench/agents?lang=zh')
      .then((r) => r.json() as Promise<{ agents?: Array<{ id?: string; name?: string }> }>)
      .then((j) => {
        const map: Record<string, string> = {};
        for (const a of j.agents ?? []) {
          if (a.id) map[a.id] = a.name?.trim() || a.id;
        }
        cache = map;
        subscribers.forEach((fn) => fn());
        return map;
      })
      .catch(() => {
        cache = {};
        return cache;
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

export function useAgentNames(): (id: string | null | undefined) => string {
  const [, force] = useState(0);
  useEffect(() => {
    if (cache) return;
    const fn = () => force((n) => n + 1);
    subscribers.add(fn);
    void load();
    return () => {
      subscribers.delete(fn);
    };
  }, []);
  return (id) => {
    if (!id) return '';
    const short = shortAgentId(id);
    return (cache && (cache[id] ?? cache[short])) || short;
  };
}
