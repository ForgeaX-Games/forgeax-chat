/** CLI 桥的每一个终点都必须收口 trace。
 *
 *  2026-08-06 外审 MAJOR:上一轮给 CLI SSE 分支补了 `beginChatTurn`(开链),**却没接收口** ——
 *  `chatFirstToken` / `chatTurnEnd` 的调用在 `session-stream.ts`(原生路的 WS 流)里,而 CLI
 *  路径根本不走那条。后果比"没有 trace"更坏:`ui.send`/`ui.request` 永远 provisional,失速
 *  看门狗永不撤销,于是模型明明已经输出,监控每 30/60/90s 记一次 `no-first-token` ——
 *  **正常会话被标成卡死**,产生假告警。
 *
 *  这里钉的不是某一处调用,是"**每个 return 都得收口**"这条纪律本身:CLI 分支有 6 个终点
 *  (网络失败 / HTTP 失败 / 空 body / 流内 error / 取消 / 正常读完),漏掉任意一个就重现事故。
 *  实现时我先前只列了 5 个,第 6 个(200 但 res.body 为空)是复核落点时才发现的。 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { useShellStore, type ChatTab } from '@forgeax/interface/store';
import { _chatInternals, useChatStore } from './store';

const initialChatState = useChatStore.getState();
const initialShellState = useShellStore.getState();
const initialFetch = globalThis.fetch;
const initialWarn = console.warn;

/** 记录 trace 生命周期调用 —— 断言的是"收没收口",不是 span 内容(那由 trace.test.ts 管)。 */
const ended: Array<{ outcome: 'ok' | 'cancelled' | 'error'; err?: string }> = [];
let began = 0;
mock.module('@forgeax/interface/lib/trace', () => ({
  beginChatTurn: () => { began += 1; return { traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' }; },
  chatFirstToken: () => {},
  chatTurnEnd: (_agentId: string, outcome: 'ok' | 'cancelled' | 'error', err?: string) => { ended.push({ outcome, ...(err ? { err } : {}) }); },
}));

function setTarget(sid: string): void {
  const target: ChatTab = { sid, agentId: 'forge', providerOverride: 'codex', displayName: 't' };
  useShellStore.setState({ tabs: [target], activeSid: sid, currentSessionId: sid, providerOverride: 'codex', busyByAgentBySid: {} });
}

beforeEach(() => {
  ended.length = 0; began = 0;
  _chatInternals.abortByTab.clear();
  useChatStore.setState({ ...initialChatState, bySid: {}, queuedMessages: {} }, true);
  useShellStore.setState({ ...initialShellState, tabs: [], activeSid: null, busyByAgentBySid: {} }, true);
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

describe('CLI 桥的 trace 收口', () => {
  it('网络失败:开了链就必须收口,且标成失败', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/cli/chat') return new Response('{}', { status: 200 });
      throw new Error('boom');
    }) as typeof fetch;

    setTarget('sid-net');
    await useChatStore.getState().sendMessage('hi');

    expect(began).toBe(1);
    expect(ended).toHaveLength(1);        // 恰好一次 —— 不漏也不重
    expect(ended[0]!.outcome).toBe('error');
  });

  it('HTTP 失败:同样收口,错误文案带上状态码', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/cli/chat') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ error: 'kernel down' }), { status: 503 });
    }) as typeof fetch;

    setTarget('sid-http');
    await useChatStore.getState().sendMessage('hi');

    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('error');
    expect(ended[0]!.err).toContain('503');
  });

  it('200 但 body 为空(第 6 个终点,实现时差点漏掉):也必须收口', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/cli/chat') return new Response('{}', { status: 200 });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    setTarget('sid-empty');
    await useChatStore.getState().sendMessage('hi');

    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('error');
    expect(ended[0]!.err).toBe('empty response body');
  });

  it('正常读完:收口且标成成功 —— 否则 trace 里全是假失败', async () => {
    const body = 'event: token\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/cli/chat') return new Response('{}', { status: 200 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    setTarget('sid-ok');
    await useChatStore.getState().sendMessage('hi');

    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('ok');
  });

  // ↓ 补上此前缺的两个终点。它们缺席不是小事:取消被记成失败的 bug 之所以没被抓到,
  //   就是因为这两格是空的(文件头声称 6 个终点,实际只测了 4 个)。
  it('流内 error 帧:收口一次并标成失败 —— EOF 不许把错误盖成健康完成', async () => {
    const body = 'event: error\ndata: {"message":"上游流中断"}\n\n';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/cli/chat') return new Response('{}', { status: 200 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    setTarget('sid-stream-err');
    await useChatStore.getState().sendMessage('hi');

    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('error');
  });

  it('用户取消:独占 cancelled,既不算失败也不并进成功', async () => {
    // 标成 error → trace 里全是用户主动停的假失败;并进 ok → 误触取消风暴在监控里与健康
    // 流量同形。取消是第三种结局。判据还必须**优先于流内错误**:取消的 teardown 常常顺带
    // 甩出一条 error 帧或一个非 AbortError 的异常。
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/cli/chat') return new Response('{}', { status: 200 });
      const signal = init?.signal;
      if (!signal) throw new Error('chat request must carry an abort signal');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = (): void => controller.error(new DOMException('Aborted', 'AbortError'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        },
      });
      started();
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    setTarget('sid-cancel');
    const sending = useChatStore.getState().sendMessage('hi');
    await fetchStarted;
    _chatInternals.abortByTab.get('sid-cancel')?.controller.abort();
    await sending;

    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('cancelled');
    expect(ended[0]!.err).toBeUndefined(); // 用户主动停不该带故障文案
  });

  it('取消与流内 error 同时发生:取消赢 —— 否则用户主动停会被记成故障', async () => {
    // 这一格是外部顾问和 sol 的 SELF-CHECK 都点出来的:取消触发的 teardown 常常先甩出一条
    // error 帧,若让 error 赢,监控里看到的就是一堆并不存在的故障。判据顺序必须被钉住。
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/cli/chat') return new Response('{}', { status: 200 });
      const signal = init?.signal;
      if (!signal) throw new Error('chat request must carry an abort signal');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = (): void => {
            // 先推一条主轮 error 帧(会写进 streamError),再让流以 AbortError 结束。
            controller.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"teardown"}\n\n'));
            controller.error(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        },
      });
      started();
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    setTarget('sid-cancel-race');
    const sending = useChatStore.getState().sendMessage('hi');
    await fetchStarted;
    _chatInternals.abortByTab.get('sid-cancel-race')?.controller.abort();
    await sending;

    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('cancelled');
  });
});
