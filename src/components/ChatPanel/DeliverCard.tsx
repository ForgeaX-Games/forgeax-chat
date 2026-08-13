import {
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  FileText,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import type { DeliverFile, DeliverSummary } from '../../task-flow/model';
import { deriveStats, filesByChange } from '../../task-flow/stats';
import { formatDuration } from './ProcessAccordion';
import { useAgentIdentities } from './agent-identity';
import { FilePill } from './FilePill';
import { MarkdownView } from './MarkdownView';
import { alertDialog } from '@forgeax/interface/lib/dialog';

export function DeliverCard({
  title,
  recommendationPrefix,
  delivery,
  onNext,
  onReveal,
}: {
  /** The complete session title is the only delivery-card title source. */
  title: string;
  recommendationPrefix?: string;
  delivery: DeliverSummary;
  onNext?: (text: string, recommendationId?: string) => void;
  onReveal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const identify = useAgentIdentities();
  const [filesOpen, setFilesOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(true);
  const [testsOpen, setTestsOpen] = useState(
    (delivery.tests?.length ?? 0) === 0 || (delivery.tests?.some((test) => !test.ok) ?? false),
  );
  const [copied, setCopied] = useState(false);
  const stats = deriveStats(delivery.files);
  const groups = filesByChange(delivery.files);
  const derivedUnavailable = delivery.derivedUnavailable === true;
  const status = delivery.status;
  const statsUnavailable = derivedUnavailable || status === 'unavailable';

  const runBuild = async () => {
    await alertDialog({ body: t('taskFlow.featureUnderConstruction') });
  };
  const metaParts = [
    (delivery.agents ?? []).map((id) => identify(id)?.name ?? id).join(' + '),
    delivery.durationMs ? formatDuration(delivery.durationMs) : '',
    typeof delivery.costUsd === 'number' ? `$${delivery.costUsd.toFixed(2)}` : '',
  ].filter(Boolean);
  const copyText = [
    title,
    delivery.outcome,
    ...delivery.files.map((file) => `${file.change}: ${file.path}`),
    ...(delivery.tests ?? []).map((test) => `${test.ok ? 'PASS' : 'FAIL'}: ${test.name}${test.detail ? ` — ${test.detail}` : ''}`),
    ...(delivery.next ?? []).map((item) => `Next: ${item}`),
  ].filter(Boolean).join('\n');

  const copyArtifact = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className={`tx-deliver tx-deliver-${status ?? 'complete'}`} data-delivery-status={status ?? 'complete'}>
      <header className="tx-dh">
        <span className="tx-dh-ic" aria-hidden="true"><Box size={14} /></span>
        <span className="tx-dh-tt" title={title}>{title}</span>
        {status === 'partial' && <span className="tx-status-badge tx-status-badge-partial">{t('taskFlow.artifactPartial')}</span>}
        {statsUnavailable && <span className="tx-status-badge tx-status-badge-unavailable">{t('taskFlow.artifactUnavailable')}</span>}
        {metaParts.length > 0 && <span className="tx-dh-sub">{metaParts.join(' · ')}</span>}
        <button
          type="button"
          className="tx-dh-copy"
          aria-label={copied ? t('taskFlow.copied') : t('taskFlow.copyArtifact')}
          title={copied ? t('taskFlow.copied') : t('taskFlow.copyArtifact')}
          onClick={() => void copyArtifact()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </header>
      <div className={`tx-outcome-row${outcomeOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="tx-outcome-toggle"
          aria-expanded={outcomeOpen}
          onClick={() => setOutcomeOpen((value) => !value)}
        >
          <span>{t('taskFlow.outcome')}</span>
          {outcomeOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {outcomeOpen && <div className="tx-outcome"><MarkdownView text={delivery.outcome} /></div>}
      </div>
      {statsUnavailable ? (
        <UnavailableDetails
          reason={delivery.unavailableReason}
          candidates={delivery.reliableCandidatePaths ?? []}
          unattributedCount={delivery.unattributedCount}
          onReveal={onReveal}
        />
      ) : (
        <>
          <div className="tx-total">
            <span className="tx-total-lb">{t('taskFlow.totalLabel')}</span>
            <span className="tx-chip tx-chip-edit"><b>{stats.edits}</b> {t('taskFlow.chipEdit')}</span>
            <span className="tx-chip tx-chip-new"><b>{stats.additions}</b> {t('taskFlow.chipNew')}</span>
            <span className="tx-chip tx-chip-del"><b>{stats.deletions}</b> {t('taskFlow.chipDel')}</span>
          </div>
          <FoldRow
            open={filesOpen}
            onToggle={() => setFilesOpen((value) => !value)}
            icon={<FileText size={14} />}
            label={t('taskFlow.files')}
            count={t('taskFlow.filesCount', { count: delivery.files.length })}
          >
            <FileGroup tone="edit" title={t('taskFlow.groupEdit')} files={groups.edit} onReveal={onReveal} />
            <FileGroup tone="new" title={t('taskFlow.groupNew')} files={groups.new} onReveal={onReveal} />
            <FileGroup tone="del" title={t('taskFlow.groupDel')} files={groups.del} onReveal={onReveal} />
          </FoldRow>
        </>
      )}
      {delivery.tests && (
        <FoldRow
          open={testsOpen}
          onToggle={() => setTestsOpen((value) => !value)}
          icon={<CheckCircle2 size={14} />}
          label={t('taskFlow.tests')}
          count={t('taskFlow.testsCount', {
            pass: delivery.tests.filter((test) => test.ok).length,
            total: delivery.tests.length,
          })}
        >
          {delivery.tests.length === 0 && <div className="tx-empty-state">{t('taskFlow.testsNotReported')}</div>}
          {delivery.tests.map((test) => (
            <div className={`tx-chk ${test.ok ? '' : 'is-fail'}`} key={test.name}>
              {test.ok ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
              <span>{test.name}{test.detail ? ` · ${test.detail}` : ''}</span>
            </div>
          ))}
        </FoldRow>
      )}
      {delivery.next?.length ? (
        <div className="tx-sec">
          <div className="tx-sec-cap">{t('taskFlow.nextSteps')}</div>
          {delivery.next.map((text, index) => (
            <button
              type="button"
              className="tx-next"
              key={`${recommendationPrefix ?? 'legacy'}:${index}:${text}`}
              data-recommendation-id={`${recommendationPrefix ?? 'legacy'}:${index}`}
              onClick={() => onNext?.(text, `${recommendationPrefix ?? 'legacy'}:${index}`)}
            >
              <span className="tx-next-bx" aria-hidden="true" />
              <span className="tx-next-tx">{text}</span>
              <span className="tx-next-pl" aria-hidden="true">+</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="tx-build tx-build-idle" data-build-status="idle">
        <span className="tx-build-copy">
          <span className="tx-build-title">{t('taskFlow.buildAction')}</span>
          <span className="tx-build-note">{t('taskFlow.featureUnderConstruction')}</span>
        </span>
        <button
          type="button"
          className="tx-build-action"
          aria-busy={false}
          onClick={() => void runBuild()}
        >
          {t('taskFlow.buildAction')}
        </button>
        </div>
    </section>
  );
}

function UnavailableDetails({
  reason,
  candidates,
  unattributedCount,
  onReveal,
}: {
  reason?: string;
  candidates: string[];
  unattributedCount?: number;
  onReveal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="tx-unavailable" data-testid="artifact-unavailable-details">
      <div className="tx-unavailable-title">{t('taskFlow.artifactStatsUnavailable')}</div>
      {reason && <div className="tx-unavailable-reason">{t('taskFlow.artifactReason', { reason })}</div>}
      {typeof unattributedCount === 'number' && unattributedCount > 0 && (
        <div className="tx-unavailable-reason">
          {t('taskFlow.artifactUnattributed', { count: unattributedCount })}
        </div>
      )}
      <div className="tx-unavailable-candidates">
        <div className="tx-unavailable-cap">{t('taskFlow.artifactCandidates')}</div>
        {candidates.length > 0
          ? candidates.map((path) => <FilePill key={path} path={path} onReveal={onReveal} />)
          : <span className="tx-fg-empty">{t('taskFlow.artifactNoCandidates')}</span>}
      </div>
    </div>
  );
}

function FoldRow({
  open,
  onToggle,
  icon,
  label,
  count,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`tx-fold-row ${open ? 'is-open' : ''}`}>
      <button type="button" className="tx-fold-head" onClick={onToggle} aria-expanded={open}>
        <span className="tx-fold-fi" aria-hidden="true">{icon}</span>
        <span className="tx-fold-lb">{label}</span>
        <span className="tx-fold-ct">{count}</span>
        <ChevronRight size={13} className="tx-fold-cv" aria-hidden="true" />
      </button>
      {open && <div className="tx-fold-body">{children}</div>}
    </div>
  );
}

function FileGroup({
  tone,
  title,
  files,
  onReveal,
}: {
  tone: 'edit' | 'new' | 'del';
  title: string;
  files: DeliverFile[];
  onReveal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="tx-fg">
      <div className={`tx-fg-h tx-fg-${tone}`}>{title} <span className="tx-fg-n">{files.length}</span></div>
      <div className="tx-fg-list">
        {files.length
          ? files.map((file) => (
            <FilePill
              key={file.path}
              path={file.path}
              deleted={tone === 'del'}
              onReveal={onReveal}
            />
          ))
          : <span className="tx-fg-empty">{t('taskFlow.groupEmpty')}</span>}
      </div>
    </div>
  );
}
