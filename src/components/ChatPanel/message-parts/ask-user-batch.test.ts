import { expect, test } from 'bun:test';
import { batchAskCalls } from './ask-user-batch';

test('independent questions with identical ids return to their own requests', () => {
  const calls = ['a', 'b', 'c'].map(callId => ({ callId, name: 'ask_user', status: 'running' as const,
    args: { _askRequestId: `request-${callId}`, questions: [{ id: 'same', question: callId, options: ['yes', 'no'] }] } }));
  const batch = batchAskCalls(calls);
  expect(new Set(batch.call.args.questions.map(q => q.id)).size).toBe(3);
  expect(batch.replies(batch.call.args.questions.map(q => ({ questionId: q.id, values: [q.question!] }))))
    .toEqual(calls.map(call => ({ callId: call.callId, answered: false, requestId: `request-${call.callId}`, answers: [{questionId: 'same', values: [call.callId]}] })));
});

const request = (callId: string) => ({ callId, name: 'ask_user', status: 'running' as const,
  args: { _askRequestId: `request-${callId}`, questions: [{ id: 'same', question: callId, options: ['yes', 'no'] }] } });

test('an expired batch member cannot require an answer or receive a reply', () => {
  const batch = batchAskCalls([{ ...request('old'), status: 'done' }, request('live')]);
  expect(batch.call.args.questions.map(question => question.question)).toEqual(['live']);
  expect(batch.replies([]).map(reply => reply.requestId)).toEqual(['request-live']);
});

test('batch identity follows pending membership, including a late question', () => {
  const first = batchAskCalls([request('a'), request('b')]);
  const expanded = batchAskCalls([request('a'), request('b'), request('c')]);
  expect(expanded.call.callId).not.toBe(first.call.callId);
  const remaining = batchAskCalls([{ ...request('a'), status: 'done' }, request('b')]);
  expect(remaining.call.callId).not.toBe(first.call.callId);
});
