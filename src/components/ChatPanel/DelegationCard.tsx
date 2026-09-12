import { getLocale } from '@forgeax/interface/i18n';
import type { DelegationSnapshot } from '../../event-engine/delegation-status';
import { useOpenAgentThread } from './use-agent-thread';
import { useAgentNames } from './useAgentNames';

/** Each card is anchored to its owning task and delegation, independent of todo. */
export function DelegationCard({ snapshot, text }: { snapshot: DelegationSnapshot; text: string }) {
  const openAgent = useOpenAgentThread();
  const resolveName = useAgentNames();
  return <section className="tx-plan" data-testid="parallel-delegation" data-delegation-id={snapshot.delegationId} data-owner-task-id={snapshot.ownerTaskId} data-status={snapshot.status}>
    <header className="tx-plan-owner">
      <span className="tx-plan-owner-role">{getLocale() === 'zh' ? '并行委托' : 'Parallel delegation'}</span>
      <button type="button" className="tx-plan-owner-name" onClick={() => openAgent(snapshot.agent)}>{resolveName(snapshot.agent)}</button>
    </header>
    <div className="tx-plan-list"><div className="tx-plan-row"><span className="tx-plan-nm">{text}</span></div></div>
  </section>;
}
