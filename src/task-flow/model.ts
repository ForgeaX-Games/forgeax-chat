import type { ChatMessage, ChatSegment, ToolCall } from '../session-store';
import type {
  ArtifactFileChange,
  ArtifactSemantic,
  ArtifactSummary,
} from '@forgeax/types/artifact-summary';

export type { ArtifactFileChange, ArtifactSemantic, ArtifactSummary } from '@forgeax/types/artifact-summary';

/** Compatibility view for structured tool results not yet present in interface's ToolCall. */
export type TaskFlowToolCall = ToolCall & {
  resultData?: unknown;
  fullResult?: string;
  fullResultContent?: string;
};

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id?: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
  agentId?: string;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'frozen';

export interface DiffStat {
  path: string;
  change: 'edit' | 'new' | 'del';
  insertions: number;
  deletions: number;
}

export interface Step {
  id: string;
  name: string;
  status: StepStatus;
  tool?: TaskFlowToolCall;
  thinking?: string[];
  narration?: string[];
  diff?: DiffStat;
  assetCount?: number;
  badge?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Task {
  id: string;
  content: string;
  activeForm?: string;
  status: TodoStatus;
  steps: Step[];
  demotedFromActive?: boolean;
  agentId?: string;
}

export interface DeliverFile {
  path: string;
  change: 'edit' | 'new' | 'del';
  insertions?: number;
  deletions?: number;
}

export interface DeliverTest {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DeliverSummary {
  outcome: string;
  roundLabel?: string;
  files: DeliverFile[];
  /** Host-derived status. Legacy semantic-only deliveries may omit it. */
  status?: ArtifactSummary['status'];
  tests?: DeliverTest[];
  next?: string[];
  build?: { version?: string; label?: string };
  agents?: string[];
  durationMs?: number;
  costUsd?: number;
  derivedUnavailable?: boolean;
  unavailableReason?: string;
  reliableCandidatePaths?: string[];
  unattributedCount?: number;
}

export type RoundPhase = 'planning' | 'executing' | 'delivered' | 'closed' | 'interrupted';

export interface Round {
  /** Stable UI key derived from the opening user message. */
  id: string;
  /** Server checkpoint key when the message has been acknowledged. */
  checkpointMsgId?: string;
  index: number;
  label?: string;
  phase: RoundPhase;
  plan: Task[];
  archivedTasks: Task[];
  unplannedSteps: Step[];
  deliver: DeliverSummary | null;
  /** Round-level assistant narration not tied to any task (e.g. the opening /
   *  closing "what I did" text). Folded into the process accordion instead of a
   *  standalone main-flow bubble, so the delivery card stays the sole conclusion. */
  narration?: string[];
  stepCount: number;
  durationMs: number;
  agentIds: string[];
  /** Internal anchor used when a paged timeline is sliced after projection. */
  firstMessageId?: string;
}

export type TimelineItem =
  | { kind: 'message'; messageId: string; segmentIndexes: number[] }
  | { kind: 'round'; roundId: string };

export interface ProjectionResult {
  timeline: TimelineItem[];
  roundsById: Record<string, Round>;
}

export type TaskFlowMessage = Pick<
  ChatMessage,
  | 'id' | 'role' | 'status' | 'text' | 'ts' | 'durationMs' | 'segments' | 'toolCalls' | 'subAgents'
  | 'turnId' | 'turnAborted' | 'artifact' | 'artifactAnchorSeq' | 'msgId'
> & {
  /** Streaming kernel id — never an agent identity. */
  providerId?: string;
  /** Session identity is supplied by the active chat projection. */
  sid?: string;
};

export type TaskFlowSegment = ChatSegment & { tool?: TaskFlowToolCall };

/** New projection model.  The old Round types below remain as a read-only
 * legacy adapter for historical unit fixtures; the ChatPanel no longer renders
 * them. */
export type ProcessPhase = 'running' | 'waiting_for_input' | 'done' | 'error' | 'aborted';

export type ProcessEntry =
  | { kind: 'thinking_summary'; id: string; text: string; ts: number; visibility: 'public_summary' }
  | { kind: 'assistant_intermediate'; id: string; text: string; ts: number }
  | { kind: 'tool'; id: string; step: Step; ts: number }
  | { kind: 'subagent'; id: string; agentId: string; ts: number }
  | { kind: 'todo_snapshot'; id: string; items: TodoItem[]; ts: number };

export interface ProcessTrace {
  id: string;
  /** Internal paging anchor; never shown to users. */
  anchorMessageId?: string;
  /** Every assistant message folded into this process. Used by paged history. */
  sourceMessageIds?: string[];
  sid?: string;
  turnId?: string;
  phase: ProcessPhase;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  entries: ProcessEntry[];
  todo?: { items: TodoItem[]; updatedAt: number };
  agentIds: string[];
}

export interface WorkTurn {
  id: string;
  sid?: string;
  checkpointMsgId?: string;
  process?: ProcessTrace;
  artifactIds: string[];
}

export type WorkTimelineItem =
  | { kind: 'message'; messageId: string; segmentIndexes: number[] }
  | { kind: 'process'; processId: string }
  | { kind: 'artifact'; artifactId: string };

export interface WorkProjectionResult {
  timeline: WorkTimelineItem[];
  processesById: Record<string, ProcessTrace>;
  artifactsById: Record<string, ArtifactSummary>;
  artifactMessageIds: Record<string, string>;
  turnsById: Record<string, WorkTurn>;
}
