import { useCallback, useEffect, useRef, useState } from 'react';
import { useShellStore } from '@forgeax/interface/store';
import { agentCatalogUrl } from '@forgeax/agents/lib/agent-api-url';
import { onSessionEvent, onTurnSnapshot } from '../../session-bridge';
import { openAgentWorkspace } from '../../lib/open-agent-workspace';
import { canonicalToolName } from '../../event-engine/tool-name';
import {
  askUserCallIdFromPayload,
  askUserToolNameFromPayload,
  focusAgentIdFromAskUser,
  parkedSubAgentId,
  rememberLastSubAgent,
  subscribeToParkedHandoff,
} from './handoff-focus';

/**
 * Sub-agent thread navigation for the task-flow surface.
 *
 * Clicking a running agent's avatar opens that agent's thread: chat is already
 * per-agent (`setTabAgent` → `readMessages(sid, agentId)`), so opening a
 * sub-agent = pointing the active tab at its id. The composer stays available
 * so the user can keep talking to that teammate (same as `@gen3d` in the
 * composer). Click the main agent's capsule to return.
 *
 * Dispatch keeps the visible tab on Forge. A teammate native `ask_user`
 * card is the one exception: that card only exists on the teammate thread,
 * so we pin the tab and open their page when the card appears.
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
  /** Last sub-agent to reopen after 返回主对话. Null on the main thread with no visit. */
  parkedSubAgentId: string | null;
  /** Jump back to that sub-agent's chat + plugin page. */
  returnToSub: () => void;
}

/**
 * Select an agent thread without mounting the parked-handoff subscription.
 * Task/plan rows only need this explicit click action; the full navigation
 * lifecycle stays owned by ChatPanel.
 */
export function useOpenAgentThread(): (agentId: string) => void {
  const activeSid = useShellStore((s) => s.activeSid);
  const setTabAgent = useShellStore((s) => s.setTabAgent);
  return useCallback((agentId: string) => {
    if (activeSid && agentId) setTabAgent(activeSid, agentId);
  }, [activeSid, setTabAgent]);
}

export function useAgentThreadNav(): AgentThreadNav {
  const activeSid = useShellStore((s) => s.activeSid);
  const activeAgentId = useShellStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  // Root = the manifest's main/orchestrator agent (isMain), same source the
  // capsule uses. liveAgents is unreliable here: it only holds agents that are
  // *currently running*, so after a delegation finishes it can be empty and the
  // root would be unknown. The Agent catalog is stable for the session.
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(agentCatalogUrl())
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
  const openAgent = useOpenAgentThread();
  const [lastSubBySid, setLastSubBySid] = useState<Record<string, string>>({});

  useEffect(() => {
    setLastSubBySid((prev) => rememberLastSubAgent(prev, activeSid, activeAgentId, rootAgentId));
  }, [activeSid, activeAgentId, rootAgentId]);

  // Park the teammate when Forge hands off, without switching the visible tab.
  // Own subscriber key — onSessionEvent overwrites the same key.
  useEffect(() => {
    return subscribeToParkedHandoff(onSessionEvent, activeSid, (agentId) => {
      setLastSubBySid((prev) => rememberLastSubAgent(prev, activeSid, agentId, rootAgentId));
    });
  }, [activeSid, rootAgentId]);

  const backToMain = useCallback(() => {
    if (activeSid) setTabAgent(activeSid, rootAgentId);
  }, [activeSid, rootAgentId, setTabAgent]);

  const returnToSub = useCallback(() => {
    const id = activeSid ? lastSubBySid[activeSid] : null;
    if (!activeSid || !id) return;
    setTabAgent(activeSid, id);
    void openAgentWorkspace(id, { switchChat: false, fallback: 'none' });
  }, [activeSid, lastSubBySid, setTabAgent]);

  // A sub-agent view = an active agent that is known and not the root.
  const inSubAgentView = Boolean(
    activeAgentId && rootAgentId && activeAgentId !== rootAgentId,
  );
  const parked = parkedSubAgentId(activeSid, activeAgentId, rootAgentId, lastSubBySid);

  return {
    inSubAgentView,
    rootAgentId,
    activeAgentId,
    openAgent,
    backToMain,
    parkedSubAgentId: parked,
    returnToSub,
  };
}

/** Mount once from ChatPanel. TaskCard/PlanCard also call useAgentThreadNav
 *  and would overwrite this subscriber if it lived in that hook. */
export function useAskUserThreadFocus(rootAgentId: string | null): void {
  const activeSid = useShellStore((s) => s.activeSid);
  const setTabAgent = useShellStore((s) => s.setTabAgent);
  const lastAskJumpRef = useRef<string | null>(null);

  const jumpToAskUser = useCallback((agentId: string, callId: string) => {
    if (!activeSid) return;
    const key = callId || agentId;
    if (lastAskJumpRef.current === key) return;
    lastAskJumpRef.current = key;
    setTabAgent(activeSid, agentId);
    void openAgentWorkspace(agentId, { switchChat: false, fallback: 'none' });
  }, [activeSid, setTabAgent]);

  useEffect(() => {
    if (!activeSid || !rootAgentId) return;
    return onSessionEvent('chat-agent-thread-ask-user', (msg) => {
      if (msg.sid !== activeSid) return;
      const ev = msg.event;
      const target = focusAgentIdFromAskUser({
        emitterId: msg.emitterId ?? '',
        rootAgentId,
        eventType: ev.type,
        toolName: askUserToolNameFromPayload(ev.payload),
        permissionPrompt: ev.payload.permissionPrompt,
      });
      if (!target) return;
      jumpToAskUser(target, askUserCallIdFromPayload(ev.payload));
    });
  }, [activeSid, rootAgentId, jumpToAskUser]);

  useEffect(() => {
    if (!activeSid || !rootAgentId) return;
    return onTurnSnapshot('chat-agent-thread-ask-user-snap', (frame) => {
      if (frame.sid !== activeSid) return;
      const pending = frame.payload.toolCalls.find((tc) =>
        canonicalToolName(tc.name) === 'ask_user'
        && tc.status === 'running'
        && tc.permissionPrompt !== true,
      );
      if (!pending) return;
      const target = focusAgentIdFromAskUser({
        emitterId: frame.emitterId,
        rootAgentId,
        eventType: 'hook:toolCall',
        toolName: pending.name,
        permissionPrompt: pending.permissionPrompt,
      });
      if (!target) return;
      jumpToAskUser(target, pending.callId);
    });
  }, [activeSid, rootAgentId, jumpToAskUser]);
}
