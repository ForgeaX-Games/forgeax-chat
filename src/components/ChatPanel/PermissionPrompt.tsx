/** PermissionPrompt —— 命令审批 / 提问卡。
 *
 *  两种形态,都走同一条 permission-prompt → /permission-request 通道:
 *  - 普通命令(rm / git push…):显示命令 + 「允许 / 拒绝」,回 {allow}。
 *  - 选项提问:模型想问用户选项,这里渲染问题 + 选项,用户选完回
 *    {allow:true, answers:{[question]:label}},server 经 MCP 注入 updatedInput.answers
 *    给模型(否则只拿到 allow 会得到"没有答案")。
 *
 *  不点就一直挂着(server 10min 超时 fail-closed=拒绝);turn 中止会自动清卡。 */

import { useEffect, useState, type ReactElement } from 'react';
import { ShieldAlert, HelpCircle, Check, X, Loader2 } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useShellStore } from '@forgeax/interface/store';
import { usePendingPermission, clearPendingPermission } from '@forgeax/interface/lib/permission-stream';

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
  const { t } = useTranslation();
  const activeSid = useShellStore((s) => s.activeSid);
  const pending = usePendingPermission(activeSid);
  const [busy, setBusy] = useState(false);
  // AskUserQuestion: chosen labels per question index.
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  // 「记住本会话」勾选(仅 trust-gate ask 卡 canRemember 时可见)。
  const [remember, setRemember] = useState(false);

  useEffect(() => { setPicks({}); setBusy(false); setRemember(false); }, [pending?.reqId]);

  if (!activeSid || !pending) return null;

  const isAsk = pending.toolName === 'AskUserQuestion';
  const questions = isAsk ? readQuestions(pending.input) : [];
  const askable = isAsk && questions.length > 0;

  const reply = async (allow: boolean, answers?: Record<string, string>) => {
    if (busy) return;
    setBusy(true);
    const reqId = pending.reqId;
    clearPendingPermission(activeSid, reqId);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(activeSid)}/permission-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // remember:仅在 allow 时有意义 —— 让 host 记住本会话该 capability,同类免卡。
        body: JSON.stringify({ reqId, allow, ...(answers ? { answers } : {}), ...(allow && remember ? { remember: true } : {}) }),
      });
    } catch { /* server times out fail-closed if this never lands */ } finally {
      setBusy(false);
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
    questions.forEach((q, i) => { answers[q.question] = (picks[i] ?? []).join(', '); });
    void reply(true, answers);
  };

  const accent = askable ? 'var(--color-kind-cli-provider, #6db3f2)' : 'var(--color-status-amber, #d8a200)';

  return (
    <div
      role="alertdialog"
      aria-label={askable ? t('permission.askAriaLabel') : t('permission.commandAriaLabel')}
      style={{
        margin: '8px 10px', padding: '10px 12px', borderRadius: 10,
        border: `1px solid ${accent}`, background: 'var(--color-bg-elevated, #1c1f24)',
        display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: accent }}>
        {askable ? <HelpCircle size={15} /> : <ShieldAlert size={15} />}
        <span style={{ fontWeight: 600 }}>{askable ? t('permission.askTitle') : t('permission.commandTitle')}</span>
        {!askable && <span style={{ opacity: 0.6, fontWeight: 400 }}>· {pending.toolName}</span>}
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 }}>
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
          {pending.capability && (
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              {t('permission.capabilityLabel', { capability: pending.capability })}
            </div>
          )}
          <code style={{
            display: 'block', padding: '6px 8px', borderRadius: 6,
            background: 'var(--color-bg-base, #0e0e0e)', color: 'var(--color-text-primary, #ddd)',
            wordBreak: 'break-all', whiteSpace: 'pre-wrap',
          }}>{pending.command || pending.toolName}</code>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
            {pending.canRemember && (
              <label style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.85, cursor: 'pointer' }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {t('permission.rememberSession')}
              </label>
            )}
            <button onClick={() => reply(false)} disabled={busy} style={btn('ghost')}>
              {busy ? <Loader2 size={13} className="spin" /> : <X size={13} />} {t('permission.deny')}
            </button>
            <button onClick={() => reply(true)} disabled={busy} style={btn('primary', accent)}>
              {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t('permission.allow')}
            </button>
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
