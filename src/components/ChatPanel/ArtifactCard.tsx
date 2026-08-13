import type { ArtifactSummary } from '@forgeax/types/artifact-summary';
import { useTranslation } from '@forgeax/interface/i18n';
import type { DeliverSummary } from '../../task-flow/model';
import { DeliverCard } from './DeliverCard';

function conciseOutcome(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text || /^(?:done|completed|implemented|finished|完成|已完成|搞定)[.!。！]?$/i.test(text)) return undefined;
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 5).join('\n');
}

/** Independent host-derived artifact card.  `DeliverCard` supplies the mature
 * file/build/reveal controls; this adapter deliberately has no Round input and
 * cannot be created from a Todo or from a delivery claim. */
export function ArtifactCard({
  artifact,
  timestamp,
  onNext,
  onReveal,
}: {
  artifact: ArtifactSummary;
  timestamp?: string;
  onNext?: (text: string, recommendationId?: string) => void;
  onReveal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const semantic = artifact.semantic;
  const delivery: DeliverSummary = {
    outcome: conciseOutcome(semantic?.outcome)
      ?? (artifact.status === 'unavailable'
        ? artifact.unavailableReason ?? t('taskFlow.artifactStatsUnavailable')
        : t(artifact.status === 'partial' ? 'taskFlow.artifactOutcomePartial' : 'taskFlow.artifactOutcomeComplete')),
    files: artifact.files.map((file) => ({
      path: file.path,
      change: file.change,
      insertions: file.insertions,
      deletions: file.deletions,
    })),
    status: artifact.status,
    tests: semantic?.tests?.map((test) => ({ name: test.name, ok: test.pass, detail: test.detail })) ?? [],
    next: semantic?.next?.slice(0, 5).filter(Boolean).length
      ? semantic.next.slice(0, 5).filter(Boolean)
      : [t('taskFlow.confirmDeliveryRecommendation')],
    build: semantic?.build ? { version: semantic.build } : undefined,
    agents: artifact.agents,
    durationMs: artifact.durationMs,
    derivedUnavailable: artifact.derivedUnavailable || artifact.status === 'unavailable',
    unavailableReason: artifact.unavailableReason,
    reliableCandidatePaths: artifact.reliableCandidatePaths,
    unattributedCount: artifact.unattributedCount,
  };
  return (
    <div data-testid="artifact-card" data-artifact-id={artifact.id} data-artifact-status={artifact.status}>
      {timestamp && <div className="tx-artifact-time">{timestamp} · {t('taskFlow.deliveredAt')}</div>}
      <DeliverCard
        delivery={delivery}
        title={t('taskFlow.deliveryCardTitle')}
        recommendationPrefix={artifact.id}
        onReveal={onReveal}
        onNext={(text, recommendationId) => onNext?.(text, recommendationId)}
      />
    </div>
  );
}
