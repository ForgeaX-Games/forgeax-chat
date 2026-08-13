import { useCallback, useEffect, useState } from 'react';
import { useShellStore } from '@forgeax/interface/store';
import { workbenchAgentsUrl } from '@forgeax/interface/lib/workbench-lang';

/**
 * Sub-agent thread navigation for the task-flow surface.
 *
 * Clicking a running agent's avatar opens that agent's thread (FR2): chat is
 * already per-agent (`setTabAgent` → `readMessages(sid, agentId)`), so opening a
 * sub-agent = pointing the active tab at its id. The root/orchestrator agent is
 * the one with no parent (`depth === 1`); any other active agent is a read-only
 * sub-agent view where the composer is hidden — the user talks to a sub-agent
 * only through the main agent, never directly.
 */
export interface AgentThreadNav {
  /** True when the active tab is showing a sub-agent (not the root agent). */
  inSubAgentView: boolean;
  /** The root/orchestrator agent id for the active session, if known. */
  rootAgentId: string | null;
  /** The active tab's agent id. */
  activeAgentId: string | null;
  /** Open a given agent's thread in the active session. */
  openAgent: (agentId: string) => void;
  /** Return to the main (root) agent thread. */
  backToMain: () => void;
}

export function useAgentThreadNav(): AgentThreadNav {
  const activeSid = useShellStore((s) => s.activeSid);
  const activeAgentId = useShellStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  // Root = the manifest's main/orchestrator agent (isMain), same source the
  // capsule uses. liveAgents is unreliable here: it only holds agents that are
  // *currently running*, so after a delegation finishes it can be empty and the
  // root would be unknown. The workbench agents list is stable for the session.
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(workbenchAgentsUrl())
      .then((r) => r.json() as Promise<{ agents?: Array<{ id: string; isMain?: boolean }> }>)
      .then((j) => { if (alive) setMainAgentId(j.agents?.find((a) => a.isMain)?.id ?? null); })
      .catch(() => { /* keep null; view stays on the main thread */ });
    return () => { alive = false; };
  }, []);
  const liveRootAgentId = useShellStore((s) => {
    const agents = s.activeSid ? s.liveAgents[s.activeSid] ?? [] : [];
    if (!agents.length) return null;
    return (agents.find((a) => a.depth === 1 || a.parent === null) ?? agents[0]!).path;
  });
  const rootAgentId = mainAgentId ?? liveRootAgentId;
  const setTabAgent = useShellStore((s) => s.setTabAgent);

  const openAgent = useCallback((agentId: string) => {
    if (activeSid && agentId) setTabAgent(activeSid, agentId);
  }, [activeSid, setTabAgent]);

  const backToMain = useCallback(() => {
    if (activeSid) setTabAgent(activeSid, rootAgentId);
  }, [activeSid, rootAgentId, setTabAgent]);

  // A sub-agent view = an active agent that is known and not the root. When the
  // root is unknown (no live tree yet) we never treat the view as a sub-agent,
  // so the composer stays available on the normal main thread.
  const inSubAgentView = Boolean(
    activeAgentId && rootAgentId && activeAgentId !== rootAgentId,
  );

  return { inSubAgentView, rootAgentId, activeAgentId, openAgent, backToMain };
}
