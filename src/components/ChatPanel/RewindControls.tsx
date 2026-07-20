/** RewindControls —— checkpoint 回退点的 UI 件(Cursor 软回退语义)。
 *
 *  - RewindConfirmDialog:点 user 气泡「⟲ 回到这里」后的确认浮层;打开即拉
 *    rewind/preview 展示「N 个文件,+X/−Y 行」+ 逐文件明细;三选一(代码和会话 /
 *    仅会话 / 仅代码),无文件变化时默认仅会话。
 *  - RewindInlineEditor / BubbleEditInline:就地编辑器(回退后 / 点气泡进编辑态)。
 *  - RewindBanner:挂起态分隔线「已回退到此处 ─ Redo checkpoint」+ 手改保留
 *    通知(默认保留脏文件,单动作覆盖 + 可撤销,零弹窗)。 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { useChatStore, useActiveStreaming, type PendingRewind, type RewindDirtyNotice } from '../../session-store';
import { rewindPreview, type RewindPreview, type FileDiffStat } from '@forgeax/interface/lib/checkpoint-api';

type RewindMode = 'both' | 'conversation' | 'code';

/** 逐文件变更明细列表:RewindConfirmDialog 与 BubbleEditInline 共用。
 *  文件多时容器内滚动。 */
export function FileDiffList({ files }: { files: FileDiffStat[] }) {
  if (files.length === 0) return null;
  const badge = (s: FileDiffStat['status']) =>
    s === 'added' ? 'A' : s === 'deleted' ? 'D' : 'M';
  return (
    <div className="rw-file-list">
      {files.map((f) => (
        <div className="rw-file-row" key={`${f.status}:${f.path}`}>
          <span className={`rw-file-status rw-fs-${f.status}`}>{badge(f.status)}</span>
          <span className="rw-file-path" title={f.path}>{f.path}</span>
          {f.binary
            ? <span className="rw-file-binary">binary</span>
            : (f.insertions > 0 || f.deletions > 0) && (
                <span className="rw-diffstat">
                  <em className="ins">+{f.insertions}</em>{' '}
                  <em className="del">−{f.deletions}</em>
                </span>
              )}
        </div>
      ))}
    </div>
  );
}

export function RewindConfirmDialog({
  sid,
  msgId,
  hasCode,
  onClose,
}: {
  sid: string;
  msgId: string;
  hasCode: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const performRewind = useChatStore((s) => s.performRewind);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const isStreaming = useActiveStreaming();
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rewindPreview(sid, msgId)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [sid, msgId]);

  const fileCount = preview?.filesChanged.length ?? 0;
  const codeAvailable = hasCode && fileCount > 0;

  const run = async (mode: RewindMode) => {
    setBusy(true);
    setError(null);
    try {
      // 模型还在回复时点回退 = 放弃当前这轮:先立即终止在飞回复(cancelStream 同
      // Stop 键,CLI/原生两路都断),再打回退快照。空闲时 cancelStream 为安全 no-op。
      if (isStreaming) cancelStream();
      await performRewind(sid, msgId, mode);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="rw-overlay" onClick={onClose}>
      <div className="rw-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rw-title">{t('rewind.confirmTitle')}</div>
        <div className="rw-preview">
          {error
            ? <span className="rw-err">{error}</span>
            : preview === null
              ? t('rewind.computingDiff')
              : fileCount === 0
                ? t('rewind.noFileChanges')
                : <>{t('rewind.codeWillRevertPrefix')} <b>{fileCount}</b> {t('rewind.codeWillRevertSuffix')}
                    {(preview.insertions > 0 || preview.deletions > 0) && (
                      <span className="rw-diffstat">
                        {' '}<em className="ins">+{preview.insertions}</em>
                        {' '}<em className="del">−{preview.deletions}</em>
                      </span>
                    )}
                    {preview.binaryOrLarge > 0 && <span>{t('rewind.binaryLargeNote', { count: preview.binaryOrLarge })}</span>}
                  </>}
        </div>
        {preview && fileCount > 0 && <FileDiffList files={preview.files ?? []} />}
        <div className="rw-actions">
          {codeAvailable && (
            <button disabled={busy} className="rw-btn rw-primary" onClick={() => void run('both')}>
              {t('rewind.revertCodeAndConversation')}
            </button>
          )}
          <button
            disabled={busy}
            className={`rw-btn ${codeAvailable ? '' : 'rw-primary'}`}
            onClick={() => void run('conversation')}
          >
            {t('rewind.revertConversationOnly')}
          </button>
          {codeAvailable && (
            <button disabled={busy} className="rw-btn" onClick={() => void run('code')}>
              {t('rewind.revertCodeOnly')}
            </button>
          )}
          <button disabled={busy} className="rw-btn rw-ghost" onClick={onClose}>{t('common.cancel')}</button>
        </div>
        <div className="rw-hint">{t('rewind.confirmHint')}</div>
      </div>
    </div>
  );
}

/** 内联编辑框(Cursor 软回退核心交互):会话回退后,目标 user 消息原地变成一个
 *  可编辑输入框(预填原文),它之后的消息变灰。用户改完发送 = 定格 + 新 turn;
 *  右下角「Redo checkpoint」= 恢复(cancel)。 */
export function RewindInlineEditor({ sid, initialText, isStreaming }: {
  sid: string;
  initialText: string;
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const sendMessage = useChatStore((s) => s.sendMessage);
  const performRewindCancel = useChatStore((s) => s.performRewindCancel);
  const [text, setText] = useState(initialText);
  // 仅防发送重复触发的瞬时 ref —— 不用 state 当永久闸,否则 enqueue 后会把
  // Redo 也一起锁死(这正是「点 Redo 没反应」的根因)。
  const sendingRef = useRef(false);
  const [redoErr, setRedoErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 自动聚焦 + 光标置末 + 高度自适应
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const msg = text.trim();
    if (!msg || sendingRef.current) return;
    sendingRef.current = true;
    // 发送即定格:server /messages 先 finalizePending 再打新快照,被回退段由
    // rewind:finalized 从列表移除(本编辑器随之卸载)。模型仍在回复时立即终止上一轮
    // (handoff:'steer' = 中断在飞 turn 并把本条作为下一轮),而非排队等它跑完。
    void sendMessage(msg, isStreaming ? { handoff: 'steer' } : undefined);
  };

  // Redo(恢复):始终可点。失败(网络 / 已定格 409)不静默 —— 既给提示,也
  // 主动清掉本地挂起态(服务端已经不是 pending,本地不该继续显示编辑框)。
  const redo = () => {
    setRedoErr(null);
    void performRewindCancel(sid).catch((e: Error) => setRedoErr(e?.message ?? t('rewind.restoreFailed')));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey
      && !e.nativeEvent.isComposing && (e.nativeEvent as { keyCode?: number }).keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="rw-inline">
      <div className="rw-inline-box">
        <textarea
          ref={taRef}
          className="rw-inline-input"
          value={text}
          rows={1}
          placeholder={t('rewind.inlinePlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="rw-inline-actions">
          <button
            type="button"
            className="rw-inline-send"
            disabled={!text.trim()}
            title={t('rewind.resendFromHere')}
            onClick={submit}
          ><ArrowUp size={14} strokeWidth={2.4} /></button>
        </div>
      </div>
      <div className="rw-inline-foot">
        {redoErr && <span className="rw-err">{redoErr}</span>}
        <button type="button" className="rw-redo-link" onClick={redo}>{t('rewind.redoCheckpoint')}</button>
      </div>
    </div>
  );
}

/** 消息编辑态:点自己已发送的消息 → 原地变可编辑框(预填原文),其后消息置灰,
 *  但**此刻不回退**。发送时拉 preview:若会回退文件,弹「回退并发送 / 取消」打断;
 *  确认后才 performRewind(回退文件+会话)+ sendMessage(发新消息触发定格)。无文件
 *  变更则直接仅回退会话 + 发。与 ⟲ 即时回退(4 选项)并存。 */
export function BubbleEditInline({ sid, msgId, initialText, hasCode, isStreaming, onCancel }: {
  sid: string;
  msgId: string;
  initialText: string;
  hasCode: boolean;
  isStreaming: boolean;
  /** 非发送退出编辑态(blur / 点「取消编辑」)。draft = 当前输入框内容,
   *  由上层决定是否按 sid:msgId 暂存(仅内存),供下次重新编辑回填。 */
  onCancel: (draft: string) => void;
}) {
  const { t } = useTranslation();
  const performRewind = useChatStore((s) => s.performRewind);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const [text, setText] = useState(initialText);
  const [phase, setPhase] = useState<'editing' | 'confirming'>('editing');
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sendingRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  // 发送 = 回退到本消息 + 发新消息。mode 由是否真有文件变更决定:有则连代码一起回退
  // (用户已在确认弹窗点过「回退并发送」);无则仅回退会话。
  const doRewindAndSend = async (mode: RewindMode) => {
    if (sendingRef.current) return;
    const msg = text.trim();
    if (!msg) return;
    sendingRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await performRewind(sid, msgId, mode);
      // 发送即触发 server finalizePending 定格;本组件随 rewind:finalized 卸载。
      // 模型仍在回复时立即终止上一轮(handoff:'steer' 中断在飞 turn 并把本条作为下一轮),不排队等它跑完。
      await sendMessage(msg, isStreaming ? { handoff: 'steer' } : undefined);
    } catch (e) {
      sendingRef.current = false;
      setBusy(false);
      setErr((e as Error).message);
    }
  };

  const submit = () => {
    const msg = text.trim();
    if (!msg || busy || sendingRef.current) return;
    setBusy(true);
    setErr(null);
    rewindPreview(sid, msgId)
      .then((p) => {
        setBusy(false);
        const fileCount = p.filesChanged.length;
        if (!hasCode || fileCount === 0) {
          // 无文件会回退 —— 直接仅回退会话 + 发,不打断。
          void doRewindAndSend('conversation');
        } else {
          setPreview(p);
          setPhase('confirming');
        }
      })
      .catch((e: Error) => { setBusy(false); setErr(e.message); });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (phase !== 'editing') return;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey
      && !e.nativeEvent.isComposing && (e.nativeEvent as { keyCode?: number }).keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };

  // 失去焦点即退出编辑态(对齐 WorkspaceTabs 重命名):点到编辑器之外 = 不想改了。
  //   - 确认浮层 / 发送中(phase!=='editing' || busy)不退出 —— 那是流程中,不是放弃。
  //   - 焦点仍落在编辑器内部(发送按钮 / 取消链接等)→ 不算"失去焦点",忽略。
  //     发送按钮额外用 onMouseDown preventDefault 兜底:WebKit(桌面 WKWebView)鼠标
  //     点按钮不给焦点,relatedTarget=null,光靠 contains 判不住,会误退出。
  const onBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    if (phase !== 'editing' || busy || sendingRef.current) return;
    const next = e.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    onCancel(text);
  };

  return (
    <div className="rw-inline rw-edit-inline" ref={rootRef}>
      <div className="rw-inline-box">
        <textarea
          ref={taRef}
          className="rw-inline-input"
          value={text}
          rows={1}
          placeholder={t('rewind.inlinePlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          disabled={busy && phase === 'editing'}
        />
        <div className="rw-inline-actions">
          <button
            type="button"
            className="rw-inline-send"
            disabled={!text.trim() || busy}
            title={t('rewind.editAndSendFromHere')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={submit}
          ><ArrowUp size={14} strokeWidth={2.4} /></button>
        </div>
      </div>
      <div className="rw-inline-foot">
        {err && <span className="rw-err">{err}</span>}
        <button type="button" className="rw-redo-link" disabled={busy} onClick={() => onCancel(text)}>{t('rewind.cancelEdit')}</button>
      </div>

      {phase === 'confirming' && preview && (
        <div className="rw-edit-confirm-overlay" onClick={() => { if (!busy) { setPhase('editing'); setPreview(null); } }}>
          <div className="rw-edit-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="rw-title">{t('rewind.sendWillRevertTitle')}</div>
            <div className="rw-preview">
              {t('rewind.codeWillRevertPrefix')} <b>{preview.filesChanged.length}</b> {t('rewind.codeWillRevertSuffix')}
              {(preview.insertions > 0 || preview.deletions > 0) && (
                <span className="rw-diffstat">
                  {' '}<em className="ins">+{preview.insertions}</em>
                  {' '}<em className="del">−{preview.deletions}</em>
                </span>
              )}
              {preview.binaryOrLarge > 0 && <span>{t('rewind.binaryLargeNote', { count: preview.binaryOrLarge })}</span>}
            </div>
            <FileDiffList files={preview.files ?? []} />
            <div className="rw-actions">
              <button disabled={busy} className="rw-btn rw-primary" onClick={() => void doRewindAndSend(hasCode ? 'both' : 'conversation')}>
                {t('rewind.revertAndSend')}
              </button>
              <button disabled={busy} className="rw-btn rw-ghost" onClick={() => { setPhase('editing'); setPreview(null); }}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 挂起态分隔线 + Redo。mode='code' 时由 ChatPanel 渲染在线程底部(消息列表
 *  不动);否则渲染在被回退段(置灰区)顶部。脏文件通知在 DirtyNoticeBar。 */
export function RewindBanner({ sid, pending }: {
  sid: string;
  pending: NonNullable<PendingRewind>;
}) {
  const { t } = useTranslation();
  const performRewindCancel = useChatStore((s) => s.performRewindCancel);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="rw-banner">
      <div className="rw-banner-row">
        <span className="rw-banner-label">
          {pending.mode === 'code' ? t('rewind.revertedHereCodeOnly') : t('rewind.revertedHere')}
        </span>
        <button
          className="rw-btn rw-redo"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            void performRewindCancel(sid)
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {t('rewind.redoCheckpointRestore')}
        </button>
      </div>
      {err && <div className="rw-banner-row rw-err">{err}</div>}
    </div>
  );
}

/** 手改保留/覆盖通知:单动作 + 可撤销,零弹窗。独立于挂起态 ——
 *  「恢复(cancel)」后仍可操作(用户核心场景)。 */
export function DirtyNoticeBar({ sid, notice }: {
  sid: string;
  notice: NonNullable<RewindDirtyNotice>;
}) {
  const { t } = useTranslation();
  const performOverwriteDirty = useChatStore((s) => s.performOverwriteDirty);
  const performUndoOverwrite = useChatStore((s) => s.performUndoOverwrite);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const wrap = (fn: (sid: string) => Promise<void>) => () => {
    setBusy(true);
    setErr(null);
    void fn(sid).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };

  return (
    <div className="rw-banner rw-dirty-bar">
      {notice.keptDirty.length > 0 && (
        <div className="rw-banner-row rw-dirty">
          <span>{t('rewind.keptDirtyFiles', { count: notice.keptDirty.length })}</span>
          <button className="rw-btn rw-ghost" disabled={busy} onClick={wrap(performOverwriteDirty)}>
            {t('rewind.revertTheseFilesToo')}
          </button>
        </div>
      )}
      {notice.overwrite && notice.overwrite.files.length > 0 && (
        <div className="rw-banner-row rw-dirty">
          <span>{t('rewind.overwroteDirtyFiles', { count: notice.overwrite.files.length })}</span>
          <button className="rw-btn rw-ghost" disabled={busy} onClick={wrap(performUndoOverwrite)}>
            {t('rewind.undo')}
          </button>
        </div>
      )}
      {err && <div className="rw-banner-row rw-err">{err}</div>}
    </div>
  );
}
