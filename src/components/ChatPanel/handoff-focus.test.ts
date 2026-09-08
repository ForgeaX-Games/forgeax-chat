import { describe, expect, test } from 'bun:test';
import type { SessionEvent } from '../../session-bridge';
import {
  agentIdFromRef,
  askUserCallIdFromPayload,
  askUserToolNameFromPayload,
  focusAgentIdFromAskUser,
  focusAgentIdFromHandoff,
  parkedAgentIdFromInterAgentHandoff,
  subscribeToParkedHandoff,
  parkedSubAgentId,
  rememberLastSubAgent,
} from './handoff-focus';

describe('handoff focus', () => {
  test('strips path and instance suffix', () => {
    expect(agentIdFromRef('gen3d')).toBe('gen3d');
    expect(agentIdFromRef('forge/gen3d')).toBe('gen3d');
    expect(agentIdFromRef('gen3d#1')).toBe('gen3d');
  });

  test('identifies the teammate after a real handoff', () => {
    expect(focusAgentIdFromHandoff('forge', 'gen3d')).toBe('gen3d');
    expect(focusAgentIdFromHandoff('forge', 'forge/sino')).toBe('sino');
  });

  test('ignores self-handoff and empty refs', () => {
    expect(focusAgentIdFromHandoff('gen3d', 'gen3d')).toBeNull();
    expect(focusAgentIdFromHandoff('forge/gen3d', 'gen3d#1')).toBeNull();
    expect(focusAgentIdFromHandoff('', 'gen3d')).toBeNull();
    expect(focusAgentIdFromHandoff('forge', '')).toBeNull();
  });
});

describe('inter-agent dispatch navigation', () => {
  const forgeToGen3d = {
    emitterId: 'forge',
    event: {
      source: 'agent',
      type: 'user_input',
      payload: {},
      to: 'forge/gen3d',
      ts: 1,
    },
  };

  test('parks the dispatched teammate instead of selecting its thread', () => {
    // The event resolves only to a parked target. There is deliberately no
    // "activate" result: the visible Forge tab changes only through the
    // explicit return/open controls.
    expect(parkedAgentIdFromInterAgentHandoff(forgeToGen3d)).toBe('gen3d');
  });

  test('does not treat user traffic or narrative nudges as a dispatch', () => {
    expect(parkedAgentIdFromInterAgentHandoff({
      ...forgeToGen3d,
      event: { ...forgeToGen3d.event, source: 'user' },
    })).toBeNull();
    expect(parkedAgentIdFromInterAgentHandoff({
      ...forgeToGen3d,
      event: { ...forgeToGen3d.event, payload: { narrativeAutoNudge: true } },
    })).toBeNull();
  });

  test('registers the real session key and parks only the dispatched teammate', () => {
    const parked: string[] = [];
    let key = '';
    let handler: ((message: SessionEvent) => void) | undefined;
    const unsubscribe = subscribeToParkedHandoff(
      (registeredKey, registeredHandler) => {
        key = registeredKey;
        handler = registeredHandler;
        return () => { parked.push('unsubscribed'); };
      },
      's1',
      (agentId) => parked.push(agentId),
    );

    expect(key).toBe('chat-agent-thread-park');
    handler?.({ type: 'session-event', sid: 's1', ...forgeToGen3d });
    handler?.({ type: 'session-event', sid: 'other-session', ...forgeToGen3d });
    expect(parked).toEqual(['gen3d']);
    unsubscribe();
    expect(parked).toEqual(['gen3d', 'unsubscribed']);
  });
});

describe('parked sub-agent return', () => {
  test('parks gen3d from a handoff even if the visible tab stays on forge', () => {
    const afterHandoff = rememberLastSubAgent({}, 's1', 'gen3d', 'forge');
    expect(afterHandoff).toEqual({ s1: 'gen3d' });
    expect(rememberLastSubAgent(afterHandoff, 's1', 'forge', 'forge')).toEqual(afterHandoff);
    expect(parkedSubAgentId('s1', 'forge', 'forge', afterHandoff)).toBe('gen3d');
  });

  test('hides the return shortcut while already on the sub-agent', () => {
    const parked = { s1: 'gen3d' };
    expect(parkedSubAgentId('s1', 'gen3d', 'forge', parked)).toBeNull();
  });

  test('updates when the user visits a different sub-agent', () => {
    const afterSino = rememberLastSubAgent({ s1: 'gen3d' }, 's1', 'sino', 'forge');
    expect(afterSino).toEqual({ s1: 'sino' });
  });
});

describe('ask_user focus', () => {
  test('reads nested hook:toolCall name and id', () => {
    expect(askUserToolNameFromPayload({ toolCall: { id: 'ask-1', name: 'ask_user' } })).toBe('ask_user');
    expect(askUserCallIdFromPayload({ toolCall: { id: 'ask-1', name: 'ask_user' } })).toBe('ask-1');
    expect(askUserCallIdFromPayload({ toolUseId: 'cli-1' })).toBe('cli-1');
  });

  test('pulls focus for a teammate native ask_user', () => {
    expect(focusAgentIdFromAskUser({
      emitterId: 'forge/gen3d',
      rootAgentId: 'forge',
      eventType: 'hook:toolCall',
      toolName: 'ask_user',
    })).toBe('gen3d');
    expect(focusAgentIdFromAskUser({
      emitterId: 'gen3d#1',
      rootAgentId: 'forge',
      eventType: 'stream:tool_use',
      toolName: 'AskUserQuestion',
    })).toBe('gen3d');
  });

  test('stays put on dispatch, root asks, and CLI permission overlays', () => {
    expect(focusAgentIdFromAskUser({
      emitterId: 'forge',
      rootAgentId: 'forge',
      eventType: 'user_input',
      toolName: 'ask_user',
    })).toBeNull();
    expect(focusAgentIdFromAskUser({
      emitterId: 'forge',
      rootAgentId: 'forge',
      eventType: 'hook:toolCall',
      toolName: 'ask_user',
    })).toBeNull();
    expect(focusAgentIdFromAskUser({
      emitterId: 'gen3d',
      rootAgentId: 'forge',
      eventType: 'hook:toolCall',
      toolName: 'ask_user',
      permissionPrompt: true,
    })).toBeNull();
    expect(focusAgentIdFromAskUser({
      emitterId: 'gen3d',
      rootAgentId: 'forge',
      eventType: 'hook:toolCall',
      toolName: 'todo_write',
    })).toBeNull();
  });
});
