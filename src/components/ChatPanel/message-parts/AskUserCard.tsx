/** Grouped Ask User card.
 *
 * Pending questions stay fully expanded and are submitted once as a group.
 * After the server accepts the answer, every question folds to a one-line
 * question + answer summary and may be reopened read-only.
 */
import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import type { ToolCall } from '../../../session-store';
import {
  askUserHasAnswer as protocolAskUserHasAnswer,
  askUserHasCompleteAnswer,
  formatAskUserValues,
  isTerminalAskUser,
  normalizeAskUserQuestions,
  parseLegacyAskAnswer,
  parseStructuredAskAnswer,
  type AskUserQuestion,
} from '../../../task-flow/ask-user-protocol';

interface AskOption { label: string; description?: string }
interface QuestionDraft { selected: string[]; customOn: boolean; customText: string }
interface AskCache {
  questions: AskUserQuestion[];
  drafts: Record<string, QuestionDraft>;
  submitted: boolean;
  expandedIds: string[];
}

const askState = new Map<string, AskCache>();

export function dropAskUserSession(sid: string): void {
  const prefix = `${sid}::`;
  for (const key of askState.keys()) {
    if (key.startsWith(prefix)) askState.delete(key);
  }
}

function normalizeOptions(raw: AskUserQuestion['options']): AskOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): AskOption[] => {
    if (typeof item === 'string') return [{ label: item }];
    return item && typeof item === 'object' && typeof item.label === 'string'
      ? [{ label: item.label, description: item.description }]
      : [];
  });
}

function emptyDraft(): QuestionDraft {
  return { selected: [], customOn: false, customText: '' };
}

function valuesOf(draft: QuestionDraft | undefined): string[] {
  if (!draft) return [];
  return [
    ...draft.selected,
    ...(draft.customOn && draft.customText.trim() ? [draft.customText.trim()] : []),
  ];
}

function displayQuestion(
  question: AskUserQuestion,
  index: number,
  count: number,
  fallback: string,
  progress: (current: number, total: number) => string,
): string {
  const text = question.question?.trim() || fallback;
  if (count <= 1) return text;
  return `${progress(index + 1, count)} · ${text}`;
}

export const askUserHasAnswer = protocolAskUserHasAnswer;

export function AskUserCard({ tc, sid, agentId }: { tc: ToolCall; sid: string; agentId: string }) {
  const { t } = useTranslation();
  const cacheKey = `${sid}::${agentId}::${tc.callId}`;
  const cached = askState.get(cacheKey);
  const normalized = normalizeAskUserQuestions(tc.args);
  const questions = normalized.length ? normalized : cached?.questions ?? [];
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(cached?.drafts ?? {});
  const [submitted, setSubmitted] = useState(cached?.submitted ?? false);
  const [expandedIds, setExpandedIds] = useState<string[]>(cached?.expandedIds ?? []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snapshot = (next: Partial<AskCache>) => {
    const current = askState.get(cacheKey) ?? {
      questions,
      drafts,
      submitted,
      expandedIds,
    };
    askState.set(cacheKey, {
      ...current,
      ...next,
      questions: questions.length ? questions : current.questions,
    });
  };
  if (normalized.length && (!cached || cached.questions.length === 0)) snapshot({ questions: normalized });

  const structured = parseStructuredAskAnswer(tc.resultData);
  const legacy = parseLegacyAskAnswer(tc.result);
  const answered = submitted || askUserHasCompleteAnswer(tc.args, tc.resultData, tc.result);
  const expired = !answered && isTerminalAskUser(tc);
  const locked = answered || expired;
  const argsReady = questions.length > 0;

  const answerMap = new Map(structured.map((answer) => [answer.questionId, answer.values]));
  if (legacy.length && questions[0] && !answerMap.has(questions[0].id)) answerMap.set(questions[0].id, legacy);
  const shownValues = (question: AskUserQuestion) => answerMap.get(question.id) ?? valuesOf(drafts[question.id]);

  const updateDraft = (questionId: string, next: QuestionDraft) => {
    const updated = { ...drafts, [questionId]: next };
    setDrafts(updated);
    snapshot({ drafts: updated });
  };

  const pick = (question: AskUserQuestion, label: string) => {
    if (locked || sending) return;
    const draft = drafts[question.id] ?? emptyDraft();
    const next = question.multiSelect
      ? { ...draft, selected: draft.selected.includes(label)
        ? draft.selected.filter((value) => value !== label)
        : [...draft.selected, label] }
      : { ...draft, selected: [label], customOn: false };
    updateDraft(question.id, next);
  };

  const pickCustom = (question: AskUserQuestion) => {
    if (locked || sending) return;
    const draft = drafts[question.id] ?? emptyDraft();
    const next = question.multiSelect
      ? { ...draft, customOn: !draft.customOn }
      : { ...draft, selected: [], customOn: true };
    updateDraft(question.id, next);
  };

  const editCustom = (question: AskUserQuestion, text: string) => {
    if (locked || sending) return;
    const draft = drafts[question.id] ?? emptyDraft();
    updateDraft(question.id, {
      ...draft,
      selected: question.multiSelect ? draft.selected : [],
      customOn: text.length > 0 || draft.customOn,
      customText: text,
    });
  };

  const complete = questions.length > 0 && questions.every((question) => valuesOf(drafts[question.id]).length > 0);
  const submit = async () => {
    if (locked || sending || !complete) return;
    const answers = questions.map((question) => ({ questionId: question.id, values: valuesOf(drafts[question.id]) }));
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/ask-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: agentId, answers }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; reason?: string };
      if (!response.ok || body.ok !== true) throw new Error(body.reason || `Request failed (${response.status})`);
      setSubmitted(true);
      setExpandedIds([]);
      snapshot({ submitted: true, expandedIds: [] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('askUser.submitFailed'));
    } finally {
      setSending(false);
    }
  };

  if (!argsReady && !answered && !expired) {
    return (
      <div className="ask-user-card ask-user-preparing" data-testid="ask-user-card" data-state="preparing">
        <Loader2 size={14} className="ask-user-spin" />
        <span>{t('askUser.preparing')}</span>
      </div>
    );
  }

  const allCollapsed = answered && expandedIds.length === 0;
  return (
    <div
      className="ask-user-group"
      data-testid="ask-user-card"
      data-ready="1"
      data-question-count={questions.length}
      data-state={allCollapsed ? 'resolved-collapsed' : answered ? 'resolved-expanded' : expired ? 'expired-unanswered' : sending ? 'submitting' : 'pending'}
    >
      {tc.error && <div className="ask-user-error" role="alert">{tc.error}</div>}
      {expired && !tc.error && <div className="ask-user-error">{t('askUser.unparseableHistory')}</div>}
      {questions.map((question, index) => {
        const multi = question.multiSelect === true;
        const draft = drafts[question.id] ?? emptyDraft();
        const values = shownValues(question);
        const expanded = !answered || expandedIds.includes(question.id);
        const title = displayQuestion(
          question,
          index,
          questions.length,
          t('askUser.noQuestion'),
          (current, total) => t('askUser.questionProgress', { current, total }),
        );
        const header = question.header?.trim();
        const options = normalizeOptions(question.options);
        const OptIcon = ({ on }: { on: boolean }) => {
          return (
            <span
              className={`ask-user-opt-icon${multi ? ' is-multi' : ' is-single'}${on ? ' is-on' : ''}`}
              aria-hidden="true"
            >
              {on && <Check size={11} strokeWidth={3} />}
            </span>
          );
        };
        if (answered && !expanded) {
          return (
            <section className="ask-user-question ask-user-collapsed" key={question.id}>
              <button
                type="button"
                className="ask-user-resolved-row"
                aria-expanded={false}
                onClick={() => {
                  const next = [...expandedIds, question.id];
                  setExpandedIds(next);
                  snapshot({ expandedIds: next });
                }}
              >
                <Check className="ask-user-resolved-check" size={13} aria-hidden="true" />
                <span className="ask-user-resolved-question" title={title}>
                  {header && <span className="ask-user-question-label">{header}</span>}
                  {title}
                </span>
                <span
                  className="ask-user-resolved-values"
                  title={formatAskUserValues(values, t('askUser.none'))}
                >
                  {formatAskUserValues(values, t('askUser.none'))}
                </span>
                <ChevronDown className="ask-user-resolved-chevron" size={14} aria-hidden="true" />
              </button>
            </section>
          );
        }
        return (
          <section className={`ask-user-question${multi ? ' is-multi' : ''}`} key={question.id}>
            {answered
              ? (
                <button
                  type="button"
                  className="ask-user-question-head is-toggle"
                  aria-expanded={true}
                  onClick={() => {
                    const next = expandedIds.filter((id) => id !== question.id);
                    setExpandedIds(next);
                    snapshot({ expandedIds: next });
                  }}
                >
                  <span className="ask-user-q">
                    {header && <span className="ask-user-question-label">{header}</span>}
                    {title}
                  </span>
                  <ChevronUp size={14} aria-hidden="true" />
                </button>
              )
              : (
                <div className="ask-user-question-head">
                  <div className="ask-user-q">
                    {header && <span className="ask-user-question-label">{header}</span>}
                    {title}
                  </div>
                </div>
              )}
            <div className="ask-user-opts" role={multi ? 'group' : 'radiogroup'}>
              {options.length === 0 && <div className="ask-user-empty">{t('askUser.noOptions')}</div>}
              {options.map((option) => {
                const checked = values.includes(option.label) || draft.selected.includes(option.label);
                return (
                  <button
                    type="button"
                    key={option.label}
                    className={`ask-user-opt${checked ? ' is-checked' : ''}${locked ? ' is-locked' : ''}`}
                    role={multi ? 'checkbox' : 'radio'}
                    aria-checked={checked}
                    disabled={locked || sending}
                    onClick={() => pick(question, option.label)}
                  >
                    <span className="ask-user-opt-body"><span className="ask-user-opt-label">{option.label}</span>{option.description && <span className="ask-user-opt-desc">{option.description}</span>}</span>
                    <OptIcon on={checked} />
                  </button>
                );
              })}
              <label
                className={`ask-user-opt ask-user-opt-custom${draft.customOn ? ' is-checked' : ''}${locked ? ' is-locked' : ''}`}
                data-testid="ask-user-other"
                onClick={(event) => {
                  if ((event.target as HTMLElement).tagName !== 'INPUT') pickCustom(question);
                }}
              >
                <span className="ask-user-other-label">{t('askUser.other')}</span>
                <input
                  type="text"
                  className="ask-user-custom-input"
                  data-testid="ask-user-custom-input"
                  placeholder={t('askUser.customPlaceholder')}
                  value={draft.customText}
                  disabled={locked || sending}
                  onFocus={() => { if (!draft.customOn) pickCustom(question); }}
                  onChange={(event) => editCustom(question, event.target.value)}
                />
                <OptIcon on={draft.customOn} />
              </label>
            </div>
          </section>
        );
      })}
      {error && <div className="ask-user-error" role="alert">{error}</div>}
      {!locked && (
        <div className="ask-user-actions">
          <button type="button" className="ask-user-submit" data-testid="ask-user-submit" disabled={!complete || sending} onClick={() => void submit()}>
            {sending ? t('askUser.submitting') : t('askUser.confirm')}
          </button>
        </div>
      )}
    </div>
  );
}
