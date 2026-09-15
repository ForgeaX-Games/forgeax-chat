import { Check, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import { getLocale } from '@forgeax/interface/i18n';
import { delegationDetail } from './delegation-detail';
import { useAgentNames } from './useAgentNames';
import type { Step } from '../../task-flow/model';
import { stepBadge } from '../../task-flow/steps';
import { StepDetail } from './StepDetail';
import { MarkdownView } from './MarkdownView';
import { AskUserCard } from './message-parts/AskUserCard';

export function StepRow({
  step,
  open,
  onToggle,
  sid,
  agentId,
}: {
  step: Step;
  open: boolean;
  onToggle: () => void;
  sid?: string;
  agentId?: string;
}) {
  const resolveName = useAgentNames();
  const delegation = delegationDetail(step.tool);
  const zh = getLocale() === 'zh';
  const [replay, setReplay] = useState(0);
  if (step.tool?.name === 'ask_user' && sid) {
    return <div className="tx-inline-question">
      {step.narration?.map((text, index) => <MarkdownView key={index} text={text} />)}
      <AskUserCard tc={step.tool} sid={sid} agentId={agentId ?? ''} />
    </div>;
  }
  const badge = delegation && step.status === 'done' ? (zh ? '已分配' : 'Assigned') : stepBadge(step);
  const isOpen = open;
  const animated = replay > 0 && step.status !== 'running' && isOpen;
  const settled = step.status === 'done';
  const handleToggle = () => {
    if (!isOpen) setReplay((value) => value + 1);
    onToggle();
  };
  return (
    <div className={`tx-step tx-step-${step.status} ${isOpen ? 'is-open' : ''}`}>
      <button
        type="button"
        className="tx-step-row"
        onClick={handleToggle}
        aria-expanded={isOpen}
      >
        <span className="tx-step-box" aria-hidden="true">
          {settled ? <Check size={11} /> : step.status === 'error' ? <X size={11} /> : null}
        </span>
        <span className="tx-step-lb">{delegation ? `${zh ? '委派任务' : 'Delegate task'}${delegation.target ? ` → ${resolveName(delegation.target) || delegation.target}` : ''}` : step.name}</span>
        {badge && <span className="tx-step-badge">{badge}</span>}
        <ChevronRight size={13} className="tx-step-cv" aria-hidden="true" />
      </button>
      <div className={`tx-step-body-wrap ${isOpen ? 'is-open' : ''}`}>
        {isOpen && <StepDetail key={`${step.id}:${replay}`} step={step} animated={animated} />}
      </div>
    </div>
  );
}
