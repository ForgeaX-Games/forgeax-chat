import type { ChatSegment, ToolCall } from '../session-store';
import type {
  ArtifactSummary,
  DeliverSummary,
  ProjectionResult,
  Round,
  ProcessEntry,
  ProcessTrace,
  WorkProjectionResult,
  WorkTimelineItem,
  WorkTurn,
  Step,
  Task,
  TaskFlowMessage,
  TaskFlowSegment,
  TaskFlowToolCall,
  TodoItem,
  TimelineItem,
} from './model';
import { readDeliver } from './deliver';
import { buildStep } from './steps';
import { isPendingAskUser } from './ask-user-protocol';
import { normalizeToolCall } from '../event-engine/tool-name';

export { askUserHasAnswer } from './ask-user-protocol';

type TodoArgs = { todos?: unknown[] };

interface Candidate {
  round: Round | null;
  userMessageId: string;
  userMsgId?: string;
  activeTaskKey: string | null;
  pendingThinking: string[];
  pendingNarration: string[];
  firstTs: number;
  lastTs: number;
}

function asToolCall(tool: ToolCall): TaskFlowToolCall {
  const normalized = normalizeToolCall(tool.name, tool.args);
  return { ...tool, name: normalized.name, args: normalized.args } as TaskFlowToolCall;
}

function segmentsOf(message: TaskFlowMessage): TaskFlowSegment[] {
  const flatTools = new Map(message.toolCalls.map((tool) => [tool.callId, asToolCall(tool)]));
  const result: TaskFlowSegment[] = message.segments?.length
    ? (message.segments as TaskFlowSegment[]).map((segment) => {
      if (segment.kind !== 'tool') return segment;
      // The CLI SSE path updates the flat toolCalls snapshot on a final
      // result, while its text/stream segments can still contain the initial
      // partial args. Prefer that final snapshot so task-flow projection can
      // recover todo_write and other structured tool arguments.
      const latest = flatTools.get(segment.tool.callId);
      return latest ? { ...segment, tool: latest } : segment;
    })
    : [];
  if (!result.length && message.text) result.push({ kind: 'text', text: message.text, ts: message.ts });
  const seenToolIds = new Set(
    result.flatMap((segment) => segment.kind === 'tool' ? [segment.tool.callId] : []),
  );
  for (const tool of message.toolCalls) {
    if (seenToolIds.has(tool.callId)) continue;
    result.push({ kind: 'tool', tool: flatTools.get(tool.callId) ?? asToolCall(tool), ts: message.ts });
  }
  return result;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function latestToolCalls(message: TaskFlowMessage): TaskFlowToolCall[] {
  const latest = new Map<string, TaskFlowToolCall>();
  for (const segment of segmentsOf(message)) {
    if (segment.kind === 'tool') latest.set(segment.tool.callId, asToolCall(segment.tool));
  }
  // The flat toolCalls field is the final lifecycle snapshot on some replay
  // paths, while segments can still contain the earlier running snapshot.
  for (const tool of message.toolCalls) latest.set(tool.callId, asToolCall(tool));
  return [...latest.values()];
}

function hasPendingAskUser(message: TaskFlowMessage): boolean {
  return latestToolCalls(message).some((tool) => isPendingAskUser(tool));
}

/**
 * Tool args as an object. A streaming kernel delivers args as a partial JSON
 * *string* that only becomes valid once the tool call closes, so parse strings
 * too: while the JSON is still truncated this fails and the caller keeps its
 * existing fallback, but the moment it is complete the plan projects normally
 * instead of lingering as a flat tool chip.
 */
function argsObjectOf(value: unknown): Record<string, unknown> | null {
  const direct = objectOf(value);
  if (direct) return direct;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return objectOf(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function todoItems(tool: TaskFlowToolCall): TodoItem[] | null {
  const args = argsObjectOf(tool.args) as TodoArgs | null;
  if (!args || !Array.isArray(args.todos)) return null;
  return args.todos.flatMap((raw): TodoItem[] => {
    const item = objectOf(raw);
    if (!item || typeof item.content !== 'string') return [];
    const status = item.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed' && status !== 'cancelled') {
      return [];
    }
    return [{
      id: typeof item.id === 'string' ? item.id : undefined,
      content: item.content,
      status,
      activeForm: typeof item.activeForm === 'string' ? item.activeForm : undefined,
      agentId: typeof item.agentId === 'string' ? item.agentId : undefined,
    }];
  });
}

function taskKey(item: TodoItem, index: number, duplicate: number): string {
  if (item.id) return `id:${item.id}`;
  const content = item.content.trim();
  return content ? `content:${content}${duplicate ? `#${duplicate}` : ''}` : `index:${index}`;
}

function makeTask(item: TodoItem, key: string, fallbackAgentId?: string): Task {
  return {
    id: key,
    content: item.content,
    activeForm: item.activeForm,
    status: item.status,
    steps: [],
    agentId: item.agentId ?? fallbackAgentId,
  };
}

/**
 * Agents credited with a round.
 *
 * `providerId` names the CLI kernel that streamed the turn, not a persona, so
 * it must never reach the avatar stack. The turn's own agent is the session
 * owner; delegated work shows up as sub-agent runs keyed by emitter id.
 */
function messageAgents(message: TaskFlowMessage, ownerAgentId?: string): string[] {
  const ids = ownerAgentId ? [ownerAgentId] : [];
  for (const emitterId of Object.keys(message.subAgents ?? {})) {
    if (!ids.includes(emitterId)) ids.push(emitterId);
  }
  return ids;
}

function creditAgents(round: Round, agentIds: string[]): void {
  for (const agentId of agentIds) {
    if (!round.agentIds.includes(agentId)) round.agentIds.push(agentId);
  }
}

function materialize(
  candidate: Candidate,
  message: TaskFlowMessage,
  index: number,
  agentIds: string[],
): Round {
  if (candidate.round) return candidate.round;
  const round: Round = {
    id: candidate.userMessageId,
    checkpointMsgId: candidate.userMsgId,
    index: 0,
    phase: 'planning',
    plan: [],
    archivedTasks: [],
    unplannedSteps: [],
    deliver: null,
    stepCount: 0,
    durationMs: 0,
    agentIds: [...agentIds],
    firstMessageId: message.id,
  };
  candidate.round = round;
  candidate.lastTs = message.ts;
  // The index is assigned by the caller after all non-task messages are known.
  void index;
  return round;
}

function findTask(round: Round, key: string | null): Task | undefined {
  return key ? round.plan.find((task) => task.id === key) : undefined;
}

function updatePlan(round: Round, items: TodoItem[], fallbackAgentId?: string): void {
  const counts = new Map<string, number>();
  const next = items.map((item, index) => {
    const base = item.id ? `id:${item.id}` : `content:${item.content.trim()}`;
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    const key = taskKey(item, index, duplicate);
    const previous = round.plan.find((task) => task.id === key);
    return previous
      ? {
        ...previous,
        content: item.content,
        activeForm: item.activeForm,
        status: item.status,
        demotedFromActive: false,
        agentId: item.agentId ?? previous.agentId ?? fallbackAgentId,
      }
      : makeTask(item, key, fallbackAgentId);
  });
  const retained = new Set(next.map((task) => task.id));
  for (const task of round.plan) {
    if (!retained.has(task.id) && task.steps.length) round.archivedTasks.push(task);
  }
  const active = next.findIndex((task) => task.status === 'in_progress');
  round.plan = next.map((task, index) => ({
    ...task,
    demotedFromActive: active >= 0 && task.status === 'in_progress' && index !== active,
  }));
}

function activeTask(round: Round): Task | undefined {
  return round.plan.find((task) => task.status === 'in_progress' && !task.demotedFromActive);
}

function finishPendingDetail(candidate: Candidate, task: Task): void {
  if (!candidate.pendingThinking.length && !candidate.pendingNarration.length) return;
  const step: Step = {
    id: `thinking-${task.steps.length}`,
    name: 'Thinking',
    status: 'done',
    thinking: candidate.pendingThinking.splice(0),
    narration: candidate.pendingNarration.splice(0),
  };
  task.steps.push(step);
}

function addToolStep(candidate: Candidate, round: Round, tool: TaskFlowToolCall): void {
  const task = activeTask(round);
  const bucket = task ? task.steps : round.unplannedSteps;
  // Dedupe by tool callId. A streaming kernel can surface the same tool call more
  // than once (tool_call → tool_use, delta rebuilds); each step's id IS its callId
  // and is used as a React key, so a duplicate would collide and spin React into
  // "Maximum update depth". Update the existing step in place so its final
  // status/result wins instead of appending a second same-keyed row.
  const existingIndex = bucket.findIndex((step) => step.id === tool.callId);
  const step = buildStep(tool, candidate.pendingThinking.splice(0), candidate.pendingNarration.splice(0));
  if (existingIndex >= 0) {
    // Preserve any thinking/narration already attached to the earlier instance.
    const prev = bucket[existingIndex]!;
    bucket[existingIndex] = {
      ...step,
      thinking: step.thinking ?? prev.thinking,
      narration: step.narration ?? prev.narration,
    };
  } else {
    bucket.push(step);
  }
  candidate.activeTaskKey = task?.id ?? null;
}

function updateRoundStats(round: Round, candidate: Candidate, lastTs: number): void {
  candidate.lastTs = Math.max(candidate.lastTs, lastTs);
  round.stepCount = [...round.plan, ...round.archivedTasks]
    .reduce((count, task) => count + task.steps.length, 0)
    + round.unplannedSteps.length;
  round.durationMs = Math.max(0, candidate.lastTs - candidate.firstTs);
}

function isComplete(round: Round): boolean {
  return round.plan.length > 0 && round.plan.every((task) => task.status === 'completed' || task.status === 'cancelled');
}

export function commitRound(round: Round, reason: 'delivered' | 'closed' | 'interrupted'): Round {
  if (reason === 'delivered') round.phase = 'delivered';
  else if (reason === 'closed' && round.phase !== 'delivered') round.phase = 'closed';
  else if (round.phase !== 'delivered') round.phase = 'interrupted';
  if (reason === 'interrupted') {
    for (const task of [...round.plan, ...round.archivedTasks]) {
      if (task.status === 'in_progress') task.status = 'pending';
      for (const step of task.steps) {
        if (step.status === 'running' || step.status === 'pending') step.status = 'frozen';
      }
    }
    for (const step of round.unplannedSteps) {
      if (step.status === 'running' || step.status === 'pending') step.status = 'frozen';
    }
  }
  return round;
}

function insertRound(timeline: TimelineItem[], round: Round): void {
  if (timeline.some((item) => item.kind === 'round' && item.roundId === round.id)) return;
  timeline.push({ kind: 'round', roundId: round.id });
}

/**
 * Projects complete messages before the UI applies its render window. A
 * message can therefore contribute ordinary segments and task-flow segments
 * at the same time.
 */
export function projectTimeline(
  messages: TaskFlowMessage[],
  options: { ownerAgentId?: string } = {},
): ProjectionResult {
  const { ownerAgentId } = options;
  const timeline: TimelineItem[] = [];
  const roundsById: Record<string, Round> = {};
  let candidate: Candidate | null = null;
  let roundIndex = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      if (candidate?.round && !['delivered', 'closed'].includes(candidate.round.phase)) {
        commitRound(candidate.round, 'interrupted');
      }
      candidate = {
        round: null,
        userMessageId: message.id,
        userMsgId: message.msgId,
        activeTaskKey: null,
        pendingThinking: [],
        pendingNarration: [],
        firstTs: message.ts,
        lastTs: message.ts,
      };
      timeline.push({ kind: 'message', messageId: message.id, segmentIndexes: [0] });
      continue;
    }

    const segments = segmentsOf(message);
    const remaining = new Set(segments.map((_, index) => index));
    const messageContainsPlan = message.role === 'assistant' && segments.some((segment) =>
      segment.kind === 'tool' && segment.tool.name === 'todo_write' && !!todoItems(asToolCall(segment.tool))?.length);
    // A sub-agent thread has no `user` message to seed a candidate (its work is
    // delegated, not user-typed). Seed one from the plan-bearing assistant message
    // itself so its todo_write still projects into a task-flow round instead of
    // falling back to a flat chip stream.
    if (message.role === 'assistant' && !candidate && messageContainsPlan) {
      candidate = {
        round: null,
        userMessageId: message.id,
        userMsgId: message.msgId,
        activeTaskKey: null,
        pendingThinking: [],
        pendingNarration: [],
        firstTs: message.ts,
        lastTs: message.ts,
      };
    }
    if (message.role !== 'assistant' || !candidate) {
      if (segments.length) timeline.push({ kind: 'message', messageId: message.id, segmentIndexes: [...remaining] });
      continue;
    }

    let roundCreated = false;
    let hadConsumed = false;
    const turnAgents = messageAgents(message, ownerAgentId);
    const containsPlan = messageContainsPlan;
    // Opening text emitted before the first todo_write in a plan-bearing message:
    // buffered here, then folded into the round's narration once it materializes,
    // so the pre-plan "let me plan this" line does not leak as a main-flow bubble.
    const preRoundNarration: string[] = [];
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      if (segment.kind === 'thinking') {
        if (candidate.round && activeTask(candidate.round)) {
          candidate.pendingThinking.push(segment.text);
          remaining.delete(index);
          hadConsumed = true;
        } else if (!candidate.round && containsPlan) {
          candidate.pendingThinking.push(segment.text);
          remaining.delete(index);
          hadConsumed = true;
        }
        continue;
      }
      if (segment.kind === 'text') {
        if (candidate.round && activeTask(candidate.round)) {
          candidate.pendingNarration.push(segment.text);
          remaining.delete(index);
          hadConsumed = true;
        } else if (candidate.round) {
          // In-round text with no active task (opening / closing narration) folds
          // into the round so it renders inside the process accordion, not as a
          // standalone main-flow bubble duplicating the delivery outcome.
          (candidate.round.narration ??= []).push(segment.text);
          remaining.delete(index);
          hadConsumed = true;
        } else if (containsPlan) {
          // Pre-plan opening text; will fold into the round when todo_write below
          // materializes it (guaranteed, since containsPlan requires valid items).
          preRoundNarration.push(segment.text);
          remaining.delete(index);
          hadConsumed = true;
        }
        continue;
      }

      const tool = asToolCall(segment.tool);
      if (tool.name === 'todo_write') {
        const items = todoItems(tool);
        if (!items?.length) continue;
        const round = materialize(candidate, message, index, turnAgents);
        if (!roundsById[round.id]) {
          round.index = ++roundIndex;
          roundsById[round.id] = round;
          insertRound(timeline, round);
          roundCreated = true;
        }
        creditAgents(round, turnAgents);
        updatePlan(round, items, ownerAgentId);
        if (preRoundNarration.length) (round.narration ??= []).push(...preRoundNarration.splice(0));
        candidate.activeTaskKey = activeTask(round)?.id ?? null;
        remaining.delete(index);
        hadConsumed = true;
        continue;
      }

      if (tool.name === 'deliver_summary') {
        const delivery = readDeliver(tool);
        if (!delivery) continue;
        const round = materialize(candidate, message, index, turnAgents);
        if (!roundsById[round.id]) {
          round.index = ++roundIndex;
          roundsById[round.id] = round;
          insertRound(timeline, round);
          roundCreated = true;
        }
        round.deliver = delivery;
        round.label = delivery.roundLabel ?? round.label;
        round.agentIds = delivery.agents?.length ? [...new Set(delivery.agents)] : round.agentIds;
        round.durationMs = delivery.durationMs ?? round.durationMs;
        commitRound(round, 'delivered');
        remaining.delete(index);
        hadConsumed = true;
        continue;
      }

      if (!candidate.round) continue;
      creditAgents(candidate.round, turnAgents);
      addToolStep(candidate, candidate.round, tool);
      remaining.delete(index);
      hadConsumed = true;
    }

    if (candidate.round) {
      const current = activeTask(candidate.round);
      if (message.status === 'done' && current && current.status !== 'completed') {
        finishPendingDetail(candidate, current);
      }
      updateRoundStats(candidate.round, candidate, Math.max(message.ts, segments.at(-1)?.ts ?? 0));
      if (message.status === 'error' && !candidate.round.deliver) {
        commitRound(candidate.round, 'interrupted');
      } else if (message.status === 'done' && !candidate.round.deliver && isComplete(candidate.round)) {
        commitRound(candidate.round, 'closed');
      } else if (candidate.round.phase === 'planning') {
        candidate.round.phase = 'executing';
      }
      roundsById[candidate.round.id] = candidate.round;
    }

    // A round is inserted before the first assistant message that contains
    // its task-flow segment; ordinary text in that same message stays after it.
    if (roundCreated && candidate.round && timeline.at(-1)?.kind !== 'round') {
      insertRound(timeline, candidate.round);
    }
    if (remaining.size || (!hadConsumed && segments.length)) {
      timeline.push({ kind: 'message', messageId: message.id, segmentIndexes: [...remaining] });
    }
  }

  for (const round of Object.values(roundsById)) {
    if (round.phase === 'delivered' || round.phase === 'closed' || round.phase === 'interrupted') continue;
    round.phase = 'executing';
  }
  return { timeline, roundsById };
}

function processPhase(message: TaskFlowMessage): ProcessTrace['phase'] {
  if (message.turnAborted) return 'aborted';
  if (message.status === 'streaming' && hasPendingAskUser(message)) return 'waiting_for_input';
  if (message.status === 'streaming') return 'running';
  if (message.status === 'error') return 'error';
  return 'done';
}

function processAgents(message: TaskFlowMessage, ownerAgentId?: string): string[] {
  const ids = ownerAgentId ? [ownerAgentId] : [];
  for (const id of Object.keys(message.subAgents ?? {})) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function artifactHasCard(artifact: ArtifactSummary): boolean {
  return artifact.status === 'unavailable' || artifact.files.length > 0;
}

/**
 * Old WAL rows carried a host-enriched deliver_summary result but predate the
 * artifact:resolved event. Keep those rows readable after the projection
 * migration, while never using the adapter for a current turn (current turns
 * have a turnId and must wait for the host-owned artifact field).
 */
function legacyArtifactFromDelivery(
  message: TaskFlowMessage,
  processId: string,
  delivery: DeliverSummary,
  sid?: string,
  ownerAgentId?: string,
): ArtifactSummary | null {
  if (message.turnId || delivery.files.length === 0 || delivery.derivedUnavailable) return null;
  const agents = delivery.agents?.length
    ? [...new Set(delivery.agents)]
    : ownerAgentId ? [ownerAgentId] : [];
  const semantic = {
    ...(delivery.outcome ? { outcome: delivery.outcome } : {}),
    ...(delivery.tests?.length ? { tests: delivery.tests.map((test) => ({ name: test.name, pass: test.ok, ...(test.detail ? { detail: test.detail } : {}) })) } : {}),
    ...(delivery.next?.length ? { next: delivery.next } : {}),
    ...(delivery.build?.version || delivery.build?.label ? { build: delivery.build.version ?? delivery.build.label } : {}),
  };
  return {
    id: `legacy-artifact:${message.sid ?? sid ?? 'session'}:${processId}`,
    sid: message.sid ?? sid ?? '',
    turnId: processId,
    files: delivery.files.map((file) => ({
      path: file.path,
      change: file.change,
      ...(file.insertions !== undefined ? { insertions: file.insertions } : {}),
      ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    })),
    status: delivery.status ?? 'complete',
    ...(delivery.unavailableReason ? { unavailableReason: delivery.unavailableReason } : {}),
    ...(delivery.reliableCandidatePaths ? { reliableCandidatePaths: delivery.reliableCandidatePaths } : {}),
    ...(delivery.unattributedCount !== undefined ? { unattributedCount: delivery.unattributedCount } : {}),
    agents,
    ...(delivery.durationMs !== undefined ? { durationMs: delivery.durationMs } : {}),
    ...(Object.keys(semantic).length ? { semantic } : {}),
  };
}

function mergeProcessAgents(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

function mergeProcessEntries(existing: ProcessEntry[], incoming: ProcessEntry[]): ProcessEntry[] {
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const previous = byId.get(entry.id);
    if (previous?.kind === 'tool' && entry.kind === 'tool') {
      // A tool call can arrive once with running args and again with its final
      // result. Keep the newest step while preserving narration collected on
      // the earlier segment.
      byId.set(entry.id, {
        ...entry,
        step: {
          ...entry.step,
          thinking: entry.step.thinking ?? previous.step.thinking,
          narration: entry.step.narration ?? previous.step.narration,
        },
      });
    } else if (!previous || entry.kind === 'subagent') {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.ts - b.entry.ts || a.index - b.index)
    .map(({ entry }) => entry);
}

function processFromMessage(
  message: TaskFlowMessage,
  processId: string,
  entries: ProcessEntry[],
  todo: ProcessTrace['todo'],
  ownerAgentId: string | undefined,
  sid: string | undefined,
): ProcessTrace {
  const phase = processPhase(message);
  const settled = phase !== 'running' && phase !== 'waiting_for_input';
  // The process clock belongs to the whole assistant turn, not to the first
  // tool that happens to be projected.  In particular, a late todo_write must
  // not make Worked-for appear to start at zero.
  const startedAt = message.ts;
  const lastEventAt = entries.length > 0
    ? Math.max(message.ts, ...entries.map((entry) => entry.ts))
    : message.ts;
  const measuredDuration = message.durationMs && message.durationMs > 0
    ? message.durationMs
    : Math.max(0, (settled ? lastEventAt : Date.now()) - startedAt);
  return {
    id: processId,
    anchorMessageId: message.id,
    sourceMessageIds: [message.id],
    sid: message.sid ?? sid,
    turnId: message.turnId,
    phase,
    startedAt,
    ...(settled ? { finishedAt: message.ts + (message.durationMs ?? 0) } : {}),
    ...(settled ? { durationMs: measuredDuration } : {}),
    entries,
    ...(todo ? { todo } : {}),
    agentIds: processAgents(message, ownerAgentId),
  };
}

/**
 * New message/process/artifact projection.
 *
 * The legacy `projectTimeline` above is intentionally kept as a parser for old
 * fixtures/WAL adapters.  This function is the only projection consumed by the
 * current ChatPanel.  In particular, no Todo or current-turn delivery claim
 * can materialize an artifact item: current turns require the host-owned
 * `message.artifact`; only old rows without a turn id use the legacy enriched
 * delivery adapter.
 */
export function projectWorkTimeline(
  messages: TaskFlowMessage[],
  options: { ownerAgentId?: string; sid?: string } = {},
): WorkProjectionResult {
  const timeline: WorkTimelineItem[] = [];
  const processesById: Record<string, ProcessTrace> = {};
  const artifactsById: Record<string, ArtifactSummary> = {};
  const artifactMessageIds: Record<string, string> = {};
  const turnsById: Record<string, WorkTurn> = {};
  const legacyArtifactByTurn: Record<string, string> = {};
  const suppressedLegacyArtifacts = new Set<string>();

  for (const message of messages) {
    if (message.role === 'user') {
      timeline.push({ kind: 'message', messageId: message.id, segmentIndexes: [0] });
      continue;
    }
    if (message.role !== 'assistant') {
      if (message.text || message.segments?.length) {
        timeline.push({
          kind: 'message',
          messageId: message.id,
          segmentIndexes: message.segments?.map((_, index) => index) ?? [0],
        });
      }
      continue;
    }

    const segments = segmentsOf(message);
    const keep = new Set<number>(segments.map((_, index) => index));
    const entries: ProcessEntry[] = [];
    let todo: ProcessTrace['todo'];
    let legacyDelivery: DeliverSummary | null = null;
    const seenToolIds = new Set<string>();
    const processId = message.turnId ?? message.msgId ?? `process:${message.id}`;
    // During a live turn, public assistant narration belongs to the execution
    // trace immediately. When the turn settles, event order decides whether a
    // segment remains process narration or becomes the outside conclusion.
    const capturesLiveNarration = message.status === 'streaming';

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      if (segment.kind === 'thinking') {
        // Thinking is never rendered as an ordinary message.  Only an
        // explicitly host-labelled public summary may enter the process; an
        // unlabeled/private chunk is dropped fail-closed so provider reasoning
        // cannot leak through the message renderer.
        // Unknown and provider-private reasoning never enters the process.
        if (segment.visibility !== 'public_summary' || !segment.text.trim()) {
          keep.delete(index);
          continue;
        }
        keep.delete(index);
        entries.push({
          kind: 'thinking_summary',
          id: `thinking:${message.id}:${index}`,
          text: segment.text,
          ts: segment.ts,
          visibility: 'public_summary',
        });
        continue;
      }
      if (segment.kind === 'text') {
        // A text segment followed by another process event is public execution
        // narration. Text after the final process event is the user-facing
        // conclusion. This rule is independent of Todo and streaming state so
        // replay cannot move the same sentence between Process and reply body.
        const hasLaterProcessEvent = (() => {
          for (const later of segments.slice(index + 1)) {
            if (later.kind === 'thinking') {
              if (later.visibility === 'public_summary' && later.text.trim()) return true;
              continue;
            }
            if (later.kind !== 'tool') continue;
            const laterTool = asToolCall(later.tool);
            if (laterTool.name !== 'deliver_summary') return true;
          }
          return false;
        })();
        if ((capturesLiveNarration || hasLaterProcessEvent) && segment.text.trim()) {
          keep.delete(index);
          entries.push({
            kind: 'assistant_intermediate',
            id: `text:${message.id}:${index}`,
            text: segment.text,
            ts: segment.ts,
          });
        }
        continue;
      }

      const tool = asToolCall(segment.tool);
      if (seenToolIds.has(tool.callId)) {
        keep.delete(index);
        continue;
      }
      seenToolIds.add(tool.callId);
      // Native questions occupy their real tool position in the process.
      // Permission prompts retain their separate, provider-owned lifecycle.
      if (tool.name === 'ask_user' && tool.permissionPrompt === true) {
        keep.delete(index);
        continue;
      }
      if (tool.name === 'todo_write') {
        const items = todoItems(tool);
        if (items?.length) {
          keep.delete(index);
          todo = { items, updatedAt: segment.ts };
          entries.push({ kind: 'todo_snapshot', id: `todo:${tool.callId}`, items, ts: segment.ts });
        }
        continue;
      }
      if (tool.name === 'deliver_summary') {
        // Current turns wait for message.artifact.  A legacy WAL row has no
        // turnId and may only be reconstructed from its old enriched result.
        keep.delete(index);
        const delivery = readDeliver(tool);
        if (delivery) legacyDelivery = delivery;
        continue;
      }
      keep.delete(index);
      const step = buildStep(tool);
      entries.push({ kind: 'tool', id: `tool:${tool.callId}`, step, ts: segment.ts });
    }

    for (const agentId of Object.keys(message.subAgents ?? {})) {
      const run = message.subAgents?.[agentId];
      entries.push({
        kind: 'subagent',
        id: `subagent:${agentId}`,
        agentId,
        status: run?.status,
        ts: run?.startedAt ?? message.ts,
      });
    }

    const turn: WorkTurn = turnsById[processId] ?? {
      id: processId,
      sid: message.sid ?? options.sid,
      checkpointMsgId: message.msgId,
      artifactIds: [],
    };
    turnsById[processId] = turn;

    const existingProcess = processesById[processId];
    if (entries.length > 0 || existingProcess) {
      const phase = processPhase(message);
      const settled = phase !== 'running' && phase !== 'waiting_for_input';
      const process = existingProcess
        ? {
          ...existingProcess,
          phase,
          sourceMessageIds: [...new Set([...(existingProcess.sourceMessageIds ?? []), message.id])],
          startedAt: Math.min(existingProcess.startedAt, message.ts),
          ...(settled
            ? { finishedAt: message.ts + (message.durationMs ?? 0) }
            : { finishedAt: undefined }),
          ...(settled
            ? { durationMs: message.durationMs && message.durationMs > 0
              ? message.durationMs
              : Math.max(0, Math.max(message.ts, ...entries.map((entry) => entry.ts)) - Math.min(existingProcess.startedAt, message.ts)) }
            : { durationMs: undefined }),
          entries: mergeProcessEntries(existingProcess.entries, entries),
          ...(todo ? { todo } : {}),
          agentIds: mergeProcessAgents(existingProcess.agentIds, processAgents(message, options.ownerAgentId)),
        }
        : processFromMessage(message, processId, entries, todo, options.ownerAgentId, options.sid);
      processesById[processId] = process;
      turn.process = process;
      if (!existingProcess) timeline.push({ kind: 'process', processId });
    }

    // Consumed-only delivery rows have no visible message segment.  Do not
    // leave an empty assistant bubble between the user message and its legacy
    // artifact card; an ask_user/tool segment remains in `keep` and is still
    // rendered by the ordinary message path.
    // A process is rendered inside its owning ForgeCard, not by the standalone
    // timeline process marker. Keep that host message even when every visible
    // segment has moved into the process; otherwise a late todo_write turns
    // `keep` empty and React unmounts the whole reply until another ordinary
    // segment arrives.
    if (keep.size > 0 || entries.length > 0 || (!entries.length && message.text) || message.status === 'streaming' || message.status === 'error') {
      timeline.push({
        kind: 'message',
        messageId: message.id,
        segmentIndexes: [...keep].sort((a, b) => a - b),
      });
    }

    const artifact = message.artifact;
    if (artifact && artifactHasCard(artifact)) {
      const legacyId = legacyArtifactByTurn[processId];
      if (legacyId) suppressedLegacyArtifacts.add(legacyId);
      const firstArtifact = !artifactsById[artifact.id];
      artifactsById[artifact.id] = artifact;
      artifactMessageIds[artifact.id] ??= message.id;
      if (!turn.artifactIds.includes(artifact.id)) turn.artifactIds.push(artifact.id);
      if (firstArtifact) timeline.push({ kind: 'artifact', artifactId: artifact.id });
    }

    const legacyArtifact = legacyDelivery
      ? legacyArtifactFromDelivery(message, processId, legacyDelivery, options.sid, options.ownerAgentId)
      : null;
    if (legacyArtifact && !suppressedLegacyArtifacts.has(legacyArtifact.id)) {
      legacyArtifactByTurn[processId] = legacyArtifact.id;
      const firstArtifact = !artifactsById[legacyArtifact.id];
      artifactsById[legacyArtifact.id] = legacyArtifact;
      artifactMessageIds[legacyArtifact.id] ??= message.id;
      if (!turn.artifactIds.includes(legacyArtifact.id)) turn.artifactIds.push(legacyArtifact.id);
      if (firstArtifact) timeline.push({ kind: 'artifact', artifactId: legacyArtifact.id });
    }
  }

  const filteredTimeline = timeline.filter((item) => item.kind !== 'artifact' || !suppressedLegacyArtifacts.has(item.artifactId));
  for (const artifactId of suppressedLegacyArtifacts) {
    delete artifactsById[artifactId];
    delete artifactMessageIds[artifactId];
    for (const turn of Object.values(turnsById)) {
      turn.artifactIds = turn.artifactIds.filter((id) => id !== artifactId);
    }
  }
  return { timeline: filteredTimeline, processesById, artifactsById, artifactMessageIds, turnsById };
}
