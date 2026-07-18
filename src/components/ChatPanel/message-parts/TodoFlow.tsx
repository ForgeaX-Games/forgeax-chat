import { Fragment } from 'react';
import type { ToolCall } from '../../../session-store';
import { TodoItemRow } from './TodoItemRow';
import { ToolChipRow } from './ToolChipRow';
import type { TodoItem } from './groupTodoFlow';

/**
 * TodoFlow — common-at-the-bottom todo list with tool chips nested under the
 * todo that was active when each tool fired.
 *
 * Rendering rules (matches user expectation, see plan §#2):
 *   - All todos render as TodoItemRow, in their stored order.
 *   - Any todo whose id has a non-empty `nestedToolsByTodoId[id]` bucket
 *     shows the bucketed tool chips beneath it, indented + left-bordered.
 *     This applies regardless of the todo's current status (a now-completed
 *     todo still shows the historical tools that ran while it was active).
 *   - When a subagent chip lives in a bucket, the SubAgentCard for that
 *     subagent is rendered immediately after the chip, INSIDE the nested
 *     indent. The caller passes a `renderSubAgent` callback so this module
 *     stays decoupled from ../SubAgentCard.tsx.
 *
 * Sizing: pass `size='sm'` when used inside SubAgentCard (rare — a sub-agent
 * todo flow). Default 'md' for the main bubble.
 */
export function TodoFlow({
  todos,
  nestedToolsByTodoId,
  size = 'md',
  renderSubAgent,
}: {
  todos: TodoItem[];
  nestedToolsByTodoId: Record<string, ToolCall[]>;
  size?: 'sm' | 'md';
  /**
   * Optional renderer for a subagent's expanded card. Called when a tool chip
   * inside a todo's nest has `subagentId` and that id resolves on the caller's
   * side (e.g. chatMsg.subAgents map). Return null/undefined to skip.
   */
  renderSubAgent?: (subagentId: string) => React.ReactNode;
}) {
  if (!todos.length) return null;
  const smCls = size === 'sm' ? ' mp-sm' : '';
  return (
    <div className={`todo-flow${smCls}`}>
      {todos.map((todo, idx) => {
        const key = todo.id || `__row_${idx}__`;
        const bucket = todo.id ? nestedToolsByTodoId[todo.id] : undefined;
        const hasBucket = bucket && bucket.length > 0;
        return (
          <Fragment key={key}>
            <TodoItemRow todo={todo} size={size} />
            {hasBucket && (
              <div className={`todo-nest${smCls}`}>
                {bucket!.map((tc) => (
                  <Fragment key={tc.callId}>
                    <ToolChipRow tc={tc} size={size} />
                    {tc.subagentId && renderSubAgent
                      ? renderSubAgent(tc.subagentId)
                      : null}
                  </Fragment>
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
