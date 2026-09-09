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
 * Filtering private reasoning must not remove the running response identity
 * and elapsed status. Error shells likewise carry user-facing failure detail.
 * Only a settled, empty remnant can disappear with its private segments.
 */
export function isProjectedRemnant(input: ProjectedRemnantInput): boolean {
  return input.status !== 'error'
    && input.status !== 'streaming'
    && input.projectedSegmentCount < input.segmentCount
    && !input.projectedText.trim()
    && input.projectedToolCount === 0
    && input.subAgentCount === 0
    && !input.ownsProcess;
}
