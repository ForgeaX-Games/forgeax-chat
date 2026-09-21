import { registerChatSendPreparation } from '../send-preparation';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useShellStore, type ChatTab } from '@forgeax/interface/store';
import {
  _chatInternals,
  clearAgentStreamSuppression,
  isAgentStreamSuppressed,
  isOwnUserInput,
  useChatStore,
  appendChatSegment,
  type QueuedMessage,
  type SendMessageOpts,
} from './store';
import { applyTurnSnapshot, dispatchSessionEvent, markMessageStreaming } from './session-stream';

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
  for (const sid of Object.keys(useChatStore.getState().bySid)) {
    for (const agentId of Object.keys(
      useChatStore.getState().bySid[sid]?.streamingByAgent ?? {},
    )) {
      clearAgentStreamSuppression(sid, agentId);
    }
  }
  useChatStore.setState(initialChatState, true);
  useShellStore.setState(initialShellState, true);
  globalThis.fetch = initialFetch;
  console.warn = initialWarn;
});

describe('chat store turn targeting regressions', () => {
  it('clears a stale shared busy flag when opening a completed child for the first time', async () => {
    const sid = 'cold-completed-child';
    const agentId = 'audio-designer';
    setShellTarget(tab(sid, agentId));
    useShellStore.getState().setAgentBusy(sid, agentId, true);
    const events = [
      { type: 'hook:turnStart', ts: 10, payload: { turnId: 'child' } },
      { type: 'hook:turnEnd', ts: 20, payload: { turnId: 'child', aborted: false } },
    ];
    globalThis.fetch = (async () => Response.json({ data: events.map(e => JSON.stringify(e)).join('\n') })) as typeof fetch;
    await useChatStore.getState().loadSession(sid, agentId);
    expect(useShellStore.getState().busyByAgentBySid[sid]?.[agentId]).toBeFalsy();
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent[agentId]).toBeFalsy();
  });

  it('recovers completed child busy flags and rejects its late snapshot without stopping the parent', async () => {
    const sid = 'completed-child-recovery';
    const agentId = 'audio-designer';
    setShellTarget(tab(sid, agentId));
    const dispatch = (type: string, ts: number, payload: Record<string, unknown>) =>
      dispatchSessionEvent({ type: 'session-event', sid, emitterId: agentId,
        event: { type, ts, source: `agent:${agentId}`, payload } });
    dispatch('hook:turnStart', 110, { turnId: 'child-turn' });
    useChatStore.getState().setStreaming(sid, 'forge', true);
    const events = [
      { type: 'hook:turnStart', ts: 110, payload: { turnId: 'child-turn' } },
      { type: 'hook:assistantMessage', ts: 200, payload: { llmMessage: { role: 'assistant', content: 'Delivered' } } },
      { type: 'hook:turnEnd', ts: 220, payload: { turnId: 'child-turn', aborted: false } },
    ];
    globalThis.fetch = (async () => Response.json({ data: events.map(e => JSON.stringify(e)).join('\n') })) as typeof fetch;
    await useChatStore.getState().loadSession(sid, agentId);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent[agentId]).toBe(false);
    expect(useShellStore.getState().busyByAgentBySid[sid]?.[agentId]).toBeFalsy();
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent.forge).toBe(true);
    expect(useChatStore.getState().readMessages(sid, agentId).filter(m => m.role === 'assistant')).toHaveLength(1);
    applyTurnSnapshot({ type: 'turn-snapshot', sid, emitterId: agentId, payload: {
      turn: 1, startedAt: 110, seq: 1, sgen: 'child-recovery', text: 'old partial', thinking: '',
      sealedTextLen: 0, sealedThinkingLen: 0, toolCalls: [],
    } });
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent[agentId]).toBe(false);
    expect(useChatStore.getState().readMessages(sid, agentId).some(m => m.text === 'old partial')).toBe(false);
    dispatch('hook:turnStart', 300, { turnId: 'next-child-turn' });
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent[agentId]).toBe(true);
  });

  it('does not clear a new child turn that arrives during history recovery', async () => {
    const sid = 'child-recovery-race';
    const agentId = 'audio-designer';
    setShellTarget(tab(sid, agentId));
    const events = [
      { type: 'hook:turnStart', ts: 110, payload: { turnId: 'old' } },
      { type: 'hook:turnEnd', ts: 220, payload: { turnId: 'old' } },
    ];
    globalThis.fetch = (async () => {
      dispatchSessionEvent({ type: 'session-event', sid, emitterId: agentId,
        event: { type: 'hook:turnStart', ts: 300, payload: { turnId: 'new' } } });
      return Response.json({ data: events.map(e => JSON.stringify(e)).join('\n') });
    }) as typeof fetch;
    await useChatStore.getState().loadSession(sid, agentId);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent[agentId]).toBe(true);
    expect(useShellStore.getState().busyByAgentBySid[sid]?.[agentId]).toBe(true);
  });
  it('does not notify subscribers for repeated streaming state writes', () => {
    const sid = 'sid-stream-idempotent';
    const agentId = 'forge';
    let notifications = 0;
    const unsubscribe = useChatStore.subscribe(() => { notifications += 1; });

    useChatStore.getState().setStreaming(sid, agentId, false);
    useChatStore.getState().setStreaming(sid, agentId, true);
    useChatStore.getState().setStreaming(sid, agentId, true);
    useChatStore.getState().setStreaming(sid, agentId, false);
    useChatStore.getState().setStreaming(sid, agentId, false);
    unsubscribe();

    expect(notifications).toBe(2);
  });

  it('keeps an already-streaming assistant referentially stable per token', () => {
    const message = {
      id: 'assistant-live',
      msgId: 'live:turn-1',
      role: 'assistant' as const,
      text: 'partial',
      toolCalls: [],
      status: 'streaming' as const,
      ts: 1,
    };

    expect(markMessageStreaming(message)).toBe(message);
    expect(markMessageStreaming(message, 'live:turn-1')).toBe(message);
    const adopted = markMessageStreaming(message, 'live:turn-2');
    expect(adopted).not.toBe(message);
    expect(adopted.msgId).toBe('live:turn-2');
  });

  it('renders queued user input immediately and keeps it while accepting the turn', () => {
    const sid = 'sid-queue-timeline';
    const agentId = 'forge';
    const key = `${sid}::${agentId}`;
    let accepted: SendMessageOpts['onAccepted'];
    let received: SendMessageOpts | undefined;
    setShellTarget(tab(sid, agentId));

    useChatStore.getState().enqueueMessage('queued while replying');
    const queuedItem = useChatStore.getState().queuedMessages[key]![0]!;
    const optimistic = useChatStore.getState().readMessages(sid, agentId);
    expect(optimistic.map((message) => [message.role, message.text])).toEqual([
      ['user', 'queued while replying'],
    ]);
    expect(optimistic[0]?.id).toBe(queuedItem.optimisticMessageId);

    useChatStore.setState({
      sendMessage: async (_text, opts) => {
        received = opts;
        accepted = opts?.onAccepted;
      },
    });
    useChatStore.getState().flushQueuedForAgent(sid, agentId);

    expect(received?.existingUserMessageId).toBe(queuedItem.optimisticMessageId);
    accepted?.();
    expect(useChatStore.getState().queuedMessages[key]).toEqual([]);
    expect(useChatStore.getState().readMessages(sid, agentId)[0]?.id).toBe(queuedItem.optimisticMessageId);
  });

  it('reuses the optimistic queue bubble instead of appending the user twice', async () => {
    const sid = 'sid-queue-reuse';
    const agentId = 'forge';
    const key = `${sid}::${agentId}`;
    setShellTarget(tab(sid, agentId, 'codex'));
    globalThis.fetch = (async (input) => {
      if (String(input) === '/api/cli/chat') {
        return new Response('event: done\ndata: {"type":"done","stopReason":"end_turn"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    useChatStore.getState().enqueueMessage('queued once');
    const item = useChatStore.getState().queuedMessages[key]![0]!;
    await useChatStore.getState().sendMessage(item.text, {
      target: { sid, agentId },
      existingUserMessageId: item.optimisticMessageId,
    });

    const messages = useChatStore.getState().readMessages(sid, agentId);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages[0]?.id).toBe(item.optimisticMessageId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('removes optimistic queued bubbles when deleting or clearing the queue', () => {
    const sid = 'sid-queue-remove';
    const agentId = 'forge';
    const key = `${sid}::${agentId}`;
    setShellTarget(tab(sid, agentId));

    useChatStore.getState().enqueueMessage('first');
    useChatStore.getState().enqueueMessage('second');
    const [first] = useChatStore.getState().queuedMessages[key]!;
    useChatStore.getState().dequeueMessage(first!.id);
    expect(useChatStore.getState().readMessages(sid, agentId).map((message) => message.text)).toEqual(['second']);

    useChatStore.getState().clearQueue();
    expect(useChatStore.getState().queuedMessages[key]).toBeUndefined();
    expect(useChatStore.getState().readMessages(sid, agentId)).toEqual([]);
  });

  it('tags CLI requests so the initiating tab can drop its user_input echo', async () => {
    const sid = 'sid-cli-user-input-dedupe';
    let clientMsgId: string | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === '/api/cli/chat') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { clientMsgId?: string };
        clientMsgId = body.clientMsgId;
        return new Response('event: done\ndata: {"type":"done","stopReason":"end_turn"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    setShellTarget(tab(sid, 'forge', 'codex'));
    await useChatStore.getState().sendMessage('one visible message');

    expect(clientMsgId).toMatch(/^c-\d+-[a-z0-9]+$/);
    expect(isOwnUserInput(clientMsgId)).toBe(true);
  });

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

  it('keeps the submitted model when a queued message flushes later', () => {
    const sid = 'sid-model-queue';
    const agentId = 'forge';
    let received: SendMessageOpts | undefined;
    setShellTarget(tab(sid, agentId));
    useChatStore.getState().enqueueMessage('continue the game', { model: 'gpt-5.6-luna' });
    useChatStore.setState({ sendMessage: async (_text, opts) => { received = opts; } });
    useChatStore.getState().flushQueuedForAgent(sid, agentId);
    expect(received?.model).toBe('gpt-5.6-luna');
    expect(received?.target).toEqual({ sid, agentId });
  });

  it('keeps the specialist snapshot when a queued message flushes later', () => {
    const sid = 'sid-summon-queue';
    const agentId = 'forge';
    const key = `${sid}::${agentId}`;
    let received: SendMessageOpts | undefined;
    setShellTarget(tab(sid, agentId));
    useChatStore.getState().enqueueMessage('review this', { summonAgentId: 'iori' });
    const item = useChatStore.getState().queuedMessages[key]![0]!;
    // The user can alter the visible Composer before this old queue item flushes.
    // Queue metadata, not the current selection, remains the source of truth.
    const currentChipWouldNowBe = 'suzu';
    expect(currentChipWouldNowBe).toBe('suzu');
    useChatStore.setState((state) => ({
      sendMessage: async (_text, opts) => { received = opts; },
    }));

    useChatStore.getState().flushQueuedForAgent(sid, agentId);

    expect(received?.summonAgentId).toBe('iori');
    expect(received?.target).toEqual({ sid, agentId });
  });

  it('preserves an explicit no-specialist snapshot for a later queued message', () => {
    const sid = 'sid-clear-summon-queue';
    const agentId = 'forge';
    const key = `${sid}::${agentId}`;
    let received: SendMessageOpts | undefined;
    setShellTarget(tab(sid, agentId));
    useChatStore.getState().enqueueMessage('first', { summonAgentId: 'iori' });
    useChatStore.getState().enqueueMessage('after clear', { summonAgentId: null });
    useChatStore.setState({
      queuedMessages: { [key]: [useChatStore.getState().queuedMessages[key]![1]!] },
      sendMessage: async (_text, opts) => { received = opts; },
    });

    useChatStore.getState().flushQueuedForAgent(sid, agentId);

    expect(received).toHaveProperty('summonAgentId', null);
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
      if (String(input) === '/api/commands/get_agent_model/query') {
        return Promise.resolve(new Response(JSON.stringify({
          result: { ok: true, data: { sid, agentPath: 'agent-a', selected: 'test-model', chain: ['test-model'], raw: ['test-model'] } },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
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

    await new Promise((resolve) => setTimeout(resolve, 10));
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

  it('clears delegated sub-agent streaming on Stop without changing abort scope', () => {
    const sid = 'sid-delegated';
    const subagent = 'iori';
    const abortRequests: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/abort')) abortRequests.push(url);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    setShellTarget(tab(sid, subagent));
    useChatStore.getState().setStreaming(sid, subagent, true);
    useChatStore.getState().patchMessages(sid, subagent, () => [
      {
        id: 'asst-live',
        role: 'assistant',
        text: '',
        toolCalls: [{ callId: 'c1', name: 'read', args: {}, status: 'running' }],
        status: 'streaming',
        ts: Date.now() - 6000,
      },
    ]);
    useShellStore.getState().setLiveAgents(sid, [
      {
        path: subagent,
        display: 'Iori',
        parent: 'forge',
        running: true,
        depth: 2,
      },
    ]);

    useChatStore.getState().cancelStream();

    expect(abortRequests).toEqual([
      `/api/sessions/${encodeURIComponent(sid)}/abort?agent=${encodeURIComponent(subagent)}`,
    ]);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent[subagent]).toBe(false);
    expect(useShellStore.getState().busyByAgentBySid[sid]?.[subagent]).toBeUndefined();
    const sealed = useChatStore.getState().readMessages(sid, subagent)[0];
    expect(sealed?.status).toBe('done');
    expect(sealed?.toolCalls[0]?.status).toBe('done');
    expect(useShellStore.getState().liveAgents[sid]?.[0]?.running).toBe(false);
    expect(isAgentStreamSuppressed(sid, subagent)).toBe(true);
    useChatStore.getState().setStreaming(sid, subagent, true);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent[subagent]).toBe(false);
  });

  it('keeps other busy agents running when stopping the active sub-agent', () => {
    const sid = 'sid-scope';
    const abortRequests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/abort')) abortRequests.push(url);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    setShellTarget(tab(sid, 'iori'));
    useChatStore.getState().setStreaming(sid, 'forge', true);
    useChatStore.getState().setStreaming(sid, 'iori', true);

    useChatStore.getState().cancelStream();

    expect(abortRequests).toEqual([
      `/api/sessions/${encodeURIComponent(sid)}/abort?agent=iori`,
    ]);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent['iori']).toBe(false);
    expect(useChatStore.getState().bySid[sid]?.streamingByAgent['forge']).toBe(true);
    expect(useShellStore.getState().busyByAgentBySid[sid]?.['iori']).toBeUndefined();
    expect(useShellStore.getState().busyByAgentBySid[sid]?.['forge']).toBe(true);
    expect(isAgentStreamSuppressed(sid, 'iori')).toBe(true);
    expect(isAgentStreamSuppressed(sid, 'forge')).toBe(false);
  });

  it('retains turn anchors for terminal snapshot rejection while only the open turn streams', async () => {
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
    expect(assistants[0]?.msgId).toBe(`live:${agentId}:2`);
    expect(assistants[0]?.status).toBe('done');
    expect(assistants[1]?.text).toBe('second');
    expect(assistants[1]?.msgId).toBe('live:forge:5');
  });

  it('keeps the last valid context percentage when replay sees empty usage', async () => {
    const sid = 'sid-replay-context';
    const agentId = 'forge';
    setShellTarget(tab(sid, agentId));
    const events = [
      { type: 'hook:turnStart', source: 'agent:forge', emitterId: agentId, ts: 1, payload: {} },
      {
        type: 'hook:assistantMessage', source: 'agent:forge', emitterId: agentId, ts: 2,
        payload: {
          model: 'gpt-5.6-sol',
          usage: { inputTokens: 735_000, outputTokens: 0 },
          llmMessage: { role: 'assistant', content: 'first' },
        },
      },
      {
        type: 'hook:assistantMessage', source: 'agent:forge', emitterId: agentId, ts: 3,
        payload: {
          model: 'gpt-5.6-sol',
          usage: { inputTokens: 0, outputTokens: 0 },
          llmMessage: { role: 'assistant', content: 'second' },
        },
      },
      { type: 'hook:turnEnd', source: 'agent:forge', emitterId: agentId, ts: 4, payload: {} },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: events.map((event) => JSON.stringify(event)).join('\n'),
    }), { status: 200 })) as typeof fetch;

    await useChatStore.getState().loadSession(sid, agentId);

    expect(useChatStore.getState().bySid[sid]?.contextByAgent[agentId]?.pct).toBe(70);
  });

  it('replays final turn duration without sealing an Ask waiting checkpoint', async () => {
    const sid = 'sid-replay-duration';
    const agentId = 'forge';
    setShellTarget(tab(sid, agentId));
    const events = [
      { type: 'user_input', source: 'user', ts: 100, payload: { content: 'ask first' } },
      { type: 'hook:turnStart', source: 'agent:forge', emitterId: agentId, ts: 110, payload: { turnId: 'turn-1' } },
      {
        type: 'hook:toolCall', source: 'agent:forge', emitterId: agentId, ts: 120,
        payload: { name: 'ask_user', callId: 'ask-1', args: { questions: [{ question: 'Pick one' }] } },
      },
      { type: 'hook:turnEnd', source: 'agent:forge', emitterId: agentId, ts: 130, payload: { turnId: 'turn-1', waitingForInput: true } },
      {
        type: 'hook:toolResult', source: 'agent:forge', emitterId: agentId, ts: 200,
        payload: { name: 'ask_user', callId: 'ask-1', result: { ok: true, questions: [{ questionId: 'question-1', values: ['A'] }] } },
      },
      {
        type: 'hook:assistantMessage', source: 'agent:forge', emitterId: agentId, ts: 210,
        payload: { llmMessage: { role: 'assistant', content: 'done' } },
      },
      { type: 'hook:turnEnd', source: 'agent:forge', emitterId: agentId, ts: 220, payload: { turnId: 'turn-1', durationMs: 3210 } },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: events.map((event) => JSON.stringify(event)).join('\n'),
    }), { status: 200 })) as typeof fetch;

    await useChatStore.getState().loadSession(sid, agentId);

    const assistant = useChatStore.getState().readMessages(sid, agentId)
      .find((message) => message.role === 'assistant');
    expect(assistant?.status).toBe('done');
    expect(assistant?.durationMs).toBe(3210);
    expect(assistant?.turnId).toBe('turn-1');
  });

  it('does not resurrect an unanswered Ask after an authoritative turn end', async () => {
    const sid = 'sid-replay-ask-no-flag';
    const agentId = 'forge';
    setShellTarget(tab(sid, agentId));
    const events = [
      { type: 'user_input', source: 'user', ts: 100, payload: { content: 'ask first' } },
      { type: 'hook:turnStart', source: 'agent:forge', emitterId: agentId, ts: 110, payload: { turnId: 'turn-ask' } },
      {
        type: 'hook:toolCall', source: 'agent:forge', emitterId: agentId, ts: 120,
        payload: { name: 'AskUserQuestion', callId: 'ask-no-flag', args: { question: 'Pick one', options: ['A'] } },
      },
      // A terminal event without an explicit wait must close the question,
      // including when replaying the event ledger after reload.
      { type: 'hook:turnEnd', source: 'agent:forge', emitterId: agentId, ts: 130, payload: { turnId: 'turn-ask' } },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: events.map((event) => JSON.stringify(event)).join('\n'),
    }), { status: 200 })) as typeof fetch;

    await useChatStore.getState().loadSession(sid, agentId);

    const assistant = useChatStore.getState().readMessages(sid, agentId)
      .find((message) => message.role === 'assistant');
    expect(assistant?.status).toBe('done');
    expect(assistant?.toolCalls).toMatchObject([{
      callId: 'ask-no-flag',
      name: 'ask_user',
      status: 'done',
    }]);
  });

  it('recovers legacy CLI permission provenance without resurrecting a native Ask card', async () => {
    const sid = 'sid-cli-ask-replay';
    const agentId = 'forge';
    setShellTarget(tab(sid, agentId, 'claude-code'));
    const events = [
      {
        type: 'permission:request', source: 'agent:forge', emitterId: agentId, ts: 10,
        payload: {
          reqId: 'permission-1', toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'Pick one', header: 'Focus', multiSelect: false, options: [{ label: 'Design' }] }] },
        },
      },
      {
        type: 'permission:resolved', source: 'agent:forge', emitterId: agentId, ts: 11,
        payload: {
          reqId: 'permission-1', toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'Pick one', header: 'Focus', multiSelect: false, options: [{ label: 'Design' }] }] },
          answers: { 'Pick one': 'Design' }, answerValues: { 'Pick one': ['Design'] },
        },
      },
      { type: 'user_input', source: 'user', ts: 20, payload: { content: 'ask' } },
      { type: 'hook:turnStart', source: 'agent:forge', emitterId: agentId, ts: 21, payload: { turnId: 'turn-cli-ask' } },
      {
        type: 'hook:toolCall', source: 'agent:forge', emitterId: agentId, ts: 22,
        payload: {
          name: 'ask_user', callId: 'cli-ask-1',
          args: { questions: [{ question: 'Pick one', header: 'Focus', multiSelect: false, options: [{ label: 'Design' }] }] },
        },
      },
      {
        type: 'hook:toolResult', source: 'agent:forge', emitterId: agentId, ts: 23,
        payload: { name: 'ask_user', callId: 'cli-ask-1', result: 'Your questions have been answered.' },
      },
      { type: 'hook:assistantMessage', source: 'agent:forge', emitterId: agentId, ts: 24, payload: { llmMessage: { role: 'assistant', content: 'done' } } },
      { type: 'hook:turnEnd', source: 'agent:forge', emitterId: agentId, ts: 25, payload: { turnId: 'turn-cli-ask' } },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: events.map((event) => JSON.stringify(event)).join('\n'),
    }), { status: 200 })) as typeof fetch;

    await useChatStore.getState().loadSession(sid, agentId);

    const assistant = useChatStore.getState().readMessages(sid, agentId)
      .find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls).toMatchObject([{
      callId: 'cli-ask-1', permissionPrompt: true, status: 'done',
    }]);
  });

  it('merges CLI tool-call deltas into the final call instead of duplicating it', async () => {
    const sid = 'sid-cli-tool-dedupe';
    setShellTarget(tab(sid, 'forge', 'claude-code'));
    const sse = [
      'event: tool-call-delta',
      'data: {"type":"tool-call-delta","callId":"ask-delta-1","name":"AskUserQuestion","argumentsDelta":"{\\"questions\\":[{\\"question\\":\\"Pick one\\"}]}"}',
      '',
      'event: tool-call',
      'data: {"type":"tool-call","callId":"ask-delta-1","name":"AskUserQuestion","args":{"questions":[{"question":"Pick one"}]}}',
      '',
      'event: tool-result',
      'data: {"type":"tool-result","callId":"ask-delta-1","name":"AskUserQuestion","ok":true,"result":"answered"}',
      '',
      'event: done',
      'data: {"type":"done","stopReason":"end_turn"}',
      '',
    ].join('\n');
    globalThis.fetch = (async (input) => {
      if (String(input) === '/api/cli/chat') {
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await useChatStore.getState().sendMessage('ask one question');

    const assistant = useChatStore.getState().readMessages(sid, 'forge')
      .find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls).toHaveLength(1);
    expect(assistant?.toolCalls[0]).toMatchObject({
      callId: 'ask-delta-1', name: 'ask_user', permissionPrompt: true, status: 'done',
      args: { questions: [{ question: 'Pick one' }] },
    });
  });

  it('keeps native kernel ask_user on the interactive card path', async () => {
    const sid = 'sid-native-ask-card';
    setShellTarget(tab(sid, 'forge', 'codex'));
    const sse = [
      'event: tool-call',
      'data: {"type":"tool-call","callId":"native-ask-1","name":"ask_user","permissionPrompt":false,"args":{"question":"Pick one","options":[{"label":"A"}]}}',
      '',
      'event: done',
      'data: {"type":"done","stopReason":"cancelled"}',
      '',
    ].join('\n');
    globalThis.fetch = (async (input) => {
      if (String(input) === '/api/cli/chat') {
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await useChatStore.getState().sendMessage('ask one question');

    const assistant = useChatStore.getState().readMessages(sid, 'forge')
      .find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls).toMatchObject([{
      callId: 'native-ask-1', name: 'ask_user', status: 'running',
    }]);
    expect(assistant?.toolCalls[0]?.permissionPrompt).toBeUndefined();
  });

  it('routes a project slash skill through every registered CLI kernel', async () => {
    const providers = ['claude-code', 'forgeax-core', 'codex', 'cursor-agent', 'codebuddy', 'kimi-code'];
    const requests: Array<{ provider: string; message: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/skills?sessionId=')) {
        expect(new URL(url, 'http://localhost').searchParams.get('sessionId')).toBe(useShellStore.getState().activeSid);
        return new Response(JSON.stringify({
          skills: [{
            id: 'shared-kernel-smoke',
            extensionId: '@forgeax-extension/shared-kernel-smoke-skill',
            triggers: [{ kind: 'slash', command: 'shared-kernel-smoke' }],
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/skills/run') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { skillId?: string; extensionId?: string };
        expect(body).toEqual({
          skillId: 'shared-kernel-smoke',
          extensionId: '@forgeax-extension/shared-kernel-smoke-skill',
          input: 'kernel input',
          caller: { kind: 'user', sessionId: expect.any(String), agentId: 'forge' },
        });
        return new Response(JSON.stringify({ ok: true, kind: 'prompt', text: 'SHARED_KERNEL_SKILL_OK' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/cli/chat') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { providerOverride?: string; message?: string };
        requests.push({ provider: body.providerOverride ?? '', message: body.message ?? '' });
        return new Response(
          'event: token\ndata: {"type":"token","text":"ok","providerId":"' + body.providerOverride + '"}\n\n' +
          'event: done\ndata: {"type":"done","providerId":"' + body.providerOverride + '"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    for (const provider of providers) {
      const sid = `skill-${provider}`;
      setShellTarget(tab(sid, 'forge', provider));
      await useChatStore.getState().sendMessage('/shared-kernel-smoke kernel input');
    }

    expect(requests).toHaveLength(providers.length);
    expect(requests.map((request) => request.provider)).toEqual(providers);
    for (const request of requests) {
      expect(request.message).toContain('SHARED_KERNEL_SKILL_OK');
      expect(request.message).toContain('User input:\nkernel input');
    }
  });

  it('keeps the visible thread aligned with an @mentioned agent', async () => {
    const sid = 'sid-mention';
    let request: { agentId?: string; message?: string } | undefined;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === '/api/cli/chat') {
        request = JSON.parse(String(init?.body ?? '{}')) as { agentId?: string; message?: string };
        return new Response(
          'event: token\ndata: {"type":"token","text":"ok","providerId":"test-cli"}\n\n' +
          'event: done\ndata: {"type":"done","providerId":"test-cli"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    setShellTarget(tab(sid, 'forge'));
    await useChatStore.getState().sendMessage('@iori inspect the scene', {
      target: { sid, agentId: 'forge' },
    });

    expect(request).toMatchObject({ agentId: 'iori', message: '@iori inspect the scene' });
    expect(useShellStore.getState().tabs[0]?.agentId).toBe('iori');
    expect(useChatStore.getState().readMessages(sid, 'forge')).toEqual([]);
    expect(useChatStore.getState().readMessages(sid, 'iori')[0]).toMatchObject({
      role: 'user',
      text: '@iori inspect the scene',
    });
  });

  it('routes a mention-only send instead of falling back to the pinned agent', async () => {
    const sid = 'sid-mention-only';
    let request: { agentId?: string; message?: string } | undefined;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === '/api/cli/chat') {
        request = JSON.parse(String(init?.body ?? '{}')) as { agentId?: string; message?: string };
        return new Response('event: done\ndata: {"type":"done"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    setShellTarget(tab(sid, 'forge'));
    await useChatStore.getState().sendMessage('@iori ', {
      target: { sid, agentId: 'forge' },
    });

    expect(request).toMatchObject({ agentId: 'iori', message: '@iori' });
    expect(useShellStore.getState().tabs[0]?.agentId).toBe('iori');
    expect(useChatStore.getState().readMessages(sid, 'iori')[0]).toMatchObject({
      role: 'user',
      text: '@iori',
    });
  });
});

describe('chat segment visibility', () => {
  it('does not merge public summaries into private reasoning', () => {
    const privateSegment = appendChatSegment([], {
      kind: 'thinking', ts: 1, text: 'private', visibility: 'private_reasoning',
    });
    const mixed = appendChatSegment(privateSegment, {
      kind: 'thinking', ts: 2, text: 'public', visibility: 'public_summary',
    });
    expect(mixed).toHaveLength(2);
    expect(mixed[1]).toMatchObject({ visibility: 'public_summary', text: 'public' });
    const joined = appendChatSegment(mixed, {
      kind: 'thinking', ts: 3, text: ' summary', visibility: 'public_summary',
    });
    expect(joined).toHaveLength(2);
    expect(joined[1]).toMatchObject({ visibility: 'public_summary', text: 'public summary' });
  });

  it('sends the displayed model without reading another window shared selection', async () => {
    const sid = 'sid-model-snapshot';
    setShellTarget(tab(sid, 'forge', 'codex'));
    let reads = 0;
    let selected: string | undefined;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === '/api/commands/get_agent_model/query') reads++;
      if (String(input) === '/api/cli/chat') {
        selected = JSON.parse(String(init?.body)).model;
        return new Response('event: done\ndata: {"type":"done","stopReason":"end_turn","providerId":"codex"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('{}');
    }) as typeof fetch;
    await useChatStore.getState().sendMessage('continue', { model: 'gpt-5.6-luna' });
    expect(selected).toBe('gpt-5.6-luna');
    expect(reads).toBe(0);
  });

  it('preserves public-summary visibility through CLI SSE buffering and sends the selected model', async () => {
    const sid = 'sid-public-summary';
    setShellTarget(tab(sid, 'forge', 'codex'));
    let chatBody: { model?: string } | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === '/api/commands/get_agent_model/query') {
        return new Response(JSON.stringify({
          result: {
            ok: true,
            data: { sid, agentPath: 'forge', selected: 'gpt-5.6-luna', chain: ['gpt-5.6-luna'], raw: ['gpt-5.6-luna'] },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/cli/chat') {
        chatBody = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
        return new Response(
          'event: thinking\ndata: {"type":"thinking","text":"Inspecting the active game.","visibility":"public_summary","providerId":"codex"}\n\n' +
          'event: token\ndata: {"type":"token","text":"Done","providerId":"codex"}\n\n' +
          'event: done\ndata: {"type":"done","stopReason":"end_turn","providerId":"codex"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await useChatStore.getState().sendMessage('build it');

    expect(chatBody?.model).toBe('gpt-5.6-luna');
    const assistant = useChatStore.getState().readMessages(sid, 'forge')
      .find((message) => message.role === 'assistant');
    expect(assistant?.segments).toContainEqual(expect.objectContaining({
      kind: 'thinking',
      text: 'Inspecting the active game.',
      visibility: 'public_summary',
    }));
  });
});

it.each([undefined, 'steer'] as const)('does not send a turn when origin preparation fails (%s)', async handoff => {
  setShellTarget(tab('origin-session', 'forge', 'codex'));
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({}); }) as typeof fetch;
  const remove = registerChatSendPreparation(() => { throw new Error('origin unavailable'); });
  try { await useChatStore.getState().sendMessage('hello', handoff ? { handoff } : undefined); }
  finally { remove(); }
  expect(requests).toBe(0);
  expect(useChatStore.getState().bySid['origin-session']?.messagesByAgent.forge?.some(message => message.text.includes('origin unavailable'))).toBe(true);
});

it('keeps queued text when the originating editor cannot prepare the send', async () => {
  setShellTarget(tab('origin-queue', 'forge', 'codex'));
  useChatStore.setState({ queuedMessages: { 'origin-queue::forge': [queued('pending-1', 'keep this text')] } });
  const remove = registerChatSendPreparation(() => { throw new Error('origin unavailable'); });
  try {
    useChatStore.getState().flushQueuedForAgent('origin-queue', 'forge');
    await Bun.sleep(0);
    expect(useChatStore.getState().queuedMessages['origin-queue::forge']?.[0].text).toBe('keep this text');
  } finally { remove(); }
});

 it.each(['/loop 60 repeat task', '/tool editor discover', '/status'])('dequeues an accepted command exactly once (%s)', async text => {
  setShellTarget(tab('command-queue', 'forge', 'codex'));
  useChatStore.setState({ queuedMessages: { 'command-queue::forge': [queued('command-1', text)] } });
  let writes = 0;
  globalThis.fetch = (async (_url, init) => { if (init?.method === 'POST') writes++; return Response.json({ skills: [], ok: true }); }) as typeof fetch;
  useChatStore.getState().flushQueuedForAgent('command-queue', 'forge');
  await Bun.sleep(0);
  expect(useChatStore.getState().queuedMessages['command-queue::forge'] ?? []).toHaveLength(0);
  useChatStore.getState().flushQueuedForAgent('command-queue', 'forge');
  await Bun.sleep(0);
  expect(writes).toBe(1);
});
