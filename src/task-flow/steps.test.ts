import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '@forgeax/interface/i18n';
import type { TaskFlowToolCall } from './model';
import { buildStep, stepLabel } from './steps';

describe('task-flow steps', () => {
  it('uses semantic labels and keeps tool details attached', () => {
    const tool: TaskFlowToolCall = {
      callId: 'edit-1',
      name: 'edit_file',
      args: { file_path: '/tmp/player.ts' },
      status: 'done',
    };
    assert.equal(stepLabel(tool), 'Edit file · player.ts');
    const step = buildStep(tool, ['Inspecting the file'], ['Applying the change']);
    assert.equal(step.status, 'done');
    assert.deepEqual(step.thinking, ['Inspecting the file']);
    assert.deepEqual(step.narration, ['Applying the change']);
  });

  it('translates the label with the active locale', () => {
    const tool: TaskFlowToolCall = { callId: 'read-1', name: 'read_file', args: {}, status: 'done' };
    setLocale('zh', { persist: false });
    try {
      assert.equal(stepLabel(tool), '读取文件');
    } finally {
      setLocale('en', { persist: false });
    }
  });
});
