/** Runtime context occupancy is authoritative over model-catalog estimates. */
export interface ContextUsage {
  pct: number;
  source: 'runtime' | 'estimate';
  ts: number;
  kernelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

export function contextKernelId(payload: Record<string, unknown>): string | undefined {
  const id = payload.kernelId ?? payload.providerId;
  return typeof id === 'string' && id ? id : undefined;
}

export function runtimeContextUsage(payload: Record<string, unknown>, ts: number): ContextUsage | null {
  const { inputTokens, outputTokens, contextWindow } = payload;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0 ||
      typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0 ||
      typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return { pct: Math.min(100, Math.round((inputTokens + outputTokens) / contextWindow * 100)), source: 'runtime', ts, kernelId: contextKernelId(payload), inputTokens, outputTokens, contextWindow };
}

export function latestContextUsage(previous: ContextUsage | undefined, next: ContextUsage): ContextUsage {
  const changedKernel = previous?.kernelId && next.kernelId && previous.kernelId !== next.kernelId;
  if (previous && (next.ts < previous.ts ||
      (!changedKernel && previous.source === 'runtime' && next.source === 'estimate'))) return previous;
  return next;
}
