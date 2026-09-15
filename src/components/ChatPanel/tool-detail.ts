import type { TaskFlowToolCall } from '../../task-flow/model';
import { safePermissionText } from './permission-presentation';

export function detailText(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return safePermissionText(text ?? '');
  } catch { return ''; }
}

function outputText(value: unknown): string {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return detailText(value); }
  }
  // Host tool envelopes repeat display text in structuredContent; show it once.
  if (parsed && typeof parsed === 'object' && 'structuredContent' in parsed && 'text' in parsed && typeof parsed.text === 'string') {
    try { return detailText(JSON.parse(parsed.text)); } catch { return detailText(parsed.text); }
  }
  return detailText(parsed);
}

/** Display original arguments and output, never infer edits from a success marker. */
export function toolDetail(tool?: TaskFlowToolCall) {
  if (!tool) return { inputs: [], output: '' };
  const args = tool.args;
  const inputs = args && typeof args === 'object' && !Array.isArray(args)
    ? Object.entries(args).map(([name, value]) => ({ name, text: /password|secret|token|authorization|api[_-]?key/i.test(name) ? '[redacted]' : detailText(value) }))
    : args == null ? [] : [{ name: 'input', text: detailText(args) }];
  return { inputs, output: outputText(tool.fullResultContent ?? tool.fullResult ?? tool.result ?? tool.resultData) };
}

export function changedFiles(args: unknown): { path: string; diff: string }[] {
  if (!args || typeof args !== 'object' || !('changes' in args) || !Array.isArray(args.changes)) return [];
  return args.changes.flatMap(change => change && typeof change === 'object' && typeof change.path === 'string'
    ? [{ path: change.path, diff: typeof change.diff === 'string' ? change.diff : detailText(change.kind) }] : []);
}
