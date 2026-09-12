import { AlertCircle } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { executionFailureKind, executionFailureMessages, type FailureContinuation } from './execution-failure';
import './ExecutionFailure.css';

export function ExecutionFailure({ error, continuation }: { error: string; continuation?: FailureContinuation }) {
  const { i18n } = useTranslation();
  const copy = executionFailureMessages(i18n?.language);
  const kind = executionFailureKind(error);
  const summary = copy[continuation ?? kind];
  return (
    <section className="kc-error kc-execution-failure" aria-label={summary}>
      <div className="kc-failure-summary"><AlertCircle size={16} aria-hidden="true" /><strong>{summary}</strong></div>
      <p>{continuation ? copy.continuationHelp : kind === 'validation' ? copy.validationHelp : copy.help}</p>
      <details>
        <summary>{copy.details}</summary>
        <pre>{error}</pre>
      </details>
    </section>
  );
}
