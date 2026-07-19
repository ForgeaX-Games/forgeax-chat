import type { ToolCall } from '../../../session-store';

/**
 * Single item in a `todo_write` payload. The tool's schema requires `id` +
 * `content` + `status`; we soften to optional here because (a) replay-from-WAL
 * may surface partially-parsed args and we want defensive handling, and (b)
 * downstream rendering treats id as a routing key, not a content key.
 */
export interface TodoItem {
  id?: string;
  content?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/**
 * Shape of the `args` payload on a `todo_write` ToolCall. All fields optional —
 * different invocation patterns (replace / merge / clear) populate different
 * subsets.
 */
interface TodoWriteArgs {
  todos?: TodoItem[];
  merge?: boolean;
  clear?: boolean;
}

/**
 * Result of partitioning a turn's tool calls into:
 *   - `preFlowTools` — tools that fired BEFORE the first todo_write (no flow
 *     state yet), OR while no todo was in_progress. Rendered in the main
 *     interleave flow above TodoFlow.
 *   - `currentTodoState` — the latest todos[] after all todo_write merge/
 *     replace/clear operations are applied. null means clear or never set.
 *   - `nestedToolsByTodoId` — tools that fired WHILE a specific todo was the
 *     active in_progress one, keyed by that todo's id (or a synthetic
 *     `__nokey_N__` if id is missing).
 *
 * Invariants:
 *   - Every tool call in `toolCalls` lands in exactly one bucket
 *     (preFlowTools OR one nestedToolsByTodoId[id]).
 *   - `todo_write` calls themselves do NOT appear in any bucket — they're the
 *     state transitions that drive the buckets, not rendered chips.
 *   - On `{merge:false}` replace where the prior active todo's id is NOT in
 *     the new todos list, that todo's bucket flushes into `preFlowTools` so
 *     historical work isn't lost (M2 user expectation).
 *
 * Differences vs vag-web's `consolidateTodoWrites`:
 *   1. forgeax's schema makes `id` required, so we use id-primary merge
 *      (no content-fallback path).
 *   2. Empty `todos: []` skips state mutation (preserve prior state) — this
 *      is load-bearing because the renderer sees raw LLM-emitted args before
 *      the tool layer's "non-empty array" guard runs.
 *   3. First-call `{merge:true}` with no prior state falls through to replace
 *      (no special-case).
 */
export interface GroupedTodoFlow {
  preFlowTools: ToolCall[];
  currentTodoState: TodoItem[] | null;
  nestedToolsByTodoId: Record<string, ToolCall[]>;
}

/**
 * id-primary merge: update existing todo by id with incoming fields, append
 * new ids in incoming order. Order of `prev` is preserved for matching ids.
 *
 * Implementation note: we use insertion order of a Map seeded from prev to
 * keep existing positions stable, then iterate incoming to upsert. This
 * matches user expectation that "an existing todo's row doesn't jump around
 * when its status updates".
 */
function mergeById(prev: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const byId = new Map<string, TodoItem>();
  // Seed with prev to preserve order
  for (const t of prev) {
    const k = t.id ?? '';
    if (k) byId.set(k, t);
  }
  // Upsert incoming
  for (const t of incoming) {
    const k = t.id ?? '';
    if (!k) continue; // can't merge without id; skip (replace-mode would
    // catch this case)
    const existing = byId.get(k);
    byId.set(k, existing ? { ...existing, ...t } : t);
  }
  return [...byId.values()];
}

/**
 * Partition tool calls in a turn into the TodoFlow grouping.
 *
 * Walk tool calls in order. Each `todo_write` is a state transition:
 *   - `clear: true` → reset state to "no todo flow seen", subsequent tools go
 *     to preFlowTools until the next todo_write
 *   - `todos: []` (empty) → skip (defensive against malformed LLM payloads
 *     that the tool layer rejects but the renderer still sees)
 *   - `merge: true` → mergeById onto current state
 *   - `merge: false` (or omitted) → full replace; if prior active todo's id
 *     is dropped, flush its bucket to preFlowTools
 *
 * Each non-todo_write tool call routes by:
 *   - no todo flow seen yet OR no in_progress todo → preFlowTools
 *   - active todo exists → nestedToolsByTodoId[activeTodo.id ?? synthetic]
 */
export function groupTodoFlow(toolCalls: ToolCall[]): GroupedTodoFlow {
  let currentTodoState: TodoItem[] | null = null;
  let activeTodo: TodoItem | null = null;
  const preFlowTools: ToolCall[] = [];
  const nestedToolsByTodoId: Record<string, ToolCall[]> = {};
  let seenTodoWriteCount = 0;
  let seenTodoWrite = false;

  for (const tc of toolCalls) {
    if (tc.name === 'todo_write') {
      seenTodoWriteCount++;
      const args = (tc.args ?? {}) as TodoWriteArgs;
      // Branch 1: clear → reset state, no TodoFlow rendered
      if (args.clear === true) {
        currentTodoState = null;
        activeTodo = null;
        seenTodoWrite = false; // re-enter "preFlowTools" mode
        continue;
      }
      // Branch 2: merge or replace
      const incoming = args.todos;
      if (!Array.isArray(incoming) || incoming.length === 0) {
        // Skip empty array. Load-bearing: renderer sees raw LLM-emitted
        // args before the tool layer's non-empty guard runs.
        continue;
      }
      const next: TodoItem[] = args.merge
        ? mergeById(currentTodoState ?? [], incoming)
        : incoming;
      // Orphan-bucket policy: on full replace, flush any tools previously
      // bucketed under todo ids that are NOT in the new state into
      // preFlowTools, so historical work isn't lost (M2 user expectation).
      if (!args.merge) {
        const survivingIds = new Set(
          next.map((t: TodoItem) => t.id).filter((x): x is string => !!x),
        );
        for (const k of Object.keys(nestedToolsByTodoId)) {
          if (!survivingIds.has(k)) {
            preFlowTools.push(...nestedToolsByTodoId[k]);
            delete nestedToolsByTodoId[k];
          }
        }
      }
      currentTodoState = next;
      activeTodo = next.find((t: TodoItem) => t.status === 'in_progress') ?? null;
      seenTodoWrite = true;
      continue; // todo_write itself is NOT rendered as a chip
    }
    // Regular tool call routing
    if (!seenTodoWrite || !activeTodo) {
      preFlowTools.push(tc);
    } else {
      const key = activeTodo.id || `__nokey_${seenTodoWriteCount}__`;
      (nestedToolsByTodoId[key] ??= []).push(tc);
    }
  }
  return { preFlowTools, currentTodoState, nestedToolsByTodoId };
}
