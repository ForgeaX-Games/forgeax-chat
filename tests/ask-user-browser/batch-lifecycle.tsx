import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AskUserBatch } from '../../src/components/ChatPanel/message-parts/AskUserCard';
import type { ToolCall } from '../../src/session-store';
import { setLocale } from '@forgeax/interface/i18n';
setLocale('en', { persist: false });
const request = (callId: string): ToolCall => ({ callId, name: 'ask_user', status: 'running',
  args: { _askRequestId: callId, questions: [{ id: 'q', question: `Question ${callId}`, options: [`Yes ${callId}`, `No ${callId}`] }] } });
function Fixture() {
  const mode = new URLSearchParams(location.search).get('mode');
  const [calls, setCalls] = useState<ToolCall[]>(mode === 'expired'
    ? [{ ...request('a'), status: 'done' }, request('b')]
    : [request('a'), request('b')]);
  const [sent, setSent] = useState<string[]>([]);
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    setSent(previous => [...previous, body.requestId]);
    if (mode === 'network' && body.requestId === 'b' && !sent.includes('b')) return Response.json({ ok: false }, { status: 503 });
    return Response.json(mode === 'race' && body.requestId === 'a' ? { ok: false, reason: 'no-pending' } : { ok: true });
  }) as typeof fetch;
  return <>
    <button onClick={() => setCalls(previous => [...previous, request('c')])}>Append question</button>
    <output data-testid="sent">{JSON.stringify(sent)}</output>
    <AskUserBatch calls={calls} sid="batch-lifecycle" agentId="forge" />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
