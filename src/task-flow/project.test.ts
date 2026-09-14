import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSegment } from '../session-store';
import type { ArtifactSummary, TaskFlowMessage, TaskFlowToolCall } from './model';
import { projectTimeline, projectWorkTimeline } from './project';

const tool = (name: string, callId: string, args: unknown = {}): TaskFlowToolCall => ({
  name,
  callId,
  args,
  status: 'done',
});

const message = (
  id: string,
  role: TaskFlowMessage['role'],
  segments: ChatSegment[],
  status: TaskFlowMessage['status'] = 'done',
): TaskFlowMessage => ({
  id,
  role,
  status,
  text: segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join(''),
  ts: Number(id.replace(/\D/g, '')) || 1,
  segments,
  toolCalls: segments.filter((segment) => segment.kind === 'tool').map((segment) => segment.tool),
});

const todo = (status: 'pending' | 'in_progress' | 'completed') =>
  tool('todo_write', 'todo', { todos: [{ id: 'a', content: 'Ship feature', status }] });

const todoWrite = (callId: string, todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>) =>
  tool('todo_write', callId, { todos });

const deliver = (callId: string, outcome = 'Done'): TaskFlowToolCall => ({
  ...tool('deliver_summary', callId),
  resultData: { summary: { outcome, files: [{ path: 'src/a.ts', change: 'edit' }] } },
});

describe('projectTimeline', () => {
  it('projects todo_write whose args arrive as a JSON string (streaming kernel)', () => {
    // A streaming kernel delivers args as a JSON string; once it closes it must
    // project as a plan instead of lingering as a flat tool chip.
    const asString = tool('todo_write', 'todo-str', JSON.stringify({
      todos: [{ id: 'a', content: 'Ship it', status: 'in_progress' }],
    }));
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build it', ts: 1 }]),
      message('a1', 'assistant', [{ kind: 'tool', tool: asString, ts: 2 }]),
    ]);
    assert.equal(result.roundsById.u1?.plan.length, 1, 'string args should still yield a plan');
    assert.equal(result.roundsById.u1?.plan[0]?.content, 'Ship it');
  });

  it('leaves a truncated todo_write args string alone (no round, no crash)', () => {
    const partial = tool('todo_write', 'todo-part', '{"todos":[{"id":"a","cont');
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build it', ts: 1 }]),
      message('a1', 'assistant', [{ kind: 'tool', tool: partial, ts: 2 }]),
    ]);
    assert.equal(result.timeline.some((item) => item.kind === 'round'), false);
  });

  it('dedupes a tool call that arrives twice under the same callId (streaming kernel)', () => {
    // claude-code can surface the same tool call more than once; step.id === callId
    // is a React key, so a duplicate would collide and spin React into a loop.
    const dupTool = tool('write_file', 'dup-1', { file_path: 'src/a.ts' });
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build it', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todo('in_progress'), ts: 2 },
        { kind: 'tool', tool: dupTool, ts: 3 },
        { kind: 'tool', tool: dupTool, ts: 4 },
      ]),
    ]);
    const round = result.roundsById.u1;
    const stepIds = round?.plan[0]?.steps.map((s) => s.id) ?? [];
    assert.deepEqual(stepIds, ['dup-1'], 'the duplicate callId must collapse to one step');
  });

  it('projects a sub-agent thread (no user message) whose assistant opens with todo_write into a round', () => {
    // A delegated sub-agent has no user message to seed the round; the plan-bearing
    // assistant message itself must materialize one, otherwise it degrades to a
    // flat chip stream (the sub-agent execution page bug).
    const result = projectTimeline([
      message('a1', 'assistant', [
        { kind: 'thinking', text: 'Breaking the vision into pillars.', ts: 2 },
        { kind: 'tool', tool: todo('in_progress'), ts: 3 },
        { kind: 'tool', tool: tool('write_file', 'w1', { file_path: 'pillars.md' }), ts: 4 },
      ]),
    ]);
    const roundItems = result.timeline.filter((item) => item.kind === 'round');
    assert.equal(roundItems.length, 1, 'sub-agent plan should form exactly one round');
    const round = result.roundsById[(roundItems[0] as { roundId: string }).roundId];
    assert.equal(round?.plan.length, 1);
    assert.equal(round?.plan[0]?.steps[0]?.id, 'w1');
  });

  it('keeps question-only messages in the ordinary message timeline', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'How does this work?', ts: 1 }]),
      message('a1', 'assistant', [{ kind: 'text', text: 'It works like this.', ts: 2 }]),
    ]);
    assert.deepEqual(Object.keys(result.roundsById), []);
    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'message', messageId: 'a1', segmentIndexes: [0] },
    ]);
  });

  it('projects only consumed segments from a mixed assistant message', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build it', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'text', text: 'I will start.', ts: 2 },
        { kind: 'tool', tool: todo('in_progress'), ts: 3 },
        { kind: 'thinking', text: 'Reading the code.', ts: 4 },
        { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 5 },
        { kind: 'text', text: 'The first step is complete.', ts: 6 },
      ]),
    ]);
    // In-round assistant text folds into the round (pre-plan → narration,
    // in-task → step narration), so a1 emits no standalone main-flow bubble.
    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'round', roundId: 'u1' },
    ]);
    assert.equal(result.roundsById.u1?.plan[0]?.steps[0]?.id, 'read-1');
    assert.deepEqual(result.roundsById.u1?.narration, ['I will start.']);
  });

  it('absorbs pre-plan thinking into the first task step', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build it', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'thinking', text: 'I need to inspect the project first.', ts: 2 },
        { kind: 'tool', tool: todo('in_progress'), ts: 3 },
        { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 4 },
      ]),
    ]);
    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'round', roundId: 'u1' },
    ]);
    assert.deepEqual(result.roundsById.u1?.plan[0]?.steps[0]?.thinking, ['I need to inspect the project first.']);
  });

  it('uses the last successful deliver call and renders one round', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Ship it', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todo('completed'), ts: 2 },
        { kind: 'tool', tool: deliver('d1', 'First'), ts: 3 },
        { kind: 'tool', tool: deliver('d2', 'Final'), ts: 4 },
      ]),
    ]);
    assert.equal(result.timeline.filter((item) => item.kind === 'round').length, 1);
    assert.equal(result.roundsById.u1?.phase, 'delivered');
    assert.equal(result.roundsById.u1?.deliver?.outcome, 'Final');
  });

  it('projects the host-enriched delivery envelope into the UI model', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Ship it', ts: 1 }]),
      message('a1', 'assistant', [{
        kind: 'tool',
        tool: {
          ...tool('deliver_summary', 'd1'),
          resultData: JSON.stringify({
            ok: true,
            summary: {
              outcome: 'Delivered',
              roundLabel: 'Round 1',
              tests: [{ name: 'unit tests', pass: true }],
              build: 'v2',
              files: [{ path: 'src/game.ts', change: 'edit', binary: false }],
              meta: {
                durationMs: 900,
                agents: ['forge'],
                derivedUnavailable: true,
                unattributedCount: 1,
              },
            },
          }),
        },
        ts: 2,
      }]),
    ]);

    assert.deepEqual(result.roundsById.u1?.deliver, {
      outcome: 'Delivered',
      roundLabel: 'Round 1',
      files: [{ path: 'src/game.ts', change: 'edit' }],
      tests: [{ name: 'unit tests', ok: true }],
      next: undefined,
      build: { version: 'v2' },
      agents: ['forge'],
      durationMs: 900,
      costUsd: undefined,
      derivedUnavailable: true,
      unattributedCount: 1,
    });
  });

  it('closes a completed plan without requiring a deliver tool', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Finish', ts: 1 }]),
      message('a1', 'assistant', [{ kind: 'tool', tool: todo('completed'), ts: 2 }]),
    ]);
    assert.equal(result.roundsById.u1?.phase, 'closed');
    assert.equal(result.roundsById.u1?.deliver, null);
  });

  it('ignores an empty todo replacement without losing the active task', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Inspect', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todo('in_progress'), ts: 2 },
        { kind: 'tool', tool: todoWrite('empty', []), ts: 3 },
        { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 4 },
      ]),
    ]);
    assert.equal(result.roundsById.u1?.plan[0]?.status, 'in_progress');
    assert.equal(result.roundsById.u1?.plan[0]?.steps[0]?.id, 'read-1');
  });

  it('puts tools in unplannedSteps when no todo is active', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Inspect', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todoWrite('plan', [
          { id: 'a', content: 'Wait for input', status: 'pending' },
          { id: 'b', content: 'Already done', status: 'completed' },
        ]), ts: 2 },
        { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 3 },
      ]),
    ]);
    assert.deepEqual(result.roundsById.u1?.unplannedSteps.map((step) => step.id), ['read-1']);
    assert.equal(result.roundsById.u1?.plan[0]?.steps.length, 0);
  });

  it('routes interleaved tools to the task active at each event', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todoWrite('plan-1', [
          { id: 'a', content: 'Inspect', status: 'in_progress' },
          { id: 'b', content: 'Implement', status: 'pending' },
        ]), ts: 2 },
        { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 3 },
        { kind: 'tool', tool: todoWrite('plan-2', [
          { id: 'a', content: 'Inspect', status: 'completed' },
          { id: 'b', content: 'Implement', status: 'in_progress' },
        ]), ts: 4 },
        { kind: 'tool', tool: tool('write_file', 'write-1', { file_path: 'src/a.ts' }), ts: 5 },
      ]),
    ]);
    const round = result.roundsById.u1!;
    assert.deepEqual(round.plan.map((task) => task.steps.map((step) => step.id)), [['read-1'], ['write-1']]);
  });

  it('archives dropped tasks without losing their completed steps', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todoWrite('plan-1', [{ id: 'a', content: 'Inspect', status: 'in_progress' }]), ts: 2 },
        { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 3 },
        { kind: 'tool', tool: todoWrite('plan-2', [{ id: 'b', content: 'Implement', status: 'in_progress' }]), ts: 4 },
      ]),
    ]);
    const archived = result.roundsById.u1?.archivedTasks[0];
    assert.equal(archived?.id, 'id:a');
    assert.equal(archived?.steps[0]?.id, 'read-1');
  });

  it('freezes an unfinished round when the next user message arrives', () => {
    const running = tool('read_file', 'read-1', { file_path: 'src/a.ts' });
    running.status = 'running';
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Start', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todo('in_progress'), ts: 2 },
        { kind: 'tool', tool: running, ts: 3 },
      ], 'streaming'),
      message('u2', 'user', [{ kind: 'text', text: 'Stop and answer this', ts: 4 }]),
    ]);
    assert.equal(result.roundsById.u1?.phase, 'interrupted');
    assert.equal(result.roundsById.u1?.plan[0]?.steps[0]?.status, 'frozen');
  });

  it('marks an aborted assistant turn as interrupted', () => {
    const running = tool('read_file', 'read-1', { file_path: 'src/a.ts' });
    running.status = 'running';
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Start', ts: 1 }]),
      message('a1', 'assistant', [
        { kind: 'tool', tool: todo('in_progress'), ts: 2 },
        { kind: 'tool', tool: running, ts: 3 },
      ], 'error'),
    ]);
    assert.equal(result.roundsById.u1?.phase, 'interrupted');
    assert.equal(result.roundsById.u1?.plan[0]?.steps[0]?.status, 'frozen');
  });

  it('carries the producing agent onto the task and round metadata', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: todo('in_progress'), ts: 2 },
    ]);
    // The kernel that streamed the turn must not be mistaken for a persona.
    assistant.providerId = 'claude-code';
    assistant.subAgents = { suzu: { emitterId: 'suzu', text: '', toolCalls: [], startedAt: 2, status: 'done' } };
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Delegate', ts: 1 }]),
      assistant,
    ], { ownerAgentId: 'iori' });
    assert.equal(result.roundsById.u1?.plan[0]?.agentId, 'iori');
    assert.deepEqual(result.roundsById.u1?.agentIds, ['iori', 'suzu']);
  });

  it('spans the round from the user ask to the last segment', () => {
    const ask = message('u1', 'user', [{ kind: 'text', text: 'Build', ts: 1_000 }]);
    ask.ts = 1_000;
    const turn = message('a1', 'assistant', [
      { kind: 'tool', tool: todo('in_progress'), ts: 2_000 },
      { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 9_000 },
    ]);
    turn.ts = 2_000;
    const result = projectTimeline([ask, turn]);
    assert.equal(result.roundsById.u1?.durationMs, 8_000);
  });

  it('projects the complete history before a caller applies pagination', () => {
    const result = projectTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'First', ts: 1 }]),
      message('a1', 'assistant', [{ kind: 'tool', tool: todo('completed'), ts: 2 }]),
      message('u2', 'user', [{ kind: 'text', text: 'Second', ts: 3 }]),
      message('a2', 'assistant', [{ kind: 'text', text: 'Answer', ts: 4 }]),
    ]);
    assert.ok(result.roundsById.u1);
    assert.deepEqual(result.timeline.map((item) => item.kind === 'round' ? item.roundId : item.messageId), [
      'u1', 'u1', 'u2', 'a2',
    ]);
  });
});

describe('projectWorkTimeline', () => {
  const artifact = (id = 'artifact-1'): ArtifactSummary => ({
    id,
    sid: 'sid-1',
    turnId: 'turn-1',
    files: [{ path: 'src/game.ts', change: 'edit', insertions: 2, deletions: 1 }],
    status: 'complete',
    agents: ['forge'],
    durationMs: 1_200,
  });

  it('keeps an error-only assistant message visible so its retry detail is not dropped', () => {
    const failed = message('a1', 'assistant', [], 'error');
    (failed as TaskFlowMessage & { errorMessage?: string }).errorMessage = 'history resync failed';
    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Continue', ts: 1 }]),
      failed,
    ]);
    expect(result.timeline).toContainEqual({ kind: 'message', messageId: 'a1', segmentIndexes: [] });
    expect(Object.keys(result.processesById)).toHaveLength(0);
  });

  it('keeps an empty streaming assistant visible before the first response byte', () => {
    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Build it', ts: 1 }]),
      message('a1', 'assistant', [], 'streaming'),
    ]);

    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'message', messageId: 'a1', segmentIndexes: [] },
    ]);
  });

  it('keeps private reasoning out while preserving ordinary work in Worked-for without todo', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'thinking', text: 'private chain of thought', ts: 2 },
      { kind: 'text', text: 'I am inspecting the project.', ts: 3 },
      { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/game.ts' }), ts: 4 },
      { kind: 'text', text: 'The file is ready.', ts: 5 },
    ]);
    assistant.turnId = 'turn-1';
    assistant.durationMs = 3_000;

    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Inspect it', ts: 1 }]),
      assistant,
    ]);
    assert.deepEqual(result.processesById['turn-1']?.entries.map((entry) => entry.kind), ['assistant_intermediate', 'tool']);
    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'process', processId: 'turn-1' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [3] },
    ]);
  });

  it('renders todo inside the process and an artifact independently', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: todo('in_progress'), ts: 2 },
      { kind: 'tool', tool: tool('write_file', 'write-1', { file_path: 'src/game.ts' }), ts: 3 },
      { kind: 'tool', tool: deliver('deliver-1'), ts: 4 },
      { kind: 'text', text: 'Implemented.', ts: 5 },
    ]);
    assistant.turnId = 'turn-1';
    assistant.artifact = artifact();

    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Implement it', ts: 1 }]),
      assistant,
    ]);
    const process = result.processesById['turn-1'];

    assert.ok(process);
    assert.equal(process.todo?.items[0]?.content, 'Ship feature');
    assert.deepEqual(process.entries.map((entry) => entry.kind), ['todo_snapshot', 'tool']);
    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'process', processId: 'turn-1' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [3] },
      { kind: 'artifact', artifactId: 'artifact-1' },
    ]);
    assert.equal(result.artifactsById['artifact-1']?.files[0]?.path, 'src/game.ts');
  });

  it('keeps public thinking, model narration, todo, and tools in event order', () => {
    const assistant = message('a-order', 'assistant', [
      { kind: 'thinking', text: 'I am checking the constraints.', visibility: 'public_summary', ts: 2 },
      { kind: 'text', text: 'I will break this into two steps.', ts: 3 },
      { kind: 'tool', tool: todo('in_progress'), ts: 4 },
      { kind: 'tool', tool: tool('write_file', 'write-order', { file_path: 'src/order.ts' }), ts: 5 },
      { kind: 'text', text: 'Finished in the requested order.', ts: 6 },
    ]);
    assistant.turnId = 'turn-order';

    const result = projectWorkTimeline([
      message('u-order', 'user', [{ kind: 'text', text: 'Do it', ts: 1 }]),
      assistant,
    ]);
    expect(result.processesById['turn-order']?.entries.map((entry) => entry.kind)).toEqual([
      'thinking_summary',
      'assistant_intermediate',
      'todo_snapshot',
      'tool',
    ]);
    expect(result.timeline).toEqual([
      { kind: 'message', messageId: 'u-order', segmentIndexes: [0] },
      { kind: 'process', processId: 'turn-order' },
      { kind: 'message', messageId: 'a-order', segmentIndexes: [4] },
    ]);
  });

  it('anchors one todo card at its first event while applying the latest snapshot', () => {
    const assistant = message('a-todo-updates', 'assistant', [
      { kind: 'text', text: 'Planning now.', ts: 2 },
      { kind: 'tool', tool: todoWrite('todo-first', [{ id: 'a', content: 'Ship feature', status: 'in_progress' }]), ts: 3 },
      { kind: 'tool', tool: tool('read_file', 'read-between', { file_path: 'src/game.ts' }), ts: 4 },
      { kind: 'tool', tool: todoWrite('todo-latest', [{ id: 'a', content: 'Ship feature', status: 'completed' }]), ts: 5 },
      { kind: 'text', text: 'Done.', ts: 6 },
    ]);
    assistant.turnId = 'turn-todo-updates';

    const result = projectWorkTimeline([assistant]);
    const process = result.processesById['turn-todo-updates'];
    expect(process?.entries.map((entry) => entry.kind)).toEqual([
      'assistant_intermediate',
      'todo_snapshot',
      'tool',
      'todo_snapshot',
    ]);
    expect(process?.entries.find((entry) => entry.kind === 'todo_snapshot')?.ts).toBe(3);
    expect(process?.todo?.items[0]?.status).toBe('completed');
  });

  it('projects flat CLI tool snapshots when stream segments only contain text', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'text', text: 'I am starting the task.', ts: 2 },
    ]);
    assistant.toolCalls = [todoWrite('todo-flat', [
      { id: 'collect', content: 'Collect the selected lanes', status: 'completed' },
      { id: 'write', content: 'Write the marker file', status: 'in_progress' },
    ])];
    assistant.turnId = 'turn-flat';

    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Run it', ts: 1 }]),
      assistant,
    ]);

    const process = result.processesById['turn-flat'];
    assert.ok(process);
    assert.deepEqual(process.todo?.items.map((item) => item.content), [
      'Collect the selected lanes',
      'Write the marker file',
    ]);
  });

  it('does not create an artifact card from deliver_summary alone', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: deliver('deliver-1'), ts: 2 },
      { kind: 'text', text: 'No files changed.', ts: 3 },
    ]);
    assistant.turnId = 'turn-1';
    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Tell me what happened', ts: 1 }]),
      assistant,
    ]);

    assert.equal(result.timeline.some((item) => item.kind === 'artifact'), false);
    assert.equal(Object.keys(result.artifactsById).length, 0);
  });

  it('adapts an old enriched delivery row when the WAL has no turn identity', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: {
        ...deliver('legacy-delivery', 'Legacy delivered'),
        resultData: {
          ok: true,
          summary: {
            outcome: 'Legacy delivered',
            files: [{ path: 'src/legacy.ts', change: 'edit', insertions: 3, deletions: 1 }],
            meta: { agents: ['forge'], durationMs: 700 },
          },
        },
      }, ts: 2 },
    ]);
    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Replay it', ts: 1 }]),
      assistant,
    ]);

    const artifacts = Object.values(result.artifactsById);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.files[0]?.path, 'src/legacy.ts');
    assert.equal(artifacts[0]?.semantic?.outcome, 'Legacy delivered');
    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'artifact', artifactId: artifacts[0]!.id },
    ]);
  });

  it('creates an artifact card even when no todo was used', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: tool('write_file', 'write-1', { file_path: 'src/game.ts' }), ts: 2 },
    ]);
    assistant.turnId = 'turn-1';
    assistant.artifact = artifact('artifact-2');
    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Make this small edit', ts: 1 }]),
      assistant,
    ]);

    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'process', processId: 'turn-1' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [] },
      { kind: 'artifact', artifactId: 'artifact-2' },
    ]);
    assert.deepEqual(result.processesById['turn-1']?.entries.map((entry) => entry.kind), ['tool']);
  });

  it('keeps pending Ask User at its execution position after preceding work', () => {
    const pendingAsk = {
      ...tool('ask_user', 'ask-1', {
        question: 'Choose a direction',
        options: [{ label: 'A' }, { label: 'B' }],
      }),
      status: 'running' as const,
    };
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/game.ts' }), ts: 2 },
      { kind: 'tool', tool: pendingAsk, ts: 3 },
    ]);
    assistant.turnId = 'turn-ask';
    assistant.durationMs = 4_000;

    const result = projectWorkTimeline([assistant]);
    assert.deepEqual(result.processesById['turn-ask']?.entries.map((entry) => entry.kind), ['tool', 'tool']);
    assert.deepEqual(result.timeline, [
      { kind: 'process', processId: 'turn-ask' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [] },
    ]);
  });

  it('keeps answered Ask User at the same execution position', () => {
    const answeredAsk = {
      ...tool('ask_user', 'ask-1', {
        question: 'Choose a direction',
        options: [{ label: 'A' }, { label: 'B' }],
      }),
      resultData: { ok: true, questions: [{ questionId: 'question-1', values: ['B'] }] },
    };
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/game.ts' }), ts: 2 },
      { kind: 'tool', tool: answeredAsk, ts: 3 },
    ]);
    assistant.turnId = 'turn-ask-done';
    assistant.durationMs = 4_000;

    const result = projectWorkTimeline([assistant]);
    assert.deepEqual(result.processesById['turn-ask-done']?.entries.map((entry) => entry.kind), ['tool', 'tool']);
    assert.deepEqual(result.timeline, [
      { kind: 'process', processId: 'turn-ask-done' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [] },
    ]);
  });

  it('keeps Ask User inside the process when the same turn uses todo_write', () => {
    const pendingAsk = {
      ...tool('ask_user', 'ask-in-todo', {
        question: 'Choose implementation',
        options: [{ label: 'A' }, { label: 'B' }],
      }),
      status: 'running' as const,
    };
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: todo('in_progress'), ts: 2 },
      { kind: 'tool', tool: pendingAsk, ts: 3 },
    ]);
    assistant.turnId = 'turn-todo-ask';

    const result = projectWorkTimeline([assistant]);
    const process = result.processesById['turn-todo-ask'];
    assert.equal(process?.phase, 'waiting_for_input');
    assert.deepEqual(process?.entries.map((entry) => entry.kind), ['todo_snapshot', 'tool']);
    assert.deepEqual(result.timeline, [
      { kind: 'process', processId: 'turn-todo-ask' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [] },
    ]);
  });

  it('keeps question introduction and resumed work in chronological order', () => {
    const answeredAsk = {
      ...tool('ask_user', 'ask-before-work', {
        question: 'Choose a direction',
        options: [{ label: 'A' }, { label: 'B' }],
      }),
      resultData: { ok: true, questions: [{ questionId: 'question-1', values: ['A'] }] },
    };
    const assistant = message('a1', 'assistant', [
      { kind: 'text', text: 'I will ask before starting.', ts: 1 },
      { kind: 'tool', tool: answeredAsk, ts: 2 },
      { kind: 'text', text: 'Answers received; starting work.', ts: 3 },
      { kind: 'tool', tool: todo('in_progress'), ts: 4 },
      { kind: 'text', text: 'Finished.', ts: 5 },
    ]);
    assistant.turnId = 'turn-ask-then-work';

    const result = projectWorkTimeline([assistant]);
    assert.deepEqual(result.processesById['turn-ask-then-work']?.entries.map((entry) => entry.kind), [
      'assistant_intermediate',
      'tool',
      'assistant_intermediate',
      'todo_snapshot',
    ]);
    assert.deepEqual(result.timeline, [
      { kind: 'process', processId: 'turn-ask-then-work' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [4] },
    ]);
  });

  it('classifies intermediate model output by event order without requiring todo_write', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'text', text: 'I will inspect the current implementation.', ts: 1 },
      { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/game.ts' }), ts: 2 },
      { kind: 'text', text: 'The implementation is aligned now.', ts: 3 },
    ]);
    assistant.turnId = 'turn-no-todo-narration';

    const result = projectWorkTimeline([assistant]);

    assert.deepEqual(result.processesById['turn-no-todo-narration']?.entries.map((entry) => entry.kind), [
      'assistant_intermediate',
      'tool',
    ]);
    assert.deepEqual(result.timeline, [
      { kind: 'process', processId: 'turn-no-todo-narration' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [2] },
    ]);
  });

  it('keeps an interrupted Worked-for trace for an aborted turn without todo_write', () => {
    const assistant = message('a1', 'assistant', [
      { kind: 'tool', tool: tool('write_file', 'write-aborted', { file_path: 'src/game.ts' }), ts: 2 },
    ], 'error');
    assistant.turnId = 'turn-aborted';
    assistant.turnAborted = true;
    assistant.durationMs = 1_500;

    const result = projectWorkTimeline([assistant]);

    assert.equal(result.processesById['turn-aborted']?.phase, 'aborted');
    assert.deepEqual(result.timeline, [
      { kind: 'process', processId: 'turn-aborted' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [] },
    ]);
  });

  it('does not project a CLI permission ask as a second native Ask card', () => {
    const assistant = message('a-cli-ask', 'assistant', [
      {
        kind: 'tool',
        tool: {
          ...tool('ask_user', 'cli-ask-1', { questions: [{ question: 'Pick one' }] }),
          permissionPrompt: true,
          result: 'Your questions have been answered: "Pick one"="Design".',
        },
        ts: 2,
      },
      { kind: 'text', text: 'Done.', ts: 3 },
    ]);
    assistant.turnId = 'turn-cli-ask';

    const result = projectWorkTimeline([assistant]);
    expect(result.timeline).toEqual([
      { kind: 'message', messageId: 'a-cli-ask', segmentIndexes: [1] },
    ]);
    expect(result.processesById['turn-cli-ask']).toBeUndefined();
  });

  it('keeps one Worked-for trace across multiple assistant messages without todo_write', () => {
    const first = message('a1', 'assistant', [
      { kind: 'text', text: 'Inspecting the project.', ts: 2 },
      { kind: 'tool', tool: tool('read_file', 'read-1', { file_path: 'src/a.ts' }), ts: 3 },
      { kind: 'text', text: 'The first read is complete.', ts: 4 },
    ], 'streaming');
    first.turnId = 'turn-merge';
    first.subAgents = {
      suzu: { emitterId: 'suzu', text: '', toolCalls: [], startedAt: 2, status: 'streaming' },
    };
    const second = message('a2', 'assistant', [
      { kind: 'tool', tool: { ...tool('read_file', 'read-1', { file_path: 'src/a.ts' }), status: 'done' }, ts: 5 },
      { kind: 'text', text: 'Finished.', ts: 6 },
    ]);
    second.turnId = 'turn-merge';

    const result = projectWorkTimeline([
      message('u1', 'user', [{ kind: 'text', text: 'Inspect it', ts: 1 }]),
      first,
      second,
    ]);
    assert.deepEqual(result.processesById['turn-merge']?.entries.map((entry) => entry.kind), [
      'assistant_intermediate',
      'subagent',
      'assistant_intermediate',
      'tool',
    ]);
    assert.deepEqual(result.timeline, [
      { kind: 'message', messageId: 'u1', segmentIndexes: [0] },
      { kind: 'process', processId: 'turn-merge' },
      { kind: 'message', messageId: 'a1', segmentIndexes: [] },
      { kind: 'message', messageId: 'a2', segmentIndexes: [1] },
    ]);
  });

  it('keeps the process anchor and earlier entries stable when todo_write arrives later', () => {
    const beforeTodo = message('a-stable', 'assistant', [
      { kind: 'text', text: 'I am inspecting the project.', ts: 2 },
    ], 'streaming');
    beforeTodo.turnId = 'turn-stable';

    const before = projectWorkTimeline([beforeTodo]);
    expect(before.timeline[0]).toEqual({ kind: 'process', processId: 'turn-stable' });
    expect(before.processesById['turn-stable']?.entries.map((entry) => entry.kind)).toEqual([
      'assistant_intermediate',
    ]);

    const afterTodo = message('a-stable', 'assistant', [
      { kind: 'text', text: 'I am inspecting the project.', ts: 2 },
      { kind: 'tool', tool: todo('in_progress'), ts: 3 },
    ], 'streaming');
    afterTodo.turnId = 'turn-stable';

    const after = projectWorkTimeline([afterTodo]);
    expect(after.timeline[0]).toEqual({ kind: 'process', processId: 'turn-stable' });
    expect(after.processesById['turn-stable']?.entries.map((entry) => entry.kind)).toEqual([
      'assistant_intermediate',
      'todo_snapshot',
    ]);
  });

  it('emits one artifact item when replay attaches the same artifact more than once', () => {
    const first = message('a1', 'assistant', [
      { kind: 'tool', tool: tool('write_file', 'write-1', { file_path: 'src/a.ts' }), ts: 2 },
    ]);
    first.turnId = 'turn-artifact';
    first.artifact = artifact('artifact-replayed');
    const second = message('a2', 'assistant', [
      { kind: 'text', text: 'Done.', ts: 3 },
    ]);
    second.turnId = 'turn-artifact';
    second.artifact = artifact('artifact-replayed');

    const result = projectWorkTimeline([first, second]);
    assert.deepEqual(result.timeline.filter((item) => item.kind === 'artifact'), [
      { kind: 'artifact', artifactId: 'artifact-replayed' },
    ]);
    assert.equal(result.artifactMessageIds['artifact-replayed'], 'a1');
  });
});
