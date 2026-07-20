import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupTodoFlow, type TodoItem } from './groupTodoFlow';
import type { ToolCall } from '../../../session-store';

// ── Fixtures ─────────────────────────────────────────────────────────────

function tool(name: string, callId: string, args: unknown = null): ToolCall {
  return { callId, name, args, status: 'done' };
}
function todoWrite(
  callId: string,
  opts: { todos?: TodoItem[]; merge?: boolean; clear?: boolean },
): ToolCall {
  return { callId, name: 'todo_write', args: opts, status: 'done' };
}

const A_pending: TodoItem = { id: 'a', content: 'Task A', status: 'pending' };
const A_active: TodoItem = { id: 'a', content: 'Task A', status: 'in_progress' };
const A_done: TodoItem = { id: 'a', content: 'Task A', status: 'completed' };
const B_pending: TodoItem = { id: 'b', content: 'Task B', status: 'pending' };
const B_active: TodoItem = { id: 'b', content: 'Task B', status: 'in_progress' };
const C_pending: TodoItem = { id: 'c', content: 'Task C', status: 'pending' };
const C_active: TodoItem = { id: 'c', content: 'Task C', status: 'in_progress' };

// ── Tests ────────────────────────────────────────────────────────────────

describe('groupTodoFlow', () => {
  it('case 1: single todo_write replace with active todo', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_active, B_pending] }),
      tool('grep', 't1'),
      tool('read_file', 't2'),
    ]);
    assert.deepEqual(r.currentTodoState, [A_active, B_pending]);
    assert.equal(r.preFlowTools.length, 0);
    assert.deepEqual(r.nestedToolsByTodoId['a'].map((t) => t.callId), ['t1', 't2']);
    assert.equal(Object.keys(r.nestedToolsByTodoId).length, 1);
  });

  it('case 2: merge=true updates existing by id, preserves siblings', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_pending, B_pending] }),
      todoWrite('tw2', { todos: [{ id: 'a', status: 'in_progress' }], merge: true }),
      tool('grep', 't1'),
    ]);
    // a should now be in_progress (status updated); b unchanged
    assert.equal(r.currentTodoState?.[0].id, 'a');
    assert.equal(r.currentTodoState?.[0].status, 'in_progress');
    assert.equal(r.currentTodoState?.[0].content, 'Task A'); // preserved from prev
    assert.equal(r.currentTodoState?.[1].id, 'b');
    assert.equal(r.currentTodoState?.[1].status, 'pending');
    // t1 should bucket under a (which is now in_progress)
    assert.deepEqual(r.nestedToolsByTodoId['a'].map((t) => t.callId), ['t1']);
  });

  it('case 3: merge=false (full replace) replaces state entirely', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_active] }),
      todoWrite('tw2', { todos: [C_pending] }),
      tool('grep', 't1'),
    ]);
    assert.deepEqual(r.currentTodoState, [C_pending]);
    // No in_progress todo after replace → t1 goes to preFlowTools
    assert.deepEqual(r.preFlowTools.map((t) => t.callId), ['t1']);
    assert.equal(Object.keys(r.nestedToolsByTodoId).length, 0);
  });

  it('case 4: empty todos array skipped (load-bearing)', () => {
    // Renderer sees raw LLM-emitted args before the tool layer's non-empty
    // guard runs. Empty array must preserve prior state, not crash.
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_active] }),
      todoWrite('tw2', { todos: [] }), // should be no-op
      tool('grep', 't1'),
    ]);
    assert.deepEqual(r.currentTodoState, [A_active]);
    assert.deepEqual(r.nestedToolsByTodoId['a'].map((t) => t.callId), ['t1']);
  });

  it('case 5: clear=true resets state to null', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_active] }),
      tool('grep', 't1'),
      todoWrite('tw2', { clear: true }),
      tool('read_file', 't2'),
    ]);
    assert.equal(r.currentTodoState, null);
    // t1 still bucketed under a (it fired BEFORE clear); t2 fired AFTER
    // clear with no todo flow active → preFlowTools
    assert.deepEqual(r.nestedToolsByTodoId['a'].map((t) => t.callId), ['t1']);
    assert.deepEqual(r.preFlowTools.map((t) => t.callId), ['t2']);
  });

  it('case 6: no in_progress (all in pending/completed/cancelled) → tools go to preFlowTools', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_done, B_pending, { id: 'x', status: 'cancelled' }] }),
      tool('grep', 't1'),
      tool('read_file', 't2'),
    ]);
    assert.deepEqual(r.currentTodoState?.map((t) => t.id), ['a', 'b', 'x']);
    assert.deepEqual(r.preFlowTools.map((t) => t.callId), ['t1', 't2']);
    assert.equal(Object.keys(r.nestedToolsByTodoId).length, 0);
  });

  it('case 7: multi-todo_write interleaved with tools — buckets follow active todo', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_active, B_pending] }),
      tool('grep', 't1'), // under a
      tool('read_file', 't2'), // under a
      // a completes, b becomes active
      todoWrite('tw2', { todos: [A_done, B_active] }),
      tool('write_file', 't3'), // under b
      tool('list_dir', 't4'), // under b
    ]);
    assert.deepEqual(r.nestedToolsByTodoId['a'].map((t) => t.callId), ['t1', 't2']);
    assert.deepEqual(r.nestedToolsByTodoId['b'].map((t) => t.callId), ['t3', 't4']);
    assert.equal(r.preFlowTools.length, 0);
    // Both buckets preserved even though a is now completed (work history)
  });

  it('case 8: orphan-bucket — merge=false drops prior in_progress todo, its tools flush to preFlowTools', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_active] }),
      tool('grep', 't1'), // under a
      todoWrite('tw2', { todos: [C_active] }), // a is dropped from state
      tool('read_file', 't2'), // under c
    ]);
    assert.deepEqual(r.currentTodoState, [C_active]);
    // a is gone from state → its bucket flushed to preFlowTools
    assert.deepEqual(r.preFlowTools.map((t) => t.callId), ['t1']);
    assert.equal(r.nestedToolsByTodoId['a'], undefined);
    // c is the new active → t2 goes under c
    assert.deepEqual(r.nestedToolsByTodoId['c'].map((t) => t.callId), ['t2']);
  });

  it('todo_write itself is never rendered as a chip', () => {
    const r = groupTodoFlow([
      todoWrite('tw1', { todos: [A_active] }),
      tool('grep', 't1'),
      todoWrite('tw2', { todos: [A_done], merge: true }),
    ]);
    // Search every bucket — no callId starting with 'tw' should appear
    const allBucketedIds = [
      ...r.preFlowTools.map((t) => t.callId),
      ...Object.values(r.nestedToolsByTodoId).flatMap((arr) => arr.map((t) => t.callId)),
    ];
    assert.ok(allBucketedIds.every((id) => !id.startsWith('tw')), `todo_write leaked: ${JSON.stringify(allBucketedIds)}`);
  });
});
