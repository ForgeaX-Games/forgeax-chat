import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useShellStore, type ChatTab } from '@forgeax/interface/store';
import {
  _chatInternals,
  clearAgentStreamSuppression,
  isAgentStreamSuppressed,
  useChatStore,
  appendChatSegment,
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

  it('keeps an Ask User assistant streaming when the provider omits waitingForInput', async () => {
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
      // The provider lifecycle event is not authoritative while the browser
      // reply is still absent; this event intentionally omits the flag.
      { type: 'hook:turnEnd', source: 'agent:forge', emitterId: agentId, ts: 130, payload: { turnId: 'turn-ask' } },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: events.map((event) => JSON.stringify(event)).join('\n'),
    }), { status: 200 })) as typeof fetch;

    await useChatStore.getState().loadSession(sid, agentId);

    const assistant = useChatStore.getState().readMessages(sid, agentId)
      .find((message) => message.role === 'assistant');
    expect(assistant?.status).toBe('streaming');
    expect(assistant?.toolCalls).toMatchObject([{
      callId: 'ask-no-flag',
      name: 'ask_user',
      status: 'running',
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
      if (url === '/api/skills') {
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
