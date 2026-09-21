import type { ReactNode } from 'react';
import { getLocale } from '@forgeax/interface/i18n';
import { useTaskFlowUiStore } from '../../task-flow/ui-store';

export function RequestCard({ id, count, failures, actionable, header, history, children }: {
  id: string; count: number; failures: number; actionable: boolean;
  header: ReactNode; history: ReactNode; children: ReactNode;
}) {
  const key = `request:${id}`;
  const saved = useTaskFlowUiStore(state => state.openProcesses[key]);
  const toggle = useTaskFlowUiStore(state => state.toggleProcess);
  const open = actionable || saved === true;
  const zh = getLocale() === 'zh';
  return <section className="cp-request-card" aria-label={zh ? '制作请求进展' : 'Request progress'}>
    {header}
    <button type="button" className="cp-request-history-toggle" aria-expanded={open}
      disabled={actionable} onClick={() => toggle(key, open)}>
      {open ? '▾' : '▸'} {zh ? `此前执行记录 · ${count}` : `Earlier execution · ${count}`}
      {failures > 0 && <span> · {zh ? `${failures} 次错误，详情保留` : `${failures} errors, details retained`}</span>}
    </button>
    <div hidden={!open} className="cp-request-history">{history}</div>
    {children}
  </section>;
}
