export interface ProjectedRemnantInput {
  status: string;
  segmentCount: number;
  projectedSegmentCount: number;
  projectedText: string;
  projectedToolCount: number;
  subAgentCount: number;
  ownsProcess: boolean;
}

/**
 * Task-flow owns normal assistant work, but an error shell remains user-facing
 * even when its only segment was private reasoning: the card carries retry and
 * failure detail that must not disappear with the private segment.
 */
export function isProjectedRemnant(input: ProjectedRemnantInput): boolean {
  return input.status !== 'error'
    && input.projectedSegmentCount < input.segmentCount
    && !input.projectedText.trim()
    && input.projectedToolCount === 0
    && input.subAgentCount === 0
    && !input.ownsProcess;
}
