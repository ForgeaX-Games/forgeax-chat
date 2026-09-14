/** Grouped Ask User card.
 *
 * Pending questions are answered one step at a time and submitted once as a group.
 * After the server accepts the answer, every question folds to a one-line
 * question + answer summary and may be reopened read-only.
 */
import { useEffect, useRef, useState } from 'react';
import './AskUserCard.css';
import { Check, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import type { ToolCall } from '../../../session-store';
import { askRequestId, batchAskCalls, type QuestionAnswer } from './ask-user-batch';
import {
  askUserHasAnswer as protocolAskUserHasAnswer,
  askUserHasCompleteAnswer,
  formatAskUserValues,
  isTerminalAskUser,
  isPendingAskUser,
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
  activeIndex?: number;
  expired?: boolean;
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
  if (!draft || (draft.customOn && !draft.customText.trim())) return [];
  return [
    ...draft.selected,
    ...(draft.customOn && draft.customText.trim() ? [draft.customText.trim()] : []),
  ];
}

export function displayQuestion(
  question: AskUserQuestion,
  index: number,
  count: number,
  fallback: string,
  progress: (current: number, total: number) => string,
): string {
  const text = question.question?.trim() || fallback;
  // A header (产物 / 厂商 / 输入) already names the slot. Numbering is for
  // untitled multi-asks only. count<=1 never numbered.
  if (count <= 1 || question.header?.trim()) return text;
  return `${progress(index + 1, count)} · ${text}`;
}

export const askUserHasAnswer = protocolAskUserHasAnswer;

export function AskUserCard({ tc, sid, agentId }: { tc: ToolCall; sid: string; agentId: string }) {
  // Remount local state when the owning request changes, even if the parent
  // reuses this position while switching sessions or agents.
  return <AskUserRequest key={JSON.stringify([sid, agentId, tc.callId])} tc={tc} sid={sid} agentId={agentId} />;
}

export class AskRequestExpiredError extends Error {}

export async function sendReply(sid: string, agentId: string, answers: QuestionAnswer[], requestId?: string) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/ask-reply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: agentId, answers, ...(requestId ? { requestId } : {}) }),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; reason?: string };
  if (response.ok && body.ok === false && body.reason === 'no-pending') throw new AskRequestExpiredError();
  if (!response.ok || body.ok !== true) throw new Error(body.reason || `Request failed (${response.status})`);
}

export function AskUserBatch(props: { calls: ToolCall[]; sid: string; agentId: string }) {
  return <ScopedAskUserBatch key={JSON.stringify([props.sid, props.agentId])} {...props} />;
}

function ScopedAskUserBatch({ calls, sid, agentId }: { calls: ToolCall[]; sid: string; agentId: string }) {
  const { t } = useTranslation();
  const [, refresh] = useState(0);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const keyOf = (callId: string) => `${sid}::${agentId}::${callId}`;
  const effective = calls.map(call => {
    const cached = askState.get(keyOf(call.callId));
    if (!isPendingAskUser(call) || (!cached?.submitted && !cached?.expired)) return call;
    return { ...call, status: 'done' as const, resultData: cached.submitted ? {
      ok: true, questions: normalizeAskUserQuestions(call.args).map(question => ({
        questionId: question.id, values: valuesOf(cached.drafts[question.id]),
      })),
    } : undefined };
  });
  const pending = effective.filter(isPendingAskUser);
  for (const call of pending) {
    const key = keyOf(call.callId);
    if (!askState.has(key)) askState.set(key, {
      questions: normalizeAskUserQuestions(call.args), drafts: {}, submitted: false, expandedIds: [],
    });
  }
  const batch = batchAskCalls(pending);
  const batchKey = keyOf(batch.call.callId);
  if (pending.length && !askState.has(batchKey)) {
    const drafts = Object.fromEntries(pending.flatMap(call => Object.entries(askState.get(keyOf(call.callId))?.drafts ?? {})
      .map(([id, draft]) => [JSON.stringify([call.callId, id]), draft])));
    askState.set(batchKey, { questions: batch.call.args.questions, drafts, submitted: false, expandedIds: [] });
  }
  const saveDrafts = (drafts: Record<string, QuestionDraft>) => {
    for (const call of pending) {
      const questions = normalizeAskUserQuestions(call.args);
      const key = keyOf(call.callId);
      askState.set(key, { submitted: false, expandedIds: [], ...askState.get(key), questions,
        drafts: Object.fromEntries(questions.flatMap(question => {
          const draft = drafts[JSON.stringify([call.callId, question.id])];
          return draft ? [[question.id, draft]] : [];
        })),
      });
    }
  };
  return <>
    {effective.filter(call => !isPendingAskUser(call)).map(call => <AskUserCard key={call.callId} tc={call} sid={sid} agentId={agentId} />)}
    {pending.length > 0 && <AskUserRequest key={batch.call.callId} tc={batch.call} sid={sid} agentId={agentId} onDraftChange={saveDrafts} submitting={busy} onSubmit={async answers => {
      setBusy(true);
      setError(false);
      try {
        for (const reply of batch.replies(answers)) {
          // Snapshot the submitted values independently of draft-change events.
          const cache: AskCache = askState.get(keyOf(reply.callId)) ?? {
            questions: [], expandedIds: [], submitted: false, drafts: Object.fromEntries(reply.answers.map(answer => [
              answer.questionId, { selected: answer.values, customOn: false, customText: '' },
            ])),
          };
          if (cache.submitted || cache.expired) continue;
          try {
            await sendReply(sid, agentId, reply.answers, reply.requestId);
            askState.set(keyOf(reply.callId), { ...cache, submitted: true });
          } catch (cause) {
            if (!(cause instanceof AskRequestExpiredError)) throw cause;
            askState.set(keyOf(reply.callId), { ...cache, expired: true });
          }
        }
      } catch (cause) {
        setError(true);
        throw cause;
      } finally { setBusy(false); refresh(value => value + 1); }
    }} />}
    {error && <div className="ask-user-error" role="alert">{t('askUser.submitFailed')}</div>}
  </>;
}

function AskUserRequest({ tc, sid, agentId, onSubmit, onDraftChange, submitting = false }: {
  tc: ToolCall; sid: string; agentId: string; onSubmit?: (answers: QuestionAnswer[]) => Promise<void>;
  onDraftChange?: (drafts: Record<string, QuestionDraft>) => void;
  submitting?: boolean;
}) {
  const { t } = useTranslation();
  const cacheKey = `${sid}::${agentId}::${tc.callId}`;
  const cached = askState.get(cacheKey);
  const normalized = normalizeAskUserQuestions(tc.args);
  const questions = normalized.length ? normalized : cached?.questions ?? [];
  const recordedAnswers = parseStructuredAskAnswer(tc.resultData ?? tc.result);
  const recordedDrafts = Object.fromEntries(recordedAnswers.filter(answer => answer.questionId).map(answer => [answer.questionId!, {
    selected: answer.values, customOn: false, customText: '',
  }]));
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({ ...recordedDrafts, ...cached?.drafts });
  const [submitted, setSubmitted] = useState(cached?.submitted ?? false);
  const [expandedIds, setExpandedIds] = useState<string[]>(cached?.expandedIds ?? []);
  const [activeIndex, setActiveIndex] = useState(cached?.activeIndex ?? 0);
  const currentIndex = Math.min(activeIndex, Math.max(0, questions.length - 1));
  const heading = useRef<HTMLDivElement>(null);
  const focusOnStep = useRef(false);
  useEffect(() => {
    if (focusOnStep.current) {
      heading.current?.focus();
      focusOnStep.current = false;
    }
  }, [currentIndex]);
  const [requestExpired, setRequestExpired] = useState(cached?.expired ?? false);
  const [localSending, setSending] = useState(false);
  const sending = localSending || submitting;
  const [error, setError] = useState<string | null>(null);

  const snapshot = (next: Partial<AskCache>) => {
    const current = askState.get(cacheKey) ?? {
      questions,
      drafts,
      submitted,
      expandedIds,
      activeIndex,
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
  const expired = !answered && (requestExpired || isTerminalAskUser(tc));
  const locked = answered || expired;
  const argsReady = questions.length > 0;

  const answerMap = new Map(structured.map((answer) => [answer.questionId, answer.values]));
  if (legacy.length && questions[0] && !answerMap.has(questions[0].id)) answerMap.set(questions[0].id, legacy);
  const shownValues = (question: AskUserQuestion) => answerMap.get(question.id) ?? valuesOf(drafts[question.id]);

  const goTo = (index: number) => {
    focusOnStep.current = true;
    setActiveIndex(index);
    snapshot({ activeIndex: index });
  };

  const updateDraft = (questionId: string, next: QuestionDraft) => {
    const updated = { ...drafts, [questionId]: next };
    setDrafts(updated);
    snapshot({ drafts: updated });
    onDraftChange?.(updated);
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
    if (!question.multiSelect && currentIndex < questions.length - 1) goTo(currentIndex + 1);
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

  const complete = questions.length > 0 && questions.every((question) => valuesOf(drafts[question.id] ?? recordedDrafts[question.id]).length > 0);
  const submit = async () => {
    if (locked || sending || !complete) return;
    const answers = questions.map((question) => ({ questionId: question.id, values: valuesOf(drafts[question.id] ?? recordedDrafts[question.id]) }));
    setSending(true);
    setError(null);
    try {
      if (onSubmit) await onSubmit(answers);
      else await sendReply(sid, agentId, answers, askRequestId(tc));
      setSubmitted(true);
      setExpandedIds([]);
      snapshot({ submitted: true, expandedIds: [] });
    } catch (cause) {
      if (cause instanceof AskRequestExpiredError) {
        setRequestExpired(true);
        snapshot({ expired: true });
      } else if (!onSubmit) setError(t('askUser.submitFailed')); // Batch owns its submission error.
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
      className={`ask-user-group${!locked ? ' ask-user-wizard' : ''}`}
      data-testid="ask-user-card"
      data-ready="1"
      data-question-count={questions.length}
      data-state={allCollapsed ? 'resolved-collapsed' : answered ? 'resolved-expanded' : expired ? 'expired-unanswered' : sending ? 'submitting' : 'pending'}
    >
      {expired && <div className="ask-user-expired" role="status">{t('askUser.expired')}</div>}
      {!locked && questions.length > 1 && (
        <nav className="ask-user-steps" aria-label={t('askUser.questionProgress', { current: currentIndex + 1, total: questions.length })}>
          {questions.map((question, index) => (
            <button type="button" key={question.id} aria-current={index === currentIndex ? 'step' : undefined}
              disabled={sending || (index > currentIndex && !valuesOf(drafts[question.id]).length)}
              onClick={() => goTo(index)} title={question.question}>
              <span>{valuesOf(drafts[question.id]).length ? <Check size={12} /> : index + 1}</span>
              <span>{question.header || String(index + 1)}</span>
            </button>
          ))}
          <span className="ask-user-progress" aria-live="polite">{currentIndex + 1} / {questions.length}</span>
        </nav>
      )}
      {questions.map((question, index) => {
        if (!locked && index !== currentIndex) return null;
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
                    {locked && header && <span className="ask-user-question-label">{header}</span>}
                    {title}
                  </span>
                  <ChevronUp size={14} aria-hidden="true" />
                </button>
              )
              : (
                <div className="ask-user-question-head" ref={heading} tabIndex={-1}>
                  <div className="ask-user-q">
                    {locked && header && <span className="ask-user-question-label">{header}</span>}
                    {title}
                  </div>
                </div>
              )}
            <div className="ask-user-opts" role={multi ? 'group' : 'radiogroup'} aria-label={title}
              onKeyDown={(event) => {
                if (event.target instanceof HTMLInputElement || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
                const index = buttons.indexOf(event.target as HTMLButtonElement);
                if (index < 0 || !buttons.length) return;
                event.preventDefault();
                const delta = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
                buttons[(index + delta + buttons.length) % buttons.length]?.focus();
              }}>

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
                    onClick={(event) => { if (event.detail < 2) pick(question, option.label); }}
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
        <>
          {complete && currentIndex === questions.length - 1 && questions.length > 1 && (
            <div className="ask-user-review">
              {questions.map((question, index) => (
                <button type="button" key={question.id} disabled={sending} onClick={() => goTo(index)}>
                  <Check size={12} />
                  {formatAskUserValues(valuesOf(drafts[question.id]), t('askUser.none'))}
                </button>
              ))}
            </div>
          )}
          <div className="ask-user-actions">
            {currentIndex > 0 && <button type="button" className="ask-user-back" disabled={sending} onClick={() => goTo(currentIndex - 1)}>
              <ChevronLeft size={14} />{t('onboarding.back')}
            </button>}
            {currentIndex < questions.length - 1
              ? <button type="button" className="ask-user-submit" disabled={sending || !valuesOf(drafts[questions[currentIndex].id]).length} onClick={() => goTo(currentIndex + 1)}>
                  {t('onboarding.next')}<ChevronRight size={14} />
                </button>
              : <button type="button" className="ask-user-submit" data-testid="ask-user-submit" disabled={!complete || sending} onClick={() => void submit()}>
                  {sending ? t('askUser.submitting') : t('askUser.confirm')}
                </button>}
          </div>
        </>
      )}
    </div>
  );
}
