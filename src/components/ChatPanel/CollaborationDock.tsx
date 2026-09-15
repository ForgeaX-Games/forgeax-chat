import type { ChatMessage } from '../../session-store';
import { ForgeText } from './message-parts/ForgeText';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, CircleAlert, LoaderCircle, MessageSquare } from 'lucide-react';
import { getLocale } from '@forgeax/interface/i18n';
import { useAgentNames } from './useAgentNames';
import { collaborationStatusLabel, collaborationSummary, isCollaborationActive, type CollaborationWork } from './collaboration-status';
import './CollaborationDock.css';

/** One collapsible collaboration entry in the conversation flow. */
export function CollaborationDock({ work, updates = [], history, initialExpanded = false, onExpandedChange, onNavigate }: { initialExpanded?: boolean; onExpandedChange?: (open: boolean) => void; history?: ReactNode; work: CollaborationWork[]; updates?: ChatMessage[]; onNavigate: (agent: string) => void }) {
  const zh = getLocale() === 'zh';
  const resolveName = useAgentNames();
  const active = work.filter(item => isCollaborationActive(item.status));
  const complete = work.filter(item => !isCollaborationActive(item.status));
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState(initialExpanded);
  const hasActive = active.length > 0;
  const [updateLimit, setUpdateLimit] = useState(10);
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActive]);
  const wasActive = useRef(hasActive);
  useEffect(() => {
    if (wasActive.current && !hasActive) {
      setExpanded(false);
      onExpandedChange?.(false);
    }
    wasActive.current = hasActive;
  }, [hasActive, onExpandedChange]);
  if (!work.length && !history) return null;
  const waiting = active.filter(item => ['waiting_permission', 'waiting_input'].includes(item.status)).length;
  const summary = !work.length ? (zh ? '角色交接记录' : 'Role handoff history') : zh
    ? `角色协作 · ${work.length} 个任务${waiting ? ` · ${waiting} 个需要你处理` : hasActive ? ` · ${active.length} 个进行中` : ' · 无进行中任务'}`
    : `Role collaboration · ${work.length} tasks${waiting ? ` · ${waiting} need your attention` : hasActive ? ` · ${active.length} active` : ' · No active tasks'}`;
  return <details className="cp-collaboration-dock" open={expanded} onToggle={event => { const open = event.currentTarget.open; setExpanded(open); onExpandedChange?.(open); }} aria-label={zh ? '协作状态' : 'Collaboration status'} data-testid="collaboration-dock">
    <summary className="cp-collaboration-heading" data-active={hasActive}>
      <span role="status" aria-live="polite">{summary}</span>
    </summary>
    <div className="cp-collaboration-items">
      {active.map(item => {
        const elapsed = Math.max(0, Math.floor((now - item.since) / 1000));
        const duration = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
        const quiet = now - item.updatedAt >= 60000 && !['waiting_permission', 'waiting_input'].includes(item.status);
        const Icon = ['waiting_permission', 'waiting_input'].includes(item.status) ? CircleAlert : LoaderCircle;
        return <button type="button" className="cp-collaboration-item" key={item.id} data-status={item.status} onClick={() => onNavigate(item.agent)}>
          <Icon size={14} className={item.status === 'running' ? 'cp-collaboration-spinner' : ''} aria-hidden="true" />
          <span className="cp-collaboration-content">
            <span className="cp-collaboration-title">{resolveName(item.agent) || item.agent} · {collaborationStatusLabel(item.status, zh)}</span>
            {item.brief && <span className="cp-collaboration-summary" title={item.brief}>{collaborationSummary(item.brief)}</span>}
            <small>{zh ? '派发后 ' : 'Since assignment '}{duration}{quiet ? (zh ? ' · 暂未收到新进展' : ' · No recent update') : ''}</small>
          </span>
          <span className="cp-collaboration-link">{zh ? '查看进展' : 'View progress'} <ArrowRight size={12} aria-hidden="true" /></span>
        </button>;
      })}
      {complete.map(item => <button type="button" key={item.id} className="cp-collaboration-item cp-collaboration-result" data-status={item.status} onClick={() => onNavigate(item.agent)}>
        {item.status === 'returned' ? <CheckCircle2 size={14} aria-hidden="true" /> : item.status === 'responded' ? <MessageSquare size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
        <span className="cp-collaboration-content"><span>{resolveName(item.agent) || item.agent} · {collaborationStatusLabel(item.status, zh)}</span>
          {item.detail && <span className="cp-collaboration-summary" title={item.detail}>{collaborationSummary(item.detail)}</span>}
        </span><ArrowRight size={12} aria-hidden="true" />
      </button>)}
    </div>
    {updates.length > 0 && <details className="cp-collaboration-updates" data-testid="collaboration-updates">
      <summary>{zh ? `协作过程 · ${updates.length} 条更新` : `Collaboration process · ${updates.length} ${updates.length === 1 ? 'update' : 'updates'}`}</summary>
      <div className="cp-collaboration-update-list">
        {updates.length > updateLimit && <button type="button" className="cp-collaboration-toggle" onClick={() => setUpdateLimit(limit => limit + 10)}>{zh ? '查看更早更新' : 'Show earlier updates'}</button>}
        {updates.slice(-updateLimit).map(message => <div className="cp-collaboration-update" key={message.id}>
          <time>{new Date(message.ts).toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
          <ForgeText text={message.text} animated={false} size="sm" />
        </div>)}
      </div>
    </details>}
    {history}
  </details>;
}
