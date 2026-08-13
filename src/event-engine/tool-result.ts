import type { ToolCall } from '@forgeax/interface/store';

export const TOOL_RESULT_DISPLAY_LIMIT = 2000;

/** Convert any tool result to the text used by the display-only field. */
export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    const json = JSON.stringify(result);
    return json === undefined ? String(result) : json;
  } catch {
    return String(result);
  }
}

/** Keep the existing display contract while retaining the complete value elsewhere. */
export function truncateToolResult(content: string): string {
  return content.length > TOOL_RESULT_DISPLAY_LIMIT
    ? content.slice(0, TOOL_RESULT_DISPLAY_LIMIT) + '\n…'
    : content;
}

/** Parse legacy serialized results into a value a structured-result projection can inspect. */
export function parseToolResultData(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Apply a hook:toolResult payload to the legacy UI tool-call shape. */
export function mergeToolResult(
  toolCall: ToolCall,
  patch: { error?: string; result?: unknown },
): ToolCall {
  const hasResult = patch.result !== undefined;
  const resultContent = hasResult ? stringifyToolResult(patch.result) : undefined;
  return {
    ...toolCall,
    status: patch.error ? 'error' : 'done',
    ...(hasResult
      ? {
          result: truncateToolResult(resultContent!),
          // Structured JSON strings are parsed for protocol consumers while
          // `result` remains the display-only string. Legacy/non-JSON results
          // stay available as their original value.
          resultData: parseToolResultData(patch.result) ?? patch.result,
          fullResultContent:
            resultContent!.length > TOOL_RESULT_DISPLAY_LIMIT ? resultContent : undefined,
        }
      : {}),
    error: patch.error,
  };
}
