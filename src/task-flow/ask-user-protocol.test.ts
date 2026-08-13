import { describe, expect, it } from 'bun:test';
import {
  askUserHasAnswer,
  askUserHasCompleteAnswer,
  hasPendingAskUser,
  hasUnansweredAskUser,
  isPendingAskUser,
  isTerminalAskUser,
  normalizeAskUserArgs,
  normalizeAskUserQuestions,
  parseLegacyAskAnswer,
  parseStructuredAskAnswer,
  formatAskUserValues,
} from './ask-user-protocol';

describe('ask-user protocol boundary', () => {
  it('formats resolved multi-select values with ASCII semicolon-space separators in selection order', () => {
    expect(formatAskUserValues(['贴脸躲障碍，失败重来', '随机地形 + 距离排行'], '无')).toBe(
      '贴脸躲障碍，失败重来; 随机地形 + 距离排行',
    );
    expect(formatAskUserValues(['跑酷 / 无尽闯关'], '无')).toBe('跑酷 / 无尽闯关');
    expect(formatAskUserValues([], '无')).toBe('无');
  });
  it('normalizes a provider-compatible one-question envelope for the native card', () => {
    expect(normalizeAskUserArgs({
      questions: [{
        question: 'Which direction?',
        header: 'Direction',
        options: ['Side-scrolling action', { label: 'Top-down shooter', description: 'Aim from above' }],
        multiSelect: false,
      }],
    })).toEqual({
      question: 'Which direction?',
      header: 'Direction',
      options: ['Side-scrolling action', { label: 'Top-down shooter', description: 'Aim from above' }],
      multiSelect: false,
    });
  });

  it('preserves a multi-question envelope with stable ids for the grouped card', () => {
    expect(normalizeAskUserQuestions({
      questions: [
        { id: 'genre', question: 'Which genre?', options: ['Runner', 'Tower defense'] },
        { question: 'Which loops?', options: ['Mastery', 'Progression'], multiSelect: true },
      ],
    })).toEqual([
      { id: 'genre', question: 'Which genre?', options: ['Runner', 'Tower defense'] },
      { id: 'question-2', question: 'Which loops?', options: ['Mastery', 'Progression'], multiSelect: true },
    ]);
  });

  it('requires every question but allows one value for a multi-select answer', () => {
    const args = {
      questions: [
        { id: 'one', question: 'One?', options: ['A', 'B'] },
        // Provider hints such as minSelections are advisory: product multi-select
        // means one-or-more, not a mandatory minimum greater than one.
        { id: 'two', question: 'Two?', options: ['C', 'D'], multiSelect: true, minSelections: 2 },
      ],
    };
    expect(askUserHasCompleteAnswer(args, {
      ok: true,
      questions: [{ questionId: 'one', values: ['A'] }],
    })).toBe(false);
    expect(askUserHasCompleteAnswer(args, {
      ok: true,
      questions: [
        { questionId: 'one', values: ['A'] },
        { questionId: 'two', values: ['C'] },
      ],
    })).toBe(true);
    expect(askUserHasCompleteAnswer(args, {
      ok: true,
      questions: [
        { questionId: 'one', values: ['A'] },
        { questionId: 'two', values: ['C', 'D'] },
      ],
    })).toBe(true);
  });

  it('treats legacy quoted results as resolved answers', () => {
    expect(parseLegacyAskAnswer('已选择「Design」和「Combat」')).toEqual(['Design', 'Combat']);
    expect(askUserHasAnswer({ result: '已选择「Design」和「Combat」' })).toBe(true);
    expect(hasUnansweredAskUser({ name: 'AskUserQuestion', status: 'done', result: '已选择「Design」' })).toBe(false);
  });

  it('accepts structured JSON strings and keeps empty values pending', () => {
    const result = JSON.stringify({ ok: true, questions: [{ questionId: 'q1', values: ['A'] }] });
    expect(parseStructuredAskAnswer(result)).toEqual([{ questionId: 'q1', values: ['A'] }]);
    expect(isPendingAskUser({ name: 'mcp__fxt__AskUserQuestion', status: 'running' })).toBe(true);
    expect(isPendingAskUser({
      name: 'ask_user',
      status: 'done',
      resultData: { ok: true, questions: [{ questionId: 'q1', values: [] }] },
    })).toBe(false);
  });

  it('parses the native MCP text result envelope on live and replay paths', () => {
    expect(parseStructuredAskAnswer({
      text: JSON.stringify({ ok: true, questions: [{ questionId: 'question-1', values: ['A'] }] }),
      structuredContent: null,
    })).toEqual([{ questionId: 'question-1', values: ['A'] }]);
    expect(askUserHasAnswer({
      resultData: {
        text: JSON.stringify({ ok: true, questions: [{ questionId: 'question-1', values: ['A'] }] }),
        structuredContent: null,
      },
    })).toBe(true);
  });

  it('does not let an unreadable terminal result hold the provider turn open', () => {
    const expired = { name: 'ask_user', status: 'done', result: 'provider returned no selectable value' };
    expect(hasUnansweredAskUser(expired)).toBe(true);
    expect(isPendingAskUser(expired)).toBe(false);
    expect(hasPendingAskUser([expired])).toBe(false);
  });

  it('keeps only a live unanswered call pending and has no client-side timeout', () => {
    const running = { name: 'ask_user', status: 'running' };
    const doneWithoutPayload = { name: 'ask_user', status: 'done' };
    const errorWithoutPayload = { name: 'ask_user', status: 'error' };

    expect(isPendingAskUser(running)).toBe(true);
    expect(isPendingAskUser({ ...running })).toBe(true);
    expect(isTerminalAskUser(running)).toBe(false);
    expect(isTerminalAskUser(doneWithoutPayload)).toBe(true);
    expect(isPendingAskUser(doneWithoutPayload)).toBe(false);
    expect(isPendingAskUser(errorWithoutPayload)).toBe(false);
  });

  it('does not treat a CLI permission-side-channel ask as native AskUser state', () => {
    const cliAsk = {
      name: 'ask_user',
      permissionPrompt: true,
      status: 'running',
    };
    expect(hasUnansweredAskUser(cliAsk)).toBe(false);
    expect(isPendingAskUser(cliAsk)).toBe(false);
    expect(hasPendingAskUser([cliAsk])).toBe(false);
  });
});
