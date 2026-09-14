import type { ToolCall } from '../../../session-store';
import { normalizeAskUserQuestions, parseStructuredAskAnswer, askUserHasCompleteAnswer, isPendingAskUser } from '../../../task-flow/ask-user-protocol';

export interface QuestionAnswer { questionId: string; values: string[] }
export function askRequestId(call: ToolCall): string | undefined {
  const id = (call.args as { _askRequestId?: unknown } | null)?._askRequestId;
  return typeof id === 'string' && id ? id : undefined;
}

/** Each independent request keeps its own identity, including when providers
 * reuse question-1 in every call. The combined IDs exist only in the UI. */
export function batchAskCalls(allCalls: ToolCall[]) {
  const calls = allCalls.filter(isPendingAskUser);
  const questions = calls.flatMap(call => normalizeAskUserQuestions(call.args).map(question => ({
    ...question, id: JSON.stringify([call.callId, question.id]),
  })));
  return {
    call: { ...calls[0], callId: `batch:${JSON.stringify(calls.map(call => [call.callId, askRequestId(call)]))}`, args: { questions },
      status: calls.some(call => call.status === 'running') ? 'running' as const : 'done' as const,
      resultData: { ok: true, questions: calls.flatMap(call => parseStructuredAskAnswer(call.resultData ?? call.result).map(answer => ({
        ...answer, questionId: JSON.stringify([call.callId, answer.questionId]),
      }))) },
    },
    replies: (answers: QuestionAnswer[]) => calls.map(call => ({
      callId: call.callId,
      answered: askUserHasCompleteAnswer(call.args, call.resultData, call.result),
      requestId: askRequestId(call),
      answers: normalizeAskUserQuestions(call.args).map(question => ({
        questionId: question.id,
        values: answers.find(answer => answer.questionId === JSON.stringify([call.callId, question.id]))?.values ?? [],
      })),
    })),
  };
}
