import { expect, test } from 'bun:test';
import type { ChatMessage } from '../../session-store';
import { collaborationUpdates } from './collaboration-updates';
const row = (id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, text: id, ts: Number(id), status: 'done', toolCalls: [], ...extra });
const send = (id: string, to: string) => row(id, 'system', { from: 'forge', to, source: 'forge(user_input)' });
const reply = (id: string, from: string) => row(id, 'system', { from, to: 'forge', source: 'agent(message)' });
const batch = [row('1','user'),send('2','suzu'),send('3','audio'),row('4','assistant'),reply('5','suzu'),row('6','assistant'),reply('7','audio'),row('8','assistant')];
test('two-role batch folds the partial parent reply, preserving dispatch acknowledgement and final summary', () => {
  expect(collaborationUpdates(batch,'forge').map(m=>m.id)).toEqual(['6']);
  expect(collaborationUpdates(batch.slice(0,6),'forge').map(m=>m.id)).toEqual(['6']);
  expect(collaborationUpdates(batch,'suzu')).toEqual([]);
});
test('single-role result remains the final answer and unrelated messages never fold answers', () => {
  expect(collaborationUpdates([row('1','user'),send('2','suzu'),reply('3','suzu'),row('4','assistant')],'forge')).toEqual([]);
  expect(collaborationUpdates([row('1','user'),reply('2','suzu'),row('3','assistant')],'forge')).toEqual([]);
});
test('a later peer can return while the partial answer is still generating; replay uses its start anchor', () => {
  const messages = [...batch];
  messages[5] = {...batch[5]!, ts: 7.5, msgId:'live:forge:6'};
  expect(collaborationUpdates(messages,'forge').map(m=>m.id)).toEqual(['6']);
});
test('user follow-up breaks the automatic callback group', () => {
  expect(collaborationUpdates([...batch.slice(0,5),row('5.5','user'),row('6','assistant')],'forge')).toEqual([]);
});
test('errors, stopped turns, tools, questions and artifacts keep their own visible card', () => {
  for (const patch of [{status:'error' as const},{errorMessage:'failed'},{turnAborted:true},{artifact:{id:'a'}}, {toolCalls:[{callId:'q',name:'ask_user',args:{},status:'running'}]}]) {
    const messages = [...batch];
    messages[5] = {...batch[5],...patch} as ChatMessage;
    expect(collaborationUpdates(messages,'forge')).toEqual([]);
  }
  expect(collaborationUpdates([...batch.slice(0,5),row('5.5','system',{level:'error'}),row('6','assistant')],'forge')).toEqual([]);
});
test('each partial callback in a three-role batch is grouped, final result stays in the timeline', () => {
  const messages = [row('1','user'),send('2','suzu'),send('3','audio'),send('4','iori'),reply('5','suzu'),row('6','assistant'),reply('7','audio'),row('8','assistant'),reply('9','iori'),row('10','assistant')];
  expect(collaborationUpdates(messages,'forge').map(m=>m.id)).toEqual(['6','8']);
  expect(collaborationUpdates([...messages].reverse(),'forge').map(m=>m.id)).toEqual(['6','8']);
});
