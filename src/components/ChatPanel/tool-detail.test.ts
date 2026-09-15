import { expect, test } from 'bun:test';
import { toolDetail, changedFiles } from './tool-detail';
import { delegationDetail } from './delegation-detail';
import type { TaskFlowToolCall } from '../../task-flow/model';
const call = (values: Partial<TaskFlowToolCall>): TaskFlowToolCall => ({callId:'1', name:'edit_file', status:'done', args:{}, ...values});
test('edits retain full path and before/after content', () => {
 const result = toolDetail(call({args:{path:'C:\\game\\main.ts',old_string:'old',new_string:'new'}}));
 expect(result.inputs.map(x => x.text)).toEqual(['C:\\game\\main.ts','old','new']);
});
test('full output takes precedence and structured results remain readable', () => {
 expect(toolDetail(call({result:'short',fullResultContent:'complete'})).output).toBe('complete');
 expect(toolDetail(call({resultData:{count:0}})).output).toContain('"count": 0');
 expect(toolDetail(call({args:null})).inputs).toEqual([]);
});
test('sensitive inputs are redacted', () => {
 expect(toolDetail(call({args:{api_key:'private'}})).inputs[0]?.text).toBe('[redacted]');
});
test('delegations read resident and template contracts without inventing targets', () => {
 expect(delegationDetail(call({name:'delegate_to_subagent',args:{agent:'audio',message:'Make sound'}}))).toEqual({target:'audio',message:'Make sound'});
 expect(delegationDetail(call({name:'delegate_to_subagent',args:{templateRef:'scene'}}))?.target).toBe('scene');
 expect(delegationDetail(call({}))).toBeNull();
});

test('Codex changes expose each file and its real diff', () => {
 expect(changedFiles({changes:[{path:'a.ts',diff:'-old\n+new'},{path:'b.ts',diff:'+next'},null]})).toEqual([{path:'a.ts',diff:'-old\n+new'},{path:'b.ts',diff:'+next'}]);
});

test('host envelopes show the result once without duplicated transport metadata', () => {
 expect(toolDetail(call({result:JSON.stringify({text:'Wrote file',structuredContent:{forgeax:{result:'Wrote file'}}})})).output).toBe('Wrote file');
});
