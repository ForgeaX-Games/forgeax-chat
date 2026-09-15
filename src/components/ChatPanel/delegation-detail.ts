import { canonicalToolName } from '../../event-engine/tool-name';
import type { TaskFlowToolCall } from '../../task-flow/model';

export function delegationDetail(tool?: TaskFlowToolCall): { target: string; message: string } | null {
  if (!tool || canonicalToolName(tool.name) !== 'delegate_to_subagent') return null;
  const args = tool.args && typeof tool.args === 'object' && !Array.isArray(tool.args)
    ? tool.args as Record<string, unknown> : {};
  const target = typeof args.agent === 'string' && args.agent.trim() ? args.agent
    : typeof args.templateRef === 'string' ? args.templateRef : '';
  return { target, message: typeof args.message === 'string' ? args.message : '' };
}
