/** AskUserCard —— 渲染 `ask_user` 工具的可点选问题卡（单选 radio / 多选 checkbox）。
 *
 *  数据来源：复用标准 tool 段（ForgeCard segments），从 `tc.args` 读
 *  question/header/options/multiSelect —— 这些在 hook:toolCall 时已随 tool 段
 *  到前端（见 .claude/docs/需求/ask-user-tool-需求单.md）。
 *
 *  「其他…」自填：卡片末尾固定带一个自定义项，选中后展开文本框，用户填的内容
 *  作为一个选中值参与回传（单选时它就是唯一答案；多选时与勾选项并列）。server
 *  端不做选项白名单，自填文本如实带回（ask_user.ts）。
 *
 *  作答回传：用户点「确认」→ POST /api/sessions/:sid/ask-reply
 *  { agent, values }，server 端 resolve 工具阻塞的 Promise（core/
 *  ask-user-registry.ts）。tool 段随后转 status:'done'，卡片切只读「已选择」态。 */

import { useState } from 'react';
import { Check, CheckSquare, Square, Circle, CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import type { ToolCall } from '../../../session-store';

interface AskOption {
  label: string;
  description?: string;
}

interface AskUserArgs {
  question?: string;
  header?: string;
  options?: Array<AskOption | string>;
  multiSelect?: boolean;
}

function normalizeOptions(raw: AskUserArgs['options']): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  for (const it of raw) {
    if (typeof it === 'string') out.push({ label: it });
    else if (it && typeof it === 'object' && typeof it.label === 'string') {
      out.push({ label: it.label, description: it.description });
    }
  }
  return out;
}

interface AskCache {
  selected: string[];
  customOn: boolean;
  customText: string;
  submitted: boolean;
}

/** 选择状态按 callId 持久化在组件外 —— agent 被 ask 阻塞期间,聊天气泡会因
 *  无关 store 更新(spinner / context% / 其它 tab)而频繁重渲,某些路径下会让
 *  AskUserCard 重挂载,本地 useState 被清空。把作答状态缓存在 module 级 Map
 *  (键=callId),重挂载时回填,作答就不会丢。 */
const askState = new Map<string, AskCache>();

export function AskUserCard({
  tc,
  sid,
  agentId,
}: {
  tc: ToolCall;
  sid: string;
  agentId: string;
}) {
  const { t } = useTranslation();
  const args = (tc.args ?? {}) as AskUserArgs;
  const question = typeof args.question === 'string' ? args.question : t('askUser.noQuestion');
  const header = typeof args.header === 'string' ? args.header : '';
  const multi = args.multiSelect === true;
  const options = normalizeOptions(args.options);

  const cacheKey = tc.callId;
  const cached = askState.get(cacheKey);
  const [selected, setSelected] = useState<string[]>(cached?.selected ?? []);
  const [customOn, setCustomOn] = useState<boolean>(cached?.customOn ?? false);
  const [customText, setCustomText] = useState<string>(cached?.customText ?? '');
  const [submitted, setSubmitted] = useState<boolean>(cached?.submitted ?? false);
  const [sending, setSending] = useState(false);

  // 任何状态变化都写穿到 module 缓存(显式传全量快照,不依赖异步 state)。
  const persist = (s: string[], c: boolean, txt: string, sub: boolean) =>
    askState.set(cacheKey, { selected: s, customOn: c, customText: txt, submitted: sub });

  // tool 段一旦 done/error,说明 server 已 resolve(可能来自本端或超时),锁卡片。
  const resolved = submitted || tc.status === 'done' || tc.status === 'error';

  // LLM 流式吐 tool 调用时,args 先是一段「不完整 JSON 字符串」,解析不出对象 ——
  // 此时读 question/options 全是 undefined,会闪一下「(无问题)+缺选项」。等
  // hook:toolCall(或某个 chunk 把 JSON 收尾)后 args 才是完整对象。所以只有
  // args 已是对象时才渲染结构化卡片,否则先给个「准备中」占位(跟普通 tool chip
  // 流式期只显示工具名同理 —— 不拿残缺 args 渲染结构化内容)。
  const argsReady = !!tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args);

  const customVal = customOn ? customText.trim() : '';
  const effective = [...selected, ...(customVal ? [customVal] : [])];

  // 刷新后:本地选择 state(及 module 缓存)都没了,但工具结果已落 ledger 并在
  // 重放时填进 tc.result(message-builder.ts)。从结果文本里抽出 「…」 里的答案,
  // 作为「已选择」的回填来源,这样刷新后仍显示用户当时选了什么(含自填)。
  const answeredFromResult =
    typeof tc.result === 'string'
      ? [...tc.result.matchAll(/「([^」]*)」/g)].map((m) => m[1]!).filter(Boolean)
      : [];
  const shownVals = effective.length > 0 ? effective : answeredFromResult;

  const pick = (label: string) => {
    if (resolved) return;
    if (multi) {
      const next = selected.includes(label) ? selected.filter((v) => v !== label) : [...selected, label];
      setSelected(next);
      persist(next, customOn, customText, submitted);
    } else {
      setSelected([label]);
      setCustomOn(false);
      persist([label], false, customText, submitted);
    }
  };

  const pickCustom = () => {
    if (resolved) return;
    if (multi) {
      const next = !customOn;
      setCustomOn(next);
      persist(selected, next, customText, submitted);
    } else {
      // 单选:选「其他」即清空预设选项,自填文本成为唯一答案。
      setSelected([]);
      setCustomOn(true);
      persist([], true, customText, submitted);
    }
  };

  const editCustom = (txt: string) => {
    if (resolved) return;
    setCustomText(txt);
    persist(selected, customOn, txt, submitted);
  };

  const submit = async () => {
    if (resolved || sending || effective.length === 0) return;
    setSending(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sid)}/ask-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: agentId, values: effective }),
      });
      setSubmitted(true);
      persist(selected, customOn, customText, true);
    } catch {
      // 网络失败:解锁让用户重试(server 端 ask 仍 pending)。
      setSending(false);
      return;
    }
    setSending(false);
  };

  // args 还在流式拼接 —— 先占位,别用残缺 args 渲染结构化内容(避免「无问题」闪烁)。
  if (!argsReady) {
    return (
      <div className="ask-user-card ask-user-preparing" data-testid="ask-user-card" data-ready="0">
        <Loader2 size={14} className="ask-user-spin" />
        <span>{t('askUser.preparing')}</span>
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="ask-user-card" data-testid="ask-user-card" data-ready="1">
        <div className="ask-user-q">{question}</div>
        <div className="ask-user-empty">{t('askUser.noOptions')}</div>
      </div>
    );
  }

  const OptIcon = ({ on }: { on: boolean }) => {
    const I = multi ? (on ? CheckSquare : Square) : on ? CheckCircle2 : Circle;
    return <I size={15} className="ask-user-opt-icon" />;
  };

  return (
    <div className="ask-user-card" data-testid="ask-user-card" data-ready="1" data-multi={multi ? '1' : '0'}>
      <div className="ask-user-head">
        {header && <span className="ask-user-chip">{header}</span>}
        <span className="ask-user-mode">{multi ? t('askUser.multiSelect') : t('askUser.singleSelect')}</span>
      </div>
      <div className="ask-user-q">{question}</div>

      <div className="ask-user-opts" role={multi ? 'group' : 'radiogroup'}>
        {options.map((opt) => {
          const checked = selected.includes(opt.label);
          return (
            <button
              type="button"
              key={opt.label}
              className={`ask-user-opt${checked ? ' is-checked' : ''}${resolved ? ' is-locked' : ''}`}
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={checked}
              disabled={resolved}
              onClick={() => pick(opt.label)}
            >
              <OptIcon on={checked} />
              <span className="ask-user-opt-body">
                <span className="ask-user-opt-label">{opt.label}</span>
                {opt.description && <span className="ask-user-opt-desc">{opt.description}</span>}
              </span>
            </button>
          );
        })}

        {/* 固定自填项 —— 选中后展开文本框 */}
        <button
          type="button"
          className={`ask-user-opt ask-user-opt-custom${customOn ? ' is-checked' : ''}${resolved ? ' is-locked' : ''}`}
          role={multi ? 'checkbox' : 'radio'}
          aria-checked={customOn}
          data-testid="ask-user-other"
          disabled={resolved}
          onClick={pickCustom}
        >
          <OptIcon on={customOn} />
          <span className="ask-user-opt-body">
            <span className="ask-user-opt-label">{t('askUser.other')}</span>
            <span className="ask-user-opt-desc">{t('askUser.otherDesc')}</span>
          </span>
        </button>
        {customOn && (
          <input
            type="text"
            className="ask-user-custom-input"
            data-testid="ask-user-custom-input"
            placeholder={t('askUser.customPlaceholder')}
            value={customText}
            disabled={resolved}
            autoFocus
            onChange={(e) => editCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !multi && effective.length > 0) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        )}
      </div>

      {resolved ? (
        <div className="ask-user-resolved">
          <Check size={13} /> {t('askUser.selected', { values: shownVals.length > 0 ? shownVals.join('、') : t('askUser.none') })}
        </div>
      ) : (
        <button
          type="button"
          className="ask-user-submit"
          data-testid="ask-user-submit"
          disabled={effective.length === 0 || sending}
          onClick={submit}
        >
          {sending ? t('askUser.submitting') : t('askUser.confirm')}
        </button>
      )}
    </div>
  );
}
