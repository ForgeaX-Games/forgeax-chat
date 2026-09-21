import { expect, test } from 'bun:test';
import { requestGroups } from './request-groups';
const row = (messageId: string) => ({kind:'message' as const, messageId, segmentIndexes: [], ts: 0});
test('continuations share one observed user request while new requests remain separate', () => {
 const messages = [{id:'u',role:'user'},{id:'a',role:'assistant'},{id:'b',role:'assistant'},{id:'v',role:'user'},{id:'c',role:'assistant'}];
 const groups = requestGroups(messages.map(m=>row(m.id)), messages);
 expect(groups.map(g=>g.assistantIds)).toEqual([[],['a','b'],[],['c']]);
});
test('partial history requires a known request anchor and preserves every item', () => {
 const missing = [{id:'a',role:'assistant'},{id:'b',role:'assistant'}];
 expect(requestGroups(missing.map(m=>row(m.id)),missing)).toHaveLength(2);
 const full = [{id:'u',role:'user'},...missing];
 expect(requestGroups(missing.map(m=>row(m.id)),full)[0]?.assistantIds).toEqual(['a','b']);
});
test('system notices and artifacts are retained as boundaries', () => {
 const messages=[{id:'u',role:'user'},{id:'a',role:'assistant'},{id:'notice',role:'system'},{id:'b',role:'assistant'}];
 const groups=requestGroups(messages.map(m=>row(m.id)),messages);
 expect(groups.flatMap(g=>g.items)).toEqual(messages.map(m=>row(m.id)));
 expect(groups.every(g=>g.assistantIds.length<2)).toBe(true);
});
