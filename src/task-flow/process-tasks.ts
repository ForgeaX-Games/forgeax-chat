import type { ProcessEntry, ProcessTrace, Step, Task } from './model';

export interface TodoProcessWindow {
  before: ProcessEntry[];
  during: ProcessEntry[];
  after: ProcessEntry[];
}

/** Todo owns only its explicit lifecycle. Public process emitted before the
 * first snapshot or after the first all-settled snapshot remains ordinary
 * process content outside the Todo container. */
export function splitTodoProcessWindow(process: ProcessTrace): TodoProcessWindow {
  const firstTodo = process.entries.findIndex((entry) => entry.kind === 'todo_snapshot');
  if (firstTodo < 0) return { before: process.entries, during: [], after: [] };
  let settledTodo = -1;
  for (let index = firstTodo; index < process.entries.length; index++) {
    const entry = process.entries[index]!;
    if (entry.kind !== 'todo_snapshot' || !entry.items.length) continue;
    if (entry.items.every((item) => item.status === 'completed' || item.status === 'cancelled')) {
      settledTodo = index;
      break;
    }
  }
  const end = settledTodo >= 0 ? settledTodo : process.entries.length - 1;
  return {
    before: process.entries.slice(0, firstTodo),
    during: process.entries.slice(firstTodo, end + 1),
    after: process.entries.slice(end + 1),
  };
}

/** Replay todo snapshots and process events to recover the task that owned each
 * step at that moment. The latest todo snapshot supplies display status while
 * event order supplies attribution; neither the renderer nor tool names invent
 * task ownership. */
export function tasksFromProcess(process: ProcessTrace): Task[] {
  const latestItems = process.todo?.items ?? [];
  const tasks = latestItems.map((item, index): Task => ({
    id: item.id ? `id:${item.id}` : `content:${item.content.trim() || index}`,
    content: item.content,
    activeForm: item.activeForm,
    status: item.status,
    steps: [],
    agentId: item.agentId,
  }));
  const byIdentity = new Map<string, Task>();
  for (const [index, task] of tasks.entries()) {
    const item = latestItems[index]!;
    if (item.id) byIdentity.set(`id:${item.id}`, task);
    byIdentity.set(`content:${item.content.trim()}`, task);
  }

  const todoEntries = splitTodoProcessWindow(process).during;
  const ownerByEntry = new Map<string, Task>();
  let active: Task | undefined;
  let lastActive: Task | undefined;
  const nextActiveByIndex = new Map<number, Task>();
  let nextActive: Task | undefined;
  for (let index = todoEntries.length - 1; index >= 0; index--) {
    const entry = todoEntries[index]!;
    if (entry.kind === 'todo_snapshot') {
      const activeItem = entry.items.find((item) => item.status === 'in_progress');
      nextActive = activeItem
        ? byIdentity.get(activeItem.id ? `id:${activeItem.id}` : `content:${activeItem.content.trim()}`)
        : nextActive;
    } else if (nextActive) {
      nextActiveByIndex.set(index, nextActive);
    }
  }
  for (let index = 0; index < todoEntries.length; index++) {
    const entry = todoEntries[index]!;
    if (entry.kind === 'todo_snapshot') {
      const activeItem = entry.items.find((item) => item.status === 'in_progress');
      active = activeItem
        ? byIdentity.get(activeItem.id ? `id:${activeItem.id}` : `content:${activeItem.content.trim()}`)
        : undefined;
      if (active) lastActive = active;
      continue;
    }
    const owner = active ?? nextActiveByIndex.get(index) ?? lastActive ?? tasks[0];
    if (owner) ownerByEntry.set(entry.id, owner);
  }

  let pendingOwner: Task | undefined;
  let pendingThinking: string[] = [];
  let pendingNarration: string[] = [];
  const detailStatus = (owner: Task): Step['status'] =>
    owner.status === 'in_progress' && (process.phase === 'running' || process.phase === 'waiting_for_input')
      ? 'running'
      : 'done';
  const flushDetail = () => {
    if (!pendingOwner || (!pendingThinking.length && !pendingNarration.length)) return;
    pendingOwner.steps.push({
      id: `detail:${process.id}:${pendingOwner.id}:${pendingOwner.steps.length}`,
      name: pendingThinking.length ? 'Thinking' : 'Progress',
      status: detailStatus(pendingOwner),
      thinking: pendingThinking.length ? pendingThinking : undefined,
      narration: pendingNarration.length ? pendingNarration : undefined,
    });
    pendingThinking = [];
    pendingNarration = [];
  };
  for (const entry of todoEntries) {
    if (entry.kind === 'todo_snapshot') continue;
    const owner = ownerByEntry.get(entry.id);
    if (!owner) continue;
    if (pendingOwner && pendingOwner !== owner) flushDetail();
    pendingOwner = owner;
    if (entry.kind === 'thinking_summary') {
      pendingThinking.push(entry.text);
      continue;
    }
    if (entry.kind === 'assistant_intermediate') {
      pendingNarration.push(entry.text);
      continue;
    }
    if (entry.kind === 'tool') {
      owner.steps.push({
        ...entry.step,
        thinking: entry.step.thinking ?? (pendingThinking.length ? pendingThinking : undefined),
        narration: entry.step.narration ?? (pendingNarration.length ? pendingNarration : undefined),
      });
      pendingThinking = [];
      pendingNarration = [];
      continue;
    }
    if (entry.kind === 'subagent') {
      owner.steps.push({
        id: entry.id,
        name: `Delegate ${entry.agentId}`,
        status: detailStatus(owner),
        thinking: pendingThinking.length ? pendingThinking : undefined,
        narration: pendingNarration.length ? pendingNarration : undefined,
      });
      pendingThinking = [];
      pendingNarration = [];
    }
  }
  flushDetail();
  return tasks;
}
