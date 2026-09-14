import { expect, test } from 'bun:test';
import { displayQuestion, sendReply, AskRequestExpiredError } from './AskUserCard';

const progress = (current: number, total: number) => `${current}/${total}`;

test('single question has no progress prefix', () => {
  expect(displayQuestion({ id: 'kind', question: '这次要做什么？' }, 0, 1, '?', progress))
    .toBe('这次要做什么？');
});

test('headered multi-ask hides the progress prefix', () => {
  expect(displayQuestion(
    { id: 'kind', header: '产物', question: '这次要做什么？' },
    0,
    3,
    '?',
    progress,
  )).toBe('这次要做什么？');
});

test('untitled multi-ask keeps the progress prefix', () => {
  expect(displayQuestion(
    { id: 'q1', question: '选一条动作' },
    1,
    2,
    '?',
    progress,
  )).toBe('2/2 · 选一条动作');
});

test('no-pending is an expired request, not a successful answer or raw API error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ ok: false, reason: 'no-pending' }), { preconnect: original.preconnect });
  try {
    await expect(sendReply('session', 'forge', [{ questionId: 'q', values: ['A'] }], 'request')).rejects.toBeInstanceOf(AskRequestExpiredError);
  } finally { globalThis.fetch = original; }
});
