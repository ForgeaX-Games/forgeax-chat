import { AlertCircle } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import { executionFailureKind, executionFailureMessages } from './execution-failure';
import './ExecutionFailure.css';

export function ExecutionFailure({ error }: { error: string }) {
  const { i18n } = useTranslation();
  const copy = executionFailureMessages(i18n?.language);
  const kind = executionFailureKind(error);
  return (
    <section className="kc-error kc-execution-failure" aria-label={copy[kind]}>
      <div className="kc-failure-summary"><AlertCircle size={16} aria-hidden="true" /><strong>{copy[kind]}</strong></div>
      <p>{kind === 'validation' ? copy.validationHelp : copy.help}</p>
      <details>
        <summary>{copy.details}</summary>
        <pre>{error}</pre>
      </details>
    </section>
  );
}
