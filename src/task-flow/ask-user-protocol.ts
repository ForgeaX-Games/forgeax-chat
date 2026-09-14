import { canonicalToolName } from '../event-engine/tool-name';

export interface AskAnswer {
  questionId?: string;
  values: string[];
}

export interface AskUserToolLike {
  name?: unknown;
  status?: unknown;
  permissionPrompt?: unknown;
  result?: unknown;
  resultData?: unknown;
  args?: unknown;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface AskUserQuestion {
  id: string;
  question?: string;
  header?: string;
  options?: Array<{ label: string; description?: string } | string>;
  multiSelect?: boolean;
}

export interface AskUserArgs extends Omit<AskUserQuestion, 'id'> {
  questions?: Array<Partial<AskUserQuestion>>;
}

/** Native MCP hosts may wrap the tool's JSON answer as
 * `{ text: "<json>", structuredContent: null }`. Unwrap only this result
 * envelope; legacy CLI AskUserQuestion still owns its own side-channel. */
function unwrapAskResult(value: unknown): unknown {
  let source = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof source === 'string') {
      const raw = source.trim().replace(/^\[ask_user\]\s*/i, '');
      try {
        source = JSON.parse(raw) as unknown;
        continue;
      } catch {
        return source;
      }
    }
    const record = objectOf(source);
    if (!record) return source;
    if (record.ok === true && Array.isArray(record.questions)) return record;
    if (record.structuredContent !== null && record.structuredContent !== undefined) {
      source = record.structuredContent;
      continue;
    }
    if (typeof record.text === 'string') {
      source = record.text;
      continue;
    }
    return source;
  }
  return source;
}

/** Normalize the provider-compatible one-item envelope used by some native
 * MCP clients. Legacy CLI permission asks intentionally do not use this
 * helper: their `questions[]` shape remains owned by PermissionPrompt. */
export function normalizeAskUserQuestions(value: unknown): AskUserQuestion[] {
  const root = objectOf(value);
  if (!root) return [];
  const normalize = (value: unknown, index: number): AskUserQuestion | null => {
    const question = objectOf(value);
    if (!question) return null;
    return {
      id: typeof question.id === 'string' && question.id.trim()
        ? question.id.trim()
        : `question-${index + 1}`,
      ...(typeof question.question === 'string' ? { question: question.question } : {}),
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(Array.isArray(question.options) ? { options: question.options as AskUserQuestion['options'] } : {}),
      ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
    };
  };
  if (Array.isArray(root.questions)) {
    return root.questions.flatMap((question, index) => {
      const normalized = normalize(question, index);
      return normalized ? [normalized] : [];
    });
  }
  const single = normalize(root, 0);
  return single ? [single] : [];
}

/** Backward-compatible single-question view for older callers. */
export function normalizeAskUserArgs(value: unknown): AskUserArgs {
  const first = normalizeAskUserQuestions(value)[0];
  if (!first) return {};
  const { id: _id, ...question } = first;
  return question;
}

/** Parse the native structured result and the JSON-string form used by CLI
 * bridges. Empty question values are intentionally not answers. */
export function parseStructuredAskAnswer(value: unknown): AskAnswer[] {
  const source = unwrapAskResult(value);
  const record = objectOf(source);
  if (!record || record.ok !== true || !Array.isArray(record.questions)) return [];
  return record.questions.flatMap((question): AskAnswer[] => {
    const item = objectOf(question);
    if (!item || !Array.isArray(item.values)) return [];
    const values = item.values.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    );
    return values.length
      ? [{ questionId: typeof item.questionId === 'string' ? item.questionId : undefined, values }]
      : [];
  });
}

/** Legacy native kernels embedded the selected value in localized quotes. */
export function parseLegacyAskAnswer(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/「([^」]*)」/g)]
    .map((match) => match[1]!)
    .filter((entry) => entry.trim().length > 0);
}

export function askUserHasAnswer(tool: Pick<AskUserToolLike, 'result' | 'resultData'>): boolean {
  return parseStructuredAskAnswer(tool.resultData).length > 0
    || parseLegacyAskAnswer(tool.result).length > 0;
}

/** Multi-question completion must cover every normalized question. A partial
 * structured result is never enough to fold the group or release the turn. */
export function askUserHasCompleteAnswer(args: unknown, resultData: unknown, legacyResult?: unknown): boolean {
  const questions = normalizeAskUserQuestions(args);
  const answers = parseStructuredAskAnswer(resultData);
  if (questions.length > 0 && answers.length > 0) {
    const byId = new Map(answers.map((answer) => [answer.questionId, answer.values]));
    return questions.every((question) => {
      const values = byId.get(question.id) ?? [];
      return values.length > 0 && (question.multiSelect === true || values.length === 1);
    });
  }
  // Quoted legacy answers are recoverable only for the historical flat card.
  return questions.length <= 1 && parseLegacyAskAnswer(legacyResult).length > 0;
}

export function isAskUser(tool: AskUserToolLike): boolean {
  return canonicalToolName(typeof tool.name === 'string' ? tool.name : '') === 'ask_user';
}

/** Includes terminal, unreadable historical results. The enclosing Forge card
 * uses this visibility guard so an unanswered question cannot be hidden even
 * when the provider has already stopped. */
export function hasUnansweredAskUser(tool: AskUserToolLike): boolean {
  // CLI AskUserQuestion is owned by PermissionPrompt. It is deliberately
  // excluded from the native ask_user lifecycle so a replay cannot resurrect
  // a second, misleading "unparseable history" card.
  return isAskUser(tool) && tool.permissionPrompt !== true
    && !(tool.args !== undefined
      ? askUserHasCompleteAnswer(tool.args, tool.resultData, tool.result)
      : askUserHasAnswer(tool));
}

function hasResultPayload(tool: AskUserToolLike): boolean {
  if (tool.resultData !== undefined && tool.resultData !== null) return true;
  return typeof tool.result === 'string' && tool.result.trim().length > 0;
}

export function isTerminalAskUser(tool: Pick<AskUserToolLike, 'status'>): boolean {
  return tool.status === 'done' || tool.status === 'error';
}

/**
 * A provider turn-end must not seal a message while this exact call is still
 * waiting for the browser reply. A terminal error or an unreadable terminal
 * payload is not kept pending: it is rendered as an expired read-only card.
 */
export function isPendingAskUser(tool: AskUserToolLike): boolean {
  if (!hasUnansweredAskUser(tool)) return false;
  if (isTerminalAskUser(tool)) return false;
  if (tool.status === 'running') return true;
  return !hasResultPayload(tool);
}

export function hasPendingAskUser(tools: Iterable<AskUserToolLike>): boolean {
  for (const tool of tools) {
    if (isPendingAskUser(tool)) return true;
  }
  return false;
}

/** Compact resolved-card label. Preserve answer order and keep the separator
 * language-neutral: the answer is metadata in a single compact row. */
export function formatAskUserValues(values: readonly string[], emptyLabel: string): string {
  return values.length ? values.join('; ') : emptyLabel;
}

/** A terminal turn cannot retain an answerable request. No answer is inferred. */
export function closePendingAsk<T extends AskUserToolLike>(tool: T): T {
  return isPendingAskUser(tool) ? { ...tool, status: 'done' } : tool;
}
