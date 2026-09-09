/** PermissionPrompt —— 命令审批 / 提问卡。
 *
 *  两种形态,都走同一条 permission-prompt → /permission-request 通道:
 *  - 普通命令(rm / git push…):显示命令 + 「允许 / 拒绝」,回 {allow}。
 *  - 选项提问:模型想问用户选项,这里渲染问题 + 选项,用户选完回
 *    {allow:true, answers:{[question]:label}},server 经 MCP 注入 updatedInput.answers
 *    给模型(否则只拿到 allow 会得到"没有答案")。
 *
 *  不点就一直挂着(server 10min 超时 fail-closed=拒绝);turn 中止会自动清卡。
 *
 *  长命令默认折叠:展开后仍限高可滚,收起按钮永远贴在命令块下方(Allow/Deny 上方),
 *  避免整段命令把审批按钮顶出视口后无法收回。 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ShieldAlert, HelpCircle, Check, X, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useShellStore } from '@forgeax/interface/store';
import {
  usePendingPermission,
  useResolvedPermission,
  recordResolvedPermission,
  clearPendingPermission,
  isAskUserToolName,
} from '@forgeax/interface/lib/permission-stream';
import { commandPreview, permissionPresentation, safePermissionText } from './permission-presentation';
import './PermissionPrompt.css';


interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function readQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== 'object') return [];
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return [];
  return qs.filter((q): q is AskQuestion => !!q && typeof q === 'object' && typeof (q as AskQuestion).question === 'string');
}

export function PermissionPrompt(): ReactElement | null {
  const activeSid = useShellStore((s) => s.activeSid);
  return activeSid ? <SessionPermissions key={activeSid} activeSid={activeSid} /> : null;
}

interface Decision {
  reqId: string;
  allow: boolean;
  titleKey: string;
  target?: string;
}

function SessionPermissions({ activeSid }: { activeSid: string }): ReactElement {
  const { t } = useTranslation();
  const pending = usePendingPermission(activeSid);
  const resolvedAsk = useResolvedPermission(activeSid);
  const [decision, setDecision] = useState<Decision | null>(null);
  useEffect(() => {
    if (pending) setDecision(null);
  }, [pending?.reqId]);
  // Remount local selections and async ownership together when the request changes.
  return <>
    {decision && !pending && !resolvedAsk && <div className="permission-decision" role="status">
      {decision.allow ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
      <span>{t(decision.allow ? 'permission.allow' : 'permission.deny')} · {t(decision.titleKey)}</span>
      {decision.target && <code title={decision.target}>{decision.target}</code>}
    </div>}
    <PermissionCard key={JSON.stringify([activeSid, pending?.reqId, pending?.toolName])}
      activeSid={activeSid} pending={pending} resolvedAsk={resolvedAsk} onDecision={setDecision} />
  </>;
}

function PermissionCard({ activeSid, pending, resolvedAsk, onDecision }: {
  activeSid: string;
  pending: ReturnType<typeof usePendingPermission>;
  resolvedAsk: ReturnType<typeof useResolvedPermission>;
  onDecision: (decision: Decision) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [busyDecision, setBusyDecision] = useState<boolean | null>(null);
  // AskUserQuestion: chosen labels per question index.
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  // 「记住本会话」勾选(仅 trust-gate ask 卡 canRemember 时可见)。
  const [remember, setRemember] = useState(false);
  // Long command body fold — reset per request so a new prompt starts collapsed.
  const [cmdExpanded, setCmdExpanded] = useState(false);
  const [resolvedExpanded, setResolvedExpanded] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  if (!pending) {
    if (!resolvedAsk || resolvedAsk.sid !== activeSid) return null;
    const summary = resolvedAsk.questions
      .map((item) => `${item.question}: ${item.values.join('; ')}`)
      .join(' · ');
    return (
      <div
        role="status"
        aria-label={t('permission.askTitle')}
        style={{
          margin: '8px 10px', padding: '8px 12px', borderRadius: 10,
          border: '1px solid var(--color-kind-cli-provider, #6db3f2)',
          background: 'var(--color-bg-elevated, #1c1f24)', fontSize: 13,
        }}
      >
        <button
          type="button"
          aria-expanded={resolvedExpanded}
          onClick={() => setResolvedExpanded((value) => !value)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
        >
          <Check size={14} />
          <span style={{ flex: 1 }}>{summary}</span>
          {resolvedExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {resolvedExpanded && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-border, #444)' }}>
            {resolvedAsk.questions.map((item) => (
              <div key={item.question}>
                <div style={{ fontWeight: 600 }}>{item.question}</div>
                <div style={{ opacity: 0.8 }}>{item.values.join('; ')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const isAsk = isAskUserToolName(pending.toolName);
  const questions = isAsk ? readQuestions(pending.input) : [];
  const askable = isAsk && questions.length > 0;

  const reply = async (
    allow: boolean,
    answers?: Record<string, string>,
    answerValues?: Record<string, string[]>,
  ) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setBusyDecision(allow);
    setPermissionError(null);
    const reqId = pending.reqId;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(activeSid)}/permission-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // remember:仅在 allow 时有意义 —— 让 host 记住本会话该 capability,同类免卡。
        body: JSON.stringify({
          reqId,
          allow,
          ...(answers ? { answers } : {}),
          ...(answerValues ? { answerValues } : {}),
          ...(allow && remember ? { remember: true } : {}),
        }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; reason?: string };
      if (!mounted.current) return;
      if (!response.ok || body.ok !== true) throw new Error(body.reason || `Request failed (${response.status})`);
      if (!isAsk) {
        const result = permissionPresentation(pending);
        onDecision({ reqId, allow, titleKey: result.titleKey, target: result.target });
      }
      if (allow && answers && isAsk) {
        recordResolvedPermission(activeSid, {
          reqId,
          toolName: pending.toolName,
          questions: questions.map((question, index) => ({
            question: question.question,
            values: picks[index] ?? [],
          })),
        });
        setResolvedExpanded(false);
      }
      clearPendingPermission(activeSid, reqId);
    } catch {
      // Keep the pending card and the user's selections editable. The server
      // may still be waiting, and a transient UI/network failure is retryable.
      if (mounted.current) setPermissionError(t('permission.submitFailed'));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicks((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qi]: [label] };
    });
  };

  const allAnswered = askable && questions.every((_, i) => (picks[i]?.length ?? 0) > 0);
  const submitAnswers = () => {
    const answers: Record<string, string> = {};
    const answerValues: Record<string, string[]> = {};
    questions.forEach((q, i) => {
      const values = picks[i] ?? [];
      answers[q.question] = values.join(', ');
      answerValues[q.question] = values;
    });
    void reply(true, answers, answerValues);
  };

  const accent = askable ? 'var(--color-kind-cli-provider, #6db3f2)' : 'var(--color-status-amber, #d8a200)';
  const presentation = permissionPresentation(pending);
  const preview = commandPreview(presentation.target ?? '');

  return (
    <div
      role="region"
      className="permission-card"
      aria-busy={busy}
      aria-label={askable ? t('permission.askAriaLabel') : t('permission.commandAriaLabel')}
    >
      <div className="permission-card__header">
        <span className="permission-card__icon" style={{ color: accent }} aria-hidden="true">
          {askable ? <HelpCircle size={15} /> : <ShieldAlert size={15} />}
        </span>
        <span className="permission-card__title">{askable ? t('permission.askTitle') : t(presentation.titleKey)}</span>
        {pending.agent && <span className="permission-card__agent">
          <span>{t('permission.agentLabel')} · </span>{safePermissionText(pending.agent).slice(0, 100)}
        </span>}
      </div>

      {askable ? (
        <>
          {questions.map((q, qi) => (
            <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ fontWeight: 500 }}>{q.question}{q.multiSelect ? t('permission.multiSelectHint') : ''}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(q.options ?? []).map((opt) => {
                  const sel = (picks[qi] ?? []).includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={busy}
                      aria-pressed={sel}
                      title={opt.description}
                      onClick={() => toggle(qi, opt.label, q.multiSelect === true)}
                      style={{
                        cursor: 'pointer', padding: '4px 10px', borderRadius: 6, fontSize: 12,
                        border: `1px solid ${sel ? accent : 'var(--color-border, #444)'}`,
                        background: sel ? accent : 'transparent',
                        color: sel ? '#0e1116' : 'var(--color-text-primary, #ddd)',
                        fontWeight: sel ? 600 : 400,
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {permissionError && <div role="alert" style={{ color: 'var(--color-status-red, #e06c75)', fontSize: 12 }}>{permissionError}</div>}
          <div className="permission-card__footer">
            {!allAnswered && (
              <span style={{ marginRight: 'auto', fontSize: 11, opacity: 0.6 }}>
                {t('permission.selectBeforeSubmit')}
              </span>
            )}
            <button onClick={() => reply(false)} disabled={busy} style={btn('ghost')}>
              {busy ? <Loader2 size={13} className="spin" /> : <X size={13} />} {t('common.cancel')}
            </button>
            <button onClick={submitAnswers} disabled={busy || !allAnswered} style={btn('primary', accent, !allAnswered)}>
              {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t('permission.submit')}
            </button>
          </div>
        </>
      ) : (
        <>
          {presentation.target ? <code className="permission-card__target">{cmdExpanded ? presentation.target : preview.text}</code>
            : <span className="permission-card__muted">{t('permission.targetUnavailable')}</span>}
          {preview.foldable && <button type="button" className="permission-card__disclosure"
            aria-expanded={cmdExpanded} onClick={() => setCmdExpanded((value) => !value)}>
            {cmdExpanded ? t('permission.collapse') : t('permission.expand', { count: presentation.target!.length })}
          </button>}
          {presentation.reason && <p className="permission-card__reason">
            <span className="permission-card__muted">{t('permission.reasonLabel')} · </span>{presentation.reason}
          </p>}
          <details className="permission-card__details">
            <summary>{t('permission.details')}</summary>
            <code>{presentation.tool}</code>
            {presentation.capability && <span>{t('permission.capabilityLabel', { capability: presentation.capability })}</span>}
          </details>
          {permissionError && <div role="alert" className="permission-card__error">{permissionError}</div>}
          <div className="permission-card__footer">
            {pending.canRemember && (
              <label className="permission-card__remember">
                <input type="checkbox" disabled={busy} checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>{t('permission.rememberSession')}</span>
              </label>
            )}
            <div className="permission-card__actions">
              <button type="button" onClick={() => reply(false)} disabled={busy} className="permission-card__button">
                {busy && busyDecision === false ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />} {t('permission.deny')}
              </button>
              <button type="button" onClick={() => reply(true)} disabled={busy} className="permission-card__button permission-card__button--allow">
                {busy && busyDecision === true ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} {t('permission.allow')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function btn(kind: 'ghost' | 'primary', accent?: string, disabled?: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'not-allowed' : 'pointer',
    padding: '5px 12px', borderRadius: 6, fontSize: 12,
  };
  if (kind === 'ghost') {
    return { ...base, border: '1px solid var(--color-border, #444)', background: 'transparent', color: 'var(--color-text-secondary, #aaa)' };
  }
  return { ...base, border: 'none', background: accent ?? '#d8a200', color: '#0e1116', fontWeight: 600, opacity: disabled ? 0.5 : 1 };
}
