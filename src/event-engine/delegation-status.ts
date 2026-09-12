import { getLocale } from '@/i18n';
import type { StoredEvent, SystemMessage } from './types';

export interface DelegationSnapshot {
  delegationId: string;
  ownerTaskId: string;
  agent: string;
  status: 'queued' | 'running' | 'waiting_permission' | 'stopping' | 'returned';
}
export type DelegationMessage = { delegation?: DelegationSnapshot };

/** Public lifecycle notices share the live and replay path. These are event
 * facts, not a second scheduler, and never enqueue or complete work. */
export function formatDelegationStatus(event: StoredEvent): SystemMessage | null {
  const p = event.payload ?? {};
  if (p.visibility === 'private_reasoning' || typeof p.delegationId !== 'string' || !p.delegationId) return null;
  const zh = getLocale() === 'zh';
  const stopReason = p.stopReason ?? p.reason;
  const recovery = stopReason === 'superseded'
    ? (zh ? '旧任务结果已保留，未自动继续旧任务。' : 'Previous task results were retained without resuming that task.')
    : stopReason === 'fault_paused' || stopReason === 'user_stopped'
      ? (zh ? '主任务保持暂停，可在下方发送消息继续。' : 'The main task remains paused. Send a message below to continue.')
      : (zh ? '结果已保存，未自动唤醒。可在下方发送消息继续。' : 'Results were saved without automatically resuming work. Send a message below to continue.');
  let text: string;
  if (event.type === 'delegation:state') {
    if (typeof p.agent !== 'string' || typeof p.ownerTaskId !== 'string' || !p.ownerTaskId ||
      !['queued', 'running', 'waiting_permission', 'stopping', 'returned'].includes(String(p.status))) return null;
    if (p.status === 'stopping') {
      if (!['user_stopped', 'fault_paused', 'superseded'].includes(String(p.reason))) return null;
      const reason = p.reason === 'user_stopped' ? (zh ? '主任务已停止' : 'Stopped')
        : p.reason === 'fault_paused' ? (zh ? '主任务已暂停' : 'Paused')
          : (zh ? '旧轮次已结束' : 'Previous task ended');
      text = zh ? `${reason} · ${p.agent} 的委托正在安全收尾` : `${reason} · ${p.agent} delegation is finishing safely`;
    } else if (p.status === 'returned') {
      if (!['completed', 'failed', 'cancelled'].includes(String(p.outcome))) return null;
      text = p.outcome === 'cancelled' ? (zh ? '委托已取消；已完成文件保留' : 'Delegation cancelled; completed files retained')
        : p.outcome === 'failed' ? (zh ? '委托失败，结果已回传' : 'Delegation failed; result returned')
          : (zh ? '委托成果已回传' : 'Delegation result returned');
      if (p.resumeRequired === true) text += `${zh ? '。' : '. '}${recovery}`;
    } else {
      text = p.status === 'queued' ? (zh ? '排队中' : 'Queued')
        : p.status === 'waiting_permission' ? (zh ? '等待授权' : 'Waiting for approval')
          : (zh ? '执行中' : 'Running');
    }
  } else if (event.type === 'message' && p.resumeRequired === true) {
    const content = typeof p.content === 'string' ? p.content : '';
    text = `${recovery}\n\n${content}`;
  } else return null;
  const delegation = event.type === 'delegation:state' ? { delegationId: p.delegationId, ownerTaskId: p.ownerTaskId as string, agent: p.agent as string, status: p.status as DelegationSnapshot['status'] } : undefined;
  return { ...(delegation ? { delegation, compactionId: `delegation:${delegation.ownerTaskId}:${delegation.delegationId}` } : {}), kind: 'system', source: event.source ?? '', text, agent: event.emitterId ?? '', timestamp: event.ts ?? Date.now(),
    direction: 'incoming', from: typeof p.fromAgent === 'string' ? p.fromAgent : undefined,
    to: typeof event.to === 'string' ? event.to : undefined };
}
