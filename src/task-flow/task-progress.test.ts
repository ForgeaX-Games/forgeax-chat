import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from './model';
import { taskProgress, taskProgressKey } from './task-progress';
import { useTaskFlowUiStore } from './ui-store';

const task = (statuses: Task['steps'][number]['status'][]): Task => ({
  id: 'task', content: 'Build scene', status: 'in_progress',
  steps: statuses.map((status, index) => ({ id: String(index), name: 'step', status })),
});

test('finishing all currently known steps never means the task is complete', () => {
  for (const count of [0, 1, 2, 100, 10000]) {
    const progress = taskProgress(task(Array(count).fill('done')));
    assert.ok(progress >= 8 && progress <= 95);
  }
});

test('new steps do not reduce progress; successful work advances it', () => {
  const first = taskProgress(task(['done']));
  assert.equal(taskProgress(task(['done', 'running'])), first);
  assert.ok(taskProgress(task(['done', 'done'])) > first);
  assert.equal(taskProgress(task([]), first), first);
});

test('errors, cancellation and interruptions are not success', () => {
  assert.equal(taskProgress(task(['error', 'frozen', 'pending', 'running'])), 8);
  assert.ok(taskProgress({ ...task([]), status: 'cancelled' }) < 100);
  assert.ok(taskProgress({ ...task([]), status: 'completed', terminalState: 'incomplete' }) < 100);
  assert.ok(taskProgress({ ...task([]), status: 'completed', terminalState: 'interrupted' }) < 100);
  assert.equal(taskProgress({ ...task([]), status: 'completed' }), 100);
  assert.ok(taskProgress({ ...task(['running']), status: 'completed' }) < 100);
  assert.ok(taskProgress({ ...task(['pending']), status: 'completed' }) < 100);
});

test('duplicate step projections do not inflate the estimate', () => {
  const one = task(['done']);
  assert.equal(taskProgress({ ...one, steps: [...one.steps, ...one.steps] }), taskProgress(one));
});

test('remembered progress survives remounts and stale projections without update loops', () => {
  const key = taskProgressKey('session', 'round', 'task');
  useTaskFlowUiStore.getState().rememberTaskProgress(key, 60);
  const state = useTaskFlowUiStore.getState();
  state.rememberTaskProgress(key, 20);
  assert.equal(useTaskFlowUiStore.getState(), state);
  assert.equal(taskProgress(task([]), state.taskProgress[key]), 60);
  state.rememberTaskProgress(key, 60);
  assert.equal(useTaskFlowUiStore.getState(), state);
  state.rememberTaskProgress(key, 100);
  assert.equal(useTaskFlowUiStore.getState().taskProgress[key], 95);
});

test('session, round and task identities have independent progress', () => {
  const keys = [taskProgressKey('a', 'r', 't'), taskProgressKey('b', 'r', 't'),
    taskProgressKey('a', 's', 't'), taskProgressKey('a', 'r', 'u'),
    taskProgressKey('a:r', 't', ''), taskProgressKey('a', 'r:t', '')];
  assert.equal(new Set(keys).size, keys.length);
});
