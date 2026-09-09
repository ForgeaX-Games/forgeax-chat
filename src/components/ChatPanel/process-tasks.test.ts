import { describe, expect, test } from 'bun:test';
import type { ProcessTrace } from '../../task-flow/model';
import { splitTodoProcessWindow, tasksFromProcess } from '../../task-flow/process-tasks';

describe('tasksFromProcess', () => {
  test('attributes steps to the todo that was active when each event arrived', () => {
    const process: ProcessTrace = {
      id: 'turn-1',
      phase: 'running',
      startedAt: 1,
      agentIds: ['forge'],
      todo: {
        updatedAt: 7,
        items: [
          { id: 'a', content: 'Plan scene', status: 'completed' },
          { id: 'b', content: 'Build scene', activeForm: 'Building scene', status: 'in_progress' },
          { id: 'c', content: 'Verify scene', status: 'pending' },
        ],
      },
      entries: [
        { kind: 'todo_snapshot', id: 'todo-1', ts: 1, items: [
          { id: 'a', content: 'Plan scene', status: 'in_progress' },
          { id: 'b', content: 'Build scene', status: 'pending' },
          { id: 'c', content: 'Verify scene', status: 'pending' },
        ] },
        { kind: 'tool', id: 'tool-read', ts: 2, step: { id: 'read', name: 'Read', status: 'done' } },
        { kind: 'todo_snapshot', id: 'todo-2', ts: 3, items: [
          { id: 'a', content: 'Plan scene', status: 'completed' },
          { id: 'b', content: 'Build scene', status: 'in_progress' },
          { id: 'c', content: 'Verify scene', status: 'pending' },
        ] },
        { kind: 'thinking_summary', id: 'thinking', ts: 4, text: 'Choosing composition', visibility: 'public_summary' },
        { kind: 'tool', id: 'tool-write', ts: 5, step: { id: 'write', name: 'Write', status: 'running' } },
      ],
    };

    const tasks = tasksFromProcess(process);
    expect(tasks.map((task) => [task.content, task.status, task.steps.map((step) => step.id)])).toEqual([
      ['Plan scene', 'completed', ['read']],
      ['Build scene', 'in_progress', ['write']],
      ['Verify scene', 'pending', []],
    ]);
    expect(tasks[1]?.steps[0]?.thinking).toEqual(['Choosing composition']);
  });

  test('keeps pre/post process outside todo while retaining transition and subagent process inside', () => {
    const process: ProcessTrace = {
      id: 'turn-all-process',
      phase: 'done',
      startedAt: 1,
      finishedAt: 10,
      agentIds: ['forge'],
      todo: {
        updatedAt: 9,
        items: [
          { id: 'a', content: 'Inspect project', status: 'completed' },
          { id: 'b', content: 'Implement change', status: 'completed' },
        ],
      },
      entries: [
        { kind: 'thinking_summary', id: 'pre-think', ts: 1, text: 'Understanding the request', visibility: 'public_summary' },
        { kind: 'assistant_intermediate', id: 'pre-note', ts: 2, text: 'I will inspect first.' },
        { kind: 'todo_snapshot', id: 'todo-a', ts: 3, items: [
          { id: 'a', content: 'Inspect project', status: 'in_progress' },
          { id: 'b', content: 'Implement change', status: 'pending' },
        ] },
        { kind: 'tool', id: 'read-entry', ts: 4, step: { id: 'read', name: 'Read', status: 'done' } },
        { kind: 'todo_snapshot', id: 'between', ts: 5, items: [
          { id: 'a', content: 'Inspect project', status: 'completed' },
          { id: 'b', content: 'Implement change', status: 'pending' },
        ] },
        { kind: 'thinking_summary', id: 'transition-think', ts: 6, text: 'Preparing the implementation', visibility: 'public_summary' },
        { kind: 'todo_snapshot', id: 'todo-b', ts: 7, items: [
          { id: 'a', content: 'Inspect project', status: 'completed' },
          { id: 'b', content: 'Implement change', status: 'in_progress' },
        ] },
        { kind: 'subagent', id: 'subagent-worker', ts: 8, agentId: 'worker' },
        { kind: 'todo_snapshot', id: 'all-done', ts: 9, items: [
          { id: 'a', content: 'Inspect project', status: 'completed' },
          { id: 'b', content: 'Implement change', status: 'completed' },
        ] },
        { kind: 'assistant_intermediate', id: 'trailing-note', ts: 10, text: 'Implementation is complete.' },
      ],
    };

    const tasks = tasksFromProcess(process);
    const window = splitTodoProcessWindow(process);
    expect(window.before.map((entry) => entry.id)).toEqual(['pre-think', 'pre-note']);
    expect(window.after.map((entry) => entry.id)).toEqual(['trailing-note']);
    expect(tasks[0]?.steps.map((step) => step.name)).toEqual(['Read']);
    expect(tasks[0]?.steps[0]?.thinking).toBeUndefined();
    expect(tasks[1]?.steps.map((step) => step.name)).toEqual(['Delegate worker']);
    expect(tasks[1]?.steps[0]?.thinking).toEqual(['Preparing the implementation']);
  });
});

// A finished turn does not certify the agent's unfinished checklist.
describe('terminal todo presentation', () => {
  for (const phase of ['done', 'error', 'aborted', 'running', 'waiting_for_input'] as const) {
    test(`preserves snapshots and demotes stale active tasks only when ${phase} is terminal`, () => {
      const items = [
        { id: 'done', content: 'Design', status: 'completed' as const },
        { id: 'active', content: 'Reshape', status: 'in_progress' as const },
        { id: 'pending', content: 'Verify', status: 'pending' as const },
        { id: 'cancelled', content: 'Optional', status: 'cancelled' as const },
      ];
      const process: ProcessTrace = {
        id: 'turn', phase, startedAt: 1, agentIds: ['sino'],
        todo: { items, updatedAt: 2 },
        entries: [{ kind: 'todo_snapshot', id: 'todo', ts: 2, items }],
      };
      const original = JSON.stringify(process);
      const tasks = tasksFromProcess(process);
      expect(tasks.map(task => task.status)).toEqual(items.map(item => item.status));
      expect(tasks[1]?.demotedFromActive === true).toBe(phase !== 'running' && phase !== 'waiting_for_input');
      expect(JSON.stringify(process)).toBe(original);
    });
  }
});

test('a terminal failed turn interrupts unfinished work without changing todo facts or later turns', () => {
  const process: ProcessTrace = {
    id: 'failed-turn', phase: 'error', startedAt: 1, agentIds: [],
    todo: { updatedAt: 2, items: [
      { id: 'done', content: 'Completed work', status: 'completed' },
      { id: 'active', content: 'Verify', status: 'in_progress' },
      { id: 'pending', content: 'Next work', status: 'pending' },
      { id: 'cancelled', content: 'Dropped', status: 'cancelled' },
    ] },
    entries: [
      { id: 'todo', kind: 'todo_snapshot', ts: 2, items: [{ id: 'active', content: 'Verify', status: 'in_progress' }] },
      { id: 'tool', kind: 'tool', ts: 3, step: { id: 'tool', name: 'Verify', status: 'running' } },
    ],
  };
  for (const phase of ['error', 'aborted'] as const) {
    const tasks = tasksFromProcess({ ...process, phase });
    expect(tasks.map((task) => task.status)).toEqual(['completed', 'in_progress', 'pending', 'cancelled']);
    expect(tasks.map((task) => task.terminalState)).toEqual([undefined, 'interrupted', 'incomplete', undefined]);
    expect(tasks[1]?.steps[0]?.status).toBe('frozen');
  }
  const resumed = tasksFromProcess({ ...process, id: 'later-turn', phase: 'running' });
  expect(resumed.every((task) => !task.terminalState)).toBe(true);
  expect(resumed[1]?.steps[0]?.status).toBe('running');
  expect(process.entries[1]?.kind === 'tool' && process.entries[1].step.status).toBe('running');
});
