import { t } from '@forgeax/interface/i18n';
import type { Step, StepStatus, TaskFlowToolCall } from './model';

const LABEL_KEYS: Record<string, string> = {
  read_file: 'readFile',
  write_file: 'writeFile',
  edit_file: 'editFile',
  multi_edit: 'multiEdit',
  bash: 'bash',
  shell: 'bash',
  apply_patch: 'applyPatch',
  grep: 'grep',
  glob: 'glob',
  subagent: 'subagent',
  ask_user: 'askUser',
  list_dir: 'listDir',
};

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringArg(args: unknown, ...keys: string[]): string | undefined {
  const obj = objectOf(args);
  for (const key of keys) if (typeof obj[key] === 'string') return obj[key] as string;
  return undefined;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function stepLabel(tool: TaskFlowToolCall): string {
  const path = stringArg(tool.args, 'file_path', 'path', 'file');
  const command = stringArg(tool.args, 'command', 'cmd');
  const key = LABEL_KEYS[tool.name];
  const label = key ? t(`taskFlow.tool.${key}`) : tool.name.replace(/[_-]+/g, ' ');
  if (path) return `${label} · ${baseName(path)}`;
  if (command) return `${label} · ${command.slice(0, 42)}`;
  return label;
}

function stepStatus(tool: TaskFlowToolCall): StepStatus {
  if (tool.status === 'error') return 'error';
  if (tool.status === 'running') return 'running';
  return 'done';
}

function assetCount(tool: TaskFlowToolCall): number | undefined {
  const args = objectOf(tool.args);
  for (const key of ['assets', 'files', 'paths']) {
    if (Array.isArray(args[key])) return args[key].length;
  }
  return undefined;
}

export function buildStep(
  tool: TaskFlowToolCall,
  thinking: string[] = [],
  narration: string[] = [],
): Step {
  const status = stepStatus(tool);
  const assets = assetCount(tool);
  return {
    id: tool.callId,
    name: stepLabel(tool),
    status,
    tool,
    thinking: thinking.length ? thinking : undefined,
    narration: narration.length ? narration : undefined,
    assetCount: assets,
    badge: status === 'error'
      ? t('taskFlow.badgeError')
      : assets
        ? t('taskFlow.badgeAssets', { count: assets })
        : status === 'done' ? t('taskFlow.badgeDone') : undefined,
    startedAt: tool.at,
    finishedAt: status === 'done' || status === 'error' ? tool.at : undefined,
  };
}

/**
 * Row-end result signal, in the design's priority order: a diff outranks an
 * asset count, which outranks the plain settled/failed marker.
 */
export function stepBadge(step: Step): string {
  if (step.diff) return `+${step.diff.insertions} −${step.diff.deletions}`;
  if (step.assetCount) return t('taskFlow.badgeAssets', { count: step.assetCount });
  if (step.status === 'error') return t('taskFlow.badgeError');
  return step.status === 'done' || step.status === 'frozen' ? t('taskFlow.badgeDone') : '';
}
