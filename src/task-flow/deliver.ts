import type { DeliverFile, DeliverSummary, DeliverTest, TaskFlowToolCall } from './model';

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

/**
 * Undo a double JSON-encode of the summary: when a producer serialised the
 * payload with ensure-ascii escaping and it survived one parse, non-ASCII text
 * arrives as literal `\uXXXX` sequences (e.g. outcome renders as `已...`).
 * Decode those in place. No-op on correctly-encoded (single) payloads, so it is
 * forward-compatible once the producer stops double-encoding.
 */
function decodeDoubleEscaped<T>(value: T): T {
  if (typeof value === 'string') {
    return (/\\u[0-9a-fA-F]{4}/.test(value)
      ? value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      : value) as T;
  }
  if (Array.isArray(value)) return value.map(decodeDoubleEscaped) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = decodeDoubleEscaped(item);
    return out as T;
  }
  return value;
}

function stringArrayOf(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function fileOf(value: unknown): DeliverFile | null {
  const item = objectOf(value);
  if (!item || typeof item.path !== 'string') return null;
  const change = item.change;
  if (change !== 'edit' && change !== 'new' && change !== 'del') return null;
  return {
    path: item.path,
    change,
    ...(typeof item.insertions === 'number' ? { insertions: item.insertions } : {}),
    ...(typeof item.deletions === 'number' ? { deletions: item.deletions } : {}),
  };
}

function testOf(value: unknown): DeliverTest | null {
  const item = objectOf(value);
  const ok = item && typeof item.ok === 'boolean'
    ? item.ok
    : item && typeof item.pass === 'boolean'
      ? item.pass
      : null;
  if (!item || typeof item.name !== 'string' || ok === null) return null;
  return {
    name: item.name,
    ok,
    ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
  };
}

function payloadOf(value: unknown): Record<string, unknown> | null {
  const outer = objectOf(parseJson(value));
  const payload = objectOf(outer?.summary) ?? outer;
  if (!payload || typeof payload.outcome !== 'string' || !Array.isArray(payload.files)) return null;
  return decodeDoubleEscaped(payload);
}

function summaryOf(payload: Record<string, unknown>): DeliverSummary | null {
  if (typeof payload.outcome !== 'string' || !Array.isArray(payload.files)) return null;
  const files = payload.files.map(fileOf);
  if (files.some((file): file is null => file === null)) return null;
  const tests = Array.isArray(payload.tests) ? payload.tests.map(testOf) : undefined;
  if (tests?.some((test): test is null => test === null)) return null;

  const meta = objectOf(payload.meta);
  const build = typeof payload.build === 'string'
    ? { version: payload.build }
    : (() => {
      const item = objectOf(payload.build);
      if (!item || (typeof item.version !== 'string' && typeof item.label !== 'string')) return undefined;
      return {
        version: typeof item.version === 'string' ? item.version : undefined,
        label: typeof item.label === 'string' ? item.label : undefined,
      };
    })();

  return {
    outcome: payload.outcome,
    roundLabel: typeof payload.roundLabel === 'string' ? payload.roundLabel : undefined,
    files: files as DeliverFile[],
    tests: tests as DeliverTest[] | undefined,
    next: stringArrayOf(payload.next),
    build,
    agents: stringArrayOf(meta?.agents ?? payload.agents),
    durationMs: typeof meta?.durationMs === 'number'
      ? meta.durationMs
      : typeof payload.durationMs === 'number'
        ? payload.durationMs
        : undefined,
    costUsd: typeof meta?.costUsd === 'number'
      ? meta.costUsd
      : typeof payload.costUsd === 'number'
        ? payload.costUsd
        : undefined,
    derivedUnavailable: typeof meta?.derivedUnavailable === 'boolean'
      ? meta.derivedUnavailable
      : typeof payload.derivedUnavailable === 'boolean'
        ? payload.derivedUnavailable
        : undefined,
    unattributedCount: typeof meta?.unattributedCount === 'number'
      ? meta.unattributedCount
      : typeof payload.unattributedCount === 'number'
        ? payload.unattributedCount
        : undefined,
  };
}

/** Read the complete structured result, never the presentation/truncated field. */
export function readDeliver(tool: TaskFlowToolCall): DeliverSummary | null {
  const compat = tool as TaskFlowToolCall;
  const sources = [
    compat.resultData,
    compat.fullResultContent,
    compat.result,
    compat.fullResult,
  ];
  for (const source of sources) {
    if (source === undefined || source === null) continue;
    const payload = payloadOf(source);
    if (!payload) continue;
    const summary = summaryOf(payload);
    if (summary) return summary;
  }
  return null;
}
