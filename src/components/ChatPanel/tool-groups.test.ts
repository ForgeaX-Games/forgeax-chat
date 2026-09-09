import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canGroupTool, groupConsecutive, toolGroupLabel } from './tool-groups';
import type { Step } from '../../task-flow/model';

const step = (name: string, status: Step['status'] = 'done'): Step => ({ id: name, name, status, tool: { name } as Step['tool'] });
const t = (key: string, args: Record<string, unknown> = {}) => key.replace('taskFlow.', '') + ':' + (args.count ?? '');
test('mixed consecutive calls share a group; narration and decisions split groups', () => {
  const items = [step('read_file'), step('list_dir'), { id: 'text', name: 'Progress', status: 'done' } as Step, step('bash'), step('ask_user'), step('subagent'), step('read_file')];
  assert.deepEqual(groupConsecutive(items, canGroupTool).map(g => g.length), [2, 1, 1, 1, 1, 1]);
});
test('one or two kinds use deterministic counts, three or unknown use a generic label', () => {
  assert.equal(toolGroupLabel([step('read_file'), step('read_file')], t), 'groupReads:2');
  assert.equal(toolGroupLabel([step('read_file'), step('list_dir')], t), 'groupReads:1groupSeparator:groupDirectories:1');
  assert.equal(toolGroupLabel([step('read_file'), step('list_dir'), step('bash')], t), 'groupDone:3');
  assert.equal(toolGroupLabel([step('custom')], t), 'groupDone:1');
});
test('running, failed and interrupted operations never claim success', () => {
  assert.equal(toolGroupLabel([step('read_file', 'running')], t), 'groupRunning:1');
  assert.equal(toolGroupLabel([step('read_file', 'frozen')], t), 'groupStopped:1');
  assert.ok(toolGroupLabel([step('read_file', 'error')], t).includes('groupFailures:1'));
  assert.ok(toolGroupLabel([step('read_file', 'running'), step('bash', 'error')], t).startsWith('groupRunning:2'));
});
