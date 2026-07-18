import { Circle, Loader2, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import type { TodoItem } from './groupTodoFlow';

/**
 * Single todo row inside TodoFlow. Status icon + content. Pure presentational.
 *
 * Status visuals:
 *   pending     — empty circle (gray, no fill emphasis)
 *   in_progress — spinning loader (orange/accent, visually heaviest)
 *   completed   — green check
 *   cancelled   — gray X (line-through on content)
 *   <missing>   — minus icon (defensive; should not happen with valid schema)
 *
 * Sizing: 'md' default; 'sm' uses .mp-sm-* CSS variants for SubAgentCard's
 * compact scale.
 */
export function TodoItemRow({
  todo,
  size = 'md',
}: {
  todo: TodoItem;
  size?: 'sm' | 'md';
}) {
  const status = todo.status;
  const isActive = status === 'in_progress';
  const isCancelled = status === 'cancelled';
  const iconSize = size === 'sm' ? 11 : 13;
  const smCls = size === 'sm' ? ' mp-sm' : '';
  return (
    <div className={`todo-row todo-${status ?? 'missing'}${smCls}`}>
      <span className="todo-icon" aria-hidden="true">
        {status === 'pending' && <Circle size={iconSize} />}
        {status === 'in_progress' && <Loader2 size={iconSize} className="spin" />}
        {status === 'completed' && <CheckCircle2 size={iconSize} />}
        {status === 'cancelled' && <XCircle size={iconSize} />}
        {!status && <MinusCircle size={iconSize} />}
      </span>
      <span
        className={`todo-content${isActive ? ' is-active' : ''}${isCancelled ? ' is-cancelled' : ''}`}
      >
        {todo.content ?? <em className="todo-missing">(no content)</em>}
      </span>
    </div>
  );
}
