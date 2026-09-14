import type { ChatSegment, SubAgentRun, ToolCall } from '../../session-store';

/**
 * The UI-facing execution stages are deliberately narrower than the generic
 * telemetry vocabulary. A stage is returned only when the chat projection has
 * direct evidence for it; otherwise the UI says "unknown" instead of
 * presenting a guessed explanation for a silent provider.
 */
export type ExecutionStage =
  | 'preparing'
  | 'generating'
  | 'tool_execution'
  | 'authorization_wait'
  | 'child_execution'
  | 'waiting_for_input'
  | 'unknown';

export interface ExecutionStageInput {
  status: 'done' | 'running' | 'waiting' | 'error';
  text?: string;
  thought?: string;
  segments?: ChatSegment[];
  toolCalls?: ToolCall[];
  subAgents?: Record<string, SubAgentRun>;
}

/** Stable i18n keys shared by the chip and the loading body. */
export function executionStageLabelKey(stage: ExecutionStage): string {
  switch (stage) {
    case 'preparing': return 'executionStage.preparing';
    case 'generating': return 'executionStage.generating';
    case 'tool_execution': return 'executionStage.toolExecution';
    case 'authorization_wait': return 'executionStage.authorizationWait';
    case 'child_execution': return 'executionStage.childRunning';
    case 'waiting_for_input': return 'executionStage.waitingForInput';
    case 'unknown': return 'executionStage.unknown';
  }
}

function hasGenerationEvidence(input: ExecutionStageInput): boolean {
  const segments = input.segments;
  if (Array.isArray(segments) && segments.length > 0) {
    const last = segments[segments.length - 1];
    return (last.kind === 'text' || last.kind === 'thinking') && last.text.trim().length > 0;
  }
  // Older projections do not retain the ordered segment stream. Their live
  // text/thinking fields are the only available provider-output evidence;
  // an empty projection must remain unknown rather than being called setup.
  return Boolean(input.text?.trim() || input.thought?.trim());
}

/**
 * Derive the best-known live stage from the same event projection rendered by
 * ForgeCard. The order is intentional: an active child or authorization wait
 * is more informative than the parent's previous output, and a running tool
 * is more informative than a generic "preparing" state.
 */
export function deriveExecutionStage(input: ExecutionStageInput): ExecutionStage {
  if (input.status === 'done' || input.status === 'error') return 'unknown';
  const runningTools = (input.toolCalls ?? []).filter((tool) => tool.status === 'running');
  const childRunning = Object.values(input.subAgents ?? {}).some((run) => run.status === 'streaming');
  if (childRunning) return 'child_execution';

  if (runningTools.some((tool) => (
    tool.name === 'ask_user'
  ))) {
    return 'waiting_for_input';
  }

  if (runningTools.length > 0) return 'tool_execution';
  if (input.status === 'running' && hasGenerationEvidence(input)) return 'generating';

  // A running/waiting/error/done state without direct phase evidence is not
  // enough to classify as preparation, input, authorization, or child wait.
  // Keep this explicit so a silent provider is not presented with a guess.
  return 'unknown';
}

/** An active turn without finer evidence is still working, not a UI failure. */
export function workingLabel(language?: string): string {
  return language?.startsWith("zh") ? "工作中" : "Working";
}
