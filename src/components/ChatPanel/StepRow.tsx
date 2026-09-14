import { Check, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import type { Step } from '../../task-flow/model';
import { stepBadge } from '../../task-flow/steps';
import { StepDetail } from './StepDetail';
import { MarkdownView } from './MarkdownView';
import { AskUserCard } from './message-parts/AskUserCard';
import { effectiveStepOpen } from './process-display';

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
  const [replay, setReplay] = useState(0);
  if (step.tool?.name === 'ask_user' && sid) {
    return <div className="tx-inline-question">
      {step.narration?.map((text, index) => <MarkdownView key={index} text={text} />)}
      <AskUserCard tc={step.tool} sid={sid} agentId={agentId ?? ''} />
    </div>;
  }
  const badge = stepBadge(step);
  const isOpen = effectiveStepOpen(open, step.status);
  const animated = replay > 0 && step.status !== 'running' && isOpen;
  const settled = step.status === 'done' || step.status === 'frozen';
  const handleToggle = () => {
    if (!isOpen) setReplay((value) => value + 1);
    onToggle();
  };
  return (
    <div className={`tx-step tx-step-${step.status} ${isOpen ? 'is-open' : ''}`}>
      <button
        type="button"
        className="tx-step-row"
        onClick={() => { if (step.status !== 'running') handleToggle(); }}
        aria-expanded={isOpen}
        aria-disabled={step.status === 'running'}
      >
        <span className="tx-step-box" aria-hidden="true">
          {settled ? <Check size={11} /> : step.status === 'error' ? <X size={11} /> : null}
        </span>
        <span className="tx-step-lb">{step.name}</span>
        {badge && <span className="tx-step-badge">{badge}</span>}
        {step.status !== 'running' && <ChevronRight size={13} className="tx-step-cv" aria-hidden="true" />}
      </button>
      <div className={`tx-step-body-wrap ${isOpen ? 'is-open' : ''}`}>
        <StepDetail key={`${step.id}:${replay}`} step={step} animated={animated} />
      </div>
    </div>
  );
}
