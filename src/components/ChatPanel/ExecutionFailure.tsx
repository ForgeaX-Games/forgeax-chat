import { AlertCircle, CirclePause } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { executionFailureKind, executionFailureMessages, type FailureContinuation } from './execution-failure';
import './ExecutionFailure.css';

export function ExecutionFailure({ error, continuation }: { error: string; continuation?: FailureContinuation }) {
  const { i18n } = useTranslation();
  const copy = executionFailureMessages(i18n?.language);
  const kind = executionFailureKind(error);
  const summary = copy[kind === 'interrupted' ? 'interrupted' : continuation ?? kind];
  return (
    <section className="kc-error kc-execution-failure" aria-label={summary} data-failure-kind={kind}>
      <details>
        <summary className="kc-failure-summary">{kind === 'interrupted' ? <CirclePause size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}<span>{summary}</span><span className="kc-failure-details-label">{copy.details}</span></summary>
        <p>{kind === 'interrupted' ? copy.interruptedHelp : continuation ? copy.continuationHelp : kind === 'validation' ? copy.validationHelp : copy.help}</p>
        <pre>{error}</pre>
      </details>
    </section>
  );
}
