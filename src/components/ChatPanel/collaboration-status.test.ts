import { expect, test } from 'bun:test';
import type { ChatMessage } from '../../session-store';
import type { DelegationSnapshot } from '../../event-engine/delegation-status';
import { collaborationWork, collaborationSummary, collaborationStatusLabel, isCollaborationActive } from './collaboration-status';
const sent = (agent = 'suzu', ts = 1): ChatMessage => ({ id: `sent-${agent}-${ts}`, role: 'system', source: 'forge(user_input)', from: '/root/forge#1', to: agent, ts, text: 'Design the HUD\nFull assignment', toolCalls: [], status: 'done' });
const reply = (ts = 2): ChatMessage => ({ ...sent(), id: `reply-${ts}`, source: 'suzu(message)', from: 'suzu', to: 'forge', ts, text: 'HUD notes saved' });
const state = (status: DelegationSnapshot['status'], ts: number, outcome?: DelegationSnapshot['outcome'], task = 'task1') => ({
  ...reply(ts), id: `delegation-${task}`, delegation: { delegationId: task, ownerTaskId: task, agent: 'suzu', status, ...(outcome ? { outcome } : {}) },
});
test('assignment is visible immediately without inventing a running state, and unrelated flags do not activate it', () => {
  expect(collaborationWork([sent()], 'forge', {other:true})[0]?.status).toBe('dispatched');
  expect(collaborationWork([sent()], 'forge', {'/root/suzu#2':true})[0]?.status).toBe('running');
  expect(collaborationWork([sent()], 'other', {})).toEqual([]);
  expect(collaborationWork([sent()], null, {})).toEqual([]);
});
test('reply is not task success and does not stop a still-active specialist', () => {
  expect(collaborationWork([sent(),reply()], 'forge', {})[0]?.status).toBe('responded');
  expect(collaborationWork([sent(),reply()], 'forge', {suzu:true})[0]?.status).toBe('running');
  expect(collaborationWork([sent(),reply()], 'suzu', {})).toEqual([]);
});
test('new assignment replaces the old reply; incoming errors close the matching work', () => {
  const messages = [sent(),reply(),sent('suzu',3)];
  expect(collaborationWork(messages,'forge',{})[0]?.status).toBe('dispatched');
  expect(collaborationWork([...messages,{...reply(4),level:'error'}],'forge',{})[0]?.status).toBe('failed');
});
test('public lifecycle wins over stream flags and preserves task identity and outcomes', () => {
  for (const status of ['queued','running','waiting_permission','stopping'] as const) {
    expect(collaborationWork([sent(),state(status,2)],'forge',{suzu:true})[0]?.status).toBe(status);
  }
  for (const outcome of ['completed','failed','cancelled'] as const) {
    const work = collaborationWork([sent(),state('returned',3,outcome)],'forge',{suzu:true},'suzu');
    expect(work).toHaveLength(1);
    expect(work[0]?.status).toBe(outcome === 'completed' ? 'returned' : outcome);
    expect(isCollaborationActive(work[0]!.status)).toBe(false);
  }
  const work = collaborationWork([sent(),state('running',3,undefined,'new-task'),state('returned',4,'completed','old-task')],'forge',{suzu:true});
  expect(work).toHaveLength(2);
  expect(work.find(item => item.id === 'new-task:new-task')?.status).toBe('running');
});
test('permission applies to the correct peer only and does not revive terminal work', () => {
  const work = collaborationWork([sent(),sent('iori')],'forge',{suzu:true,iori:true},'/root/suzu#2');
  expect(work.map(item=>item.status)).toEqual(['waiting_permission','running']);
  expect(collaborationWork([sent()],'forge',{suzu:true},undefined,['suzu'])[0]?.status).toBe('waiting_input');
});
test('out-of-order rows and lifecycle updates produce the same task and stable assignment time', () => {
  const work = collaborationWork([state('running',3),sent(),state('queued',2)],'forge',{});
  expect(work).toHaveLength(1);
  expect(work[0]?.since).toBe(1);
  expect(work[0]?.brief).toContain('Design the HUD');
  expect(work[0]?.status).toBe('running');
});
test('labels distinguish assignment, execution, reply, success and failure in both languages', () => {
  expect(collaborationStatusLabel('dispatched',true)).toContain('等待进展');
  expect(collaborationStatusLabel('responded',false)).toBe('Reply received');
  expect(collaborationStatusLabel('returned',false)).toBe('Result returned');
  expect(collaborationStatusLabel('failed',true)).toBe('执行失败');
});

test('summary shows the public result instead of repeating its assignment wrapper', () => {
  expect(collaborationSummary('Assigned task\n\n--- suzu 的产出 ---\nPress R to restart.\nMore details')).toBe('Press R to restart.');
  expect(collaborationSummary('  A short public update\nDetails')).toBe('A short public update');
});
