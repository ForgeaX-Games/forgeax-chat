import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useShellStore, type ChatTab } from '@forgeax/interface/store';
import {
  _chatInternals,
  useChatStore,
  type QueuedMessage,
  type SendMessageOpts,
} from './store';

const initialChatState = useChatStore.getState();
const initialShellState = useShellStore.getState();
const initialFetch = globalThis.fetch;
const initialWarn = console.warn;

function tab(sid: string, agentId: string, providerOverride = 'test-cli'): ChatTab {
  return { sid, agentId, providerOverride, displayName: 'test session' };
}

function setShellTarget(target: ChatTab): void {
  useShellStore.setState({
    tabs: [target],
    activeSid: target.sid,
    currentSessionId: target.sid,
    providerOverride: target.providerOverride,
    busyByAgentBySid: {},
  });
}

function queued(id: string, text: string): QueuedMessage {
  return { id, text, ts: 1 };
}

beforeEach(() => {
  _chatInternals.abortByTab.clear();
  useChatStore.setState({ ...initialChatState, bySid: {}, queuedMessages: {} }, true);
  useShellStore.setState({ ...initialShellState, tabs: [], activeSid: null, busyByAgentBySid: {} }, true);
  globalThis.fetch = initialFetch;
  console.warn = () => {};
});

afterEach(() => {
  for (const turn of _chatInternals.abortByTab.values()) turn.controller.abort();
  _chatInternals.abortByTab.clear();
  useChatStore.setState(initialChatState, true);
  useShellStore.setState(initialShellState, true);
  globalThis.fetch = initialFetch;
  console.warn = initialWarn;
});

describe('chat store turn targeting regressions', () => {
  it('pins a queued flush to sid/agent and dequeues only after acceptance', () => {
    const sid = 'sid-queue';
    const agentId = 'agent-a';
    const key = `${sid}::${agentId}`;
    const first = queued('q-1', 'first');
    const second = queued('q-2', 'second');
    let accepted: SendMessageOpts['onAccepted'];
    let received: { text: string; opts?: SendMessageOpts } | undefined;

    useChatStore.setState((state) => ({
      queuedMessages: { ...state.queuedMessages, [key]: [first, second] },
      sendMessage: async (text, opts) => {
        received = { text, opts };
        accepted = opts?.onAccepted;
      },
    }));

    useChatStore.getState().flushQueuedForAgent(sid, agentId);

    expect(received?.text).toBe('first');
    expect(received?.opts?.target).toEqual({ sid, agentId });
    expect(useChatStore.getState().queuedMessages[key]).toEqual([first, second]);

    accepted?.();
    expect(useChatStore.getState().queuedMessages[key]).toEqual([second]);
  });

  it('keeps an invalid/stale pinned target queued without fetching', async () => {
    const sid = 'sid-stale';
    const staleAgent = 'agent-old';
    const key = `${sid}::${staleAgent}`;
    const item = queued('q-stale', 'do not lose me');
    let fetchCount = 0;

    setShellTarget(tab(sid, 'agent-new'));
    useChatStore.setState({ queuedMessages: { [key]: [item] } });
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    useChatStore.getState().flushQueuedForAgent(sid, staleAgent);
    await Promise.resolve();

    expect(fetchCount).toBe(0);
    expect(useChatStore.getState().queuedMessages[key]).toEqual([item]);
    expect(useChatStore.getState().readMessages(sid, staleAgent)).toEqual([]);
  });

  it('preserves a replacement controller and cleans up the owning agent on cancel', async () => {
    const sid = 'sid-turns';
    type Pending = { signal: AbortSignal; reject: (reason?: unknown) => void };
    const pending: Pending[] = [];

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/cli/chat') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('chat request must carry an abort signal');
        pending.push({ signal, reject });
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }) as typeof fetch;

    setShellTarget(tab(sid, 'agent-a'));
    const firstTurn = useChatStore.getState().sendMessage('first turn');
    const firstController = _chatInternals.abortByTab.get(sid);
    expect(firstController?.agentId).toBe('agent-a');
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent['agent-a']).toBe(true);

    useShellStore.setState({ tabs: [tab(sid, 'agent-b')] });
    const secondTurn = useChatStore.getState().sendMessage('replacement turn');
    const replacement = _chatInternals.abortByTab.get(sid);

    expect(pending).toHaveLength(2);
    expect(firstController?.controller.signal.aborted).toBe(true);
    expect(replacement?.agentId).toBe('agent-b');
    expect(replacement).not.toBe(firstController);

    await firstTurn;
    expect(_chatInternals.abortByTab.get(sid)).toBe(replacement);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent['agent-a']).toBe(false);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent['agent-b']).toBe(true);
    expect(useShellStore.getState().busyByAgentBySid[sid]?.['agent-a']).toBeUndefined();
    expect(useShellStore.getState().busyByAgentBySid[sid]?.['agent-b']).toBe(true);

    useChatStore.getState().cancelStream();
    expect(replacement?.controller.signal.aborted).toBe(true);
    expect(_chatInternals.abortByTab.get(sid)).toBe(replacement);

    await secondTurn;
    expect(_chatInternals.abortByTab.has(sid)).toBe(false);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent['agent-a']).toBe(false);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent['agent-b']).toBe(false);
    expect(useShellStore.getState().busyByAgentBySid[sid]?.['agent-a']).toBeUndefined();
    expect(useShellStore.getState().busyByAgentBySid[sid]?.['agent-b']).toBeUndefined();
  });

  it('derives a live anchor only for the current unclosed WAL turn', async () => {
    const sid = 'sid-replay-live';
    const agentId = 'forge';
    setShellTarget(tab(sid, agentId));
    const events = [
      { type: 'user_input', source: 'user', ts: 1, payload: { content: 'go' } },
      { type: 'hook:turnStart', source: 'agent:forge', emitterId: agentId, ts: 2, payload: {} },
      {
        type: 'hook:assistantMessage',
        source: 'agent:forge',
        emitterId: agentId,
        ts: 3,
        payload: { llmMessage: { role: 'assistant', content: 'first' } },
      },
      { type: 'hook:turnEnd', source: 'agent:forge', emitterId: agentId, ts: 4, payload: {} },
      // Automatic continuation: no new human user bubble.
      { type: 'hook:turnStart', source: 'agent:forge', emitterId: agentId, ts: 5, payload: {} },
      {
        type: 'user_input',
        source: 'agent',
        emitterId: 'iori',
        to: agentId,
        ts: 5.5,
        payload: { content: 'inter-agent update' },
      },
      {
        type: 'hook:assistantMessage',
        source: 'agent:forge',
        emitterId: agentId,
        ts: 6,
        payload: { llmMessage: { role: 'assistant', content: 'second' } },
      },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: events.map((event) => JSON.stringify(event)).join('\n'),
    }), { status: 200 })) as typeof fetch;

    await useChatStore.getState().loadSession(sid, agentId);

    const assistants = useChatStore.getState().readMessages(sid, agentId)
      .filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.text).toBe('first');
    expect(assistants[0]?.msgId?.startsWith('live:')).not.toBe(true);
    expect(assistants[1]?.text).toBe('second');
    expect(assistants[1]?.msgId).toBe('live:forge:5');
  });
});
