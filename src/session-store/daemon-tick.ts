/** Daemon-tick → ChatMessage bridge (chat-owned, R4).
 *
 *  `/loop` daemons stream their per-tick output over the `/ws` daemon channel
 *  as `daemon-tick-start|event|end` frames keyed by a unique `tickId`. Each tick
 *  renders as one assistant bubble in the source thread's active-agent slot.
 *  Moved out of L1 alongside the rest of the message domain; L1's daemon WS
 *  keeps the non-chat frames (`telemetry` / `workspace-changed`).
 *
 *  This opens its OWN ws connection (server broadcasts to all clients), so the
 *  chat bundle owns its daemon-tick wiring end-to-end without an L1 callback.
 */
import { useShellStore, type ChatMessage } from '@forgeax/interface/store';
import { useChatStore } from './store';

const _tickMsgIdByTickId = new Map<string, string>();

/** Test seam — orphan daemon-tick entry count after a session close. */
export function _daemonTickMapCount(): number {
  return _tickMsgIdByTickId.size;
}

function activeAgentForSid(sid: string): string | null {
  return useShellStore.getState().tabs.find((tb) => tb.sid === sid)?.agentId ?? null;
}

function handleDaemonTick(msg: unknown): void {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as { type?: string; threadId?: string; tickId?: string; daemonId?: string; event?: unknown; promptPreview?: string; bytes?: number };
  if (!m.threadId || !m.tickId) return;
  if (m.type !== 'daemon-tick-start' && m.type !== 'daemon-tick-event' && m.type !== 'daemon-tick-end') return;
  const sid = m.threadId;
  if (useShellStore.getState().tabs.findIndex((tb) => tb.sid === sid) < 0) return;
  const agentId = activeAgentForSid(sid);
  if (!agentId) return;
  const tickKey = `${sid}::${m.tickId}`;

  if (m.type === 'daemon-tick-start') {
    if (_tickMsgIdByTickId.get(tickKey)) return;
    const id = `daemon-tick-${m.tickId}`;
    _tickMsgIdByTickId.set(tickKey, id);
    const bubble: ChatMessage = {
      id,
      role: 'assistant',
      text: m.promptPreview ? `🔁 daemon \`${m.daemonId}\` tick\n\n> ${m.promptPreview}\n\n---\n\n` : `🔁 daemon \`${m.daemonId}\` tick\n\n`,
      toolCalls: [],
      status: 'streaming',
      ts: Date.now(),
      providerId: 'daemon',
    };
    useChatStore.getState().patchMessages(sid, agentId, (msgs) => [...msgs, bubble]);
    return;
  }
  if (m.type === 'daemon-tick-event' && m.event) {
    const msgId = _tickMsgIdByTickId.get(tickKey);
    if (!msgId) return;
    const ev = m.event as { type: string; text?: string; message?: string; name?: string; args?: unknown; result?: unknown };
    let appendText = '';
    if (ev.type === 'token' && ev.text) appendText = ev.text;
    else if (ev.type === 'tool-call') appendText = `\n\n\`[tool-call] ${ev.name ?? '?'}\``;
    else if (ev.type === 'tool-result') {
      const r = ev.result;
      const text = typeof r === 'string' ? r : JSON.stringify(r ?? '');
      appendText = `\n\n\`[tool-result]\` ${text.slice(0, 400)}`;
    } else if (ev.type === 'error') appendText = `\n\n❌ \`[error]\` ${ev.message ?? ''}`;
    if (!appendText) return;
    useChatStore.getState().patchMessages(sid, agentId, (msgs) => msgs.map((mm) => (mm.id === msgId ? { ...mm, text: mm.text + appendText } : mm)));
    return;
  }
  if (m.type === 'daemon-tick-end') {
    const msgId = _tickMsgIdByTickId.get(tickKey);
    if (!msgId) return;
    _tickMsgIdByTickId.delete(tickKey);
    useChatStore.getState().patchMessages(sid, agentId, (msgs) => msgs.map((mm) => (mm.id === msgId ? { ...mm, status: 'done', text: mm.text + `\n\n_— tick done · ${m.bytes ?? 0} bytes —_` } : mm)));
  }
}

// Drop orphan tick entries when a session tab is removed (memleak case-12).
let _prevSids: string[] = [];
useShellStore.subscribe((s) => {
  const sids = s.tabs.map((tb) => tb.sid);
  if (sids.length === _prevSids.length && sids.every((x, i) => x === _prevSids[i])) return;
  const removed = _prevSids.filter((sid) => !sids.includes(sid));
  _prevSids = sids;
  for (const sid of removed) {
    for (const k of [..._tickMsgIdByTickId.keys()]) {
      if (k.slice(0, sid.length + 2) === `${sid}::`) _tickMsgIdByTickId.delete(k);
    }
  }
});

// R5/P1 — no longer opens its OWN socket. daemon-tick-* frames now arrive on the
// shared L1 broadcast stream (one `/ws` per page, opened by bootBroadcast). chat
// boot calls subscribeDaemonTick() to register its handler; the actual socket is
// the single broadcast primitive. This removes the duplicate broadcast socket R4
// introduced (back to two sockets: sid session-event + one broadcast).
import { subscribeBroadcast } from '@forgeax/interface/lib/broadcast-stream';

const FLAG = '__FORGEAX_CHAT_DAEMON_TICK__';
type Slot = { handler: typeof handleDaemonTick; subscribed?: boolean };
type WithFlag = { [FLAG]?: Slot };
const _gt = globalThis as unknown as WithFlag;
// Create the slot ONCE (never replaced), so the live handler can be hot-swapped
// on HMR without re-subscribing or dropping frames.
_gt[FLAG] ??= { handler: handleDaemonTick };
_gt[FLAG]!.handler = handleDaemonTick;

/** chat boot 调一次：把 daemon-tick-{start,event,end} 帧接到共享广播流。幂等 + HMR 安全。 */
export function subscribeDaemonTick(): void {
  const slot = _gt[FLAG]!;
  if (slot.subscribed) return;
  slot.subscribed = true;
  const dispatch = (m: unknown): void => { _gt[FLAG]!.handler(m); };
  subscribeBroadcast('daemon-tick-start', dispatch);
  subscribeBroadcast('daemon-tick-event', dispatch);
  subscribeBroadcast('daemon-tick-end', dispatch);
}
