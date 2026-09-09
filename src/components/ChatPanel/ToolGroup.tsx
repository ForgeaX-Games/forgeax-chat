import { useState, type ReactNode } from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import type { Step } from '../../task-flow/model';
import { toolGroupLabel } from './tool-groups';

export function ToolGroup({ steps, children }: { steps: Step[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const running = steps.some(step => step.status === 'running' || step.status === 'pending');
  const failed = steps.some(step => step.status === 'error');
  return <section className={`tx-tool-group${failed ? ' has-error' : ''}`}>
    <button type="button" className="tx-tool-group-head" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>
      <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} aria-hidden="true" />
      {running ? <span className="tx-spin" aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />}
      <span>{toolGroupLabel(steps, t)}</span>
    </button>
    {open && <div className="tx-tool-group-body thin-scrollbar">{children}</div>}
  </section>;
}
