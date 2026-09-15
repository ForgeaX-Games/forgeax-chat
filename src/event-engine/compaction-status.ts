import { getLocale } from '@/i18n';
import type { StoredEvent, SystemMessage } from './types';

// Chat owns these labels so an older Studio locale catalog cannot render keys.
const labels = {
  en: { started: 'Compacting context', completed: 'Context compacted', failed: 'Context compaction failed', cancelled: 'Context compaction stopped' },
  zh: { started: '正在整理上下文', completed: '上下文已整理', failed: '上下文整理失败', cancelled: '上下文整理已停止' },
};

/** This is a public metadata projection. Never read summary, error, text, or
 * visual_display from a compactor's diagnostic payload. */
export function formatCompactionStatus(event: StoredEvent): SystemMessage | null {
  const p = event.payload ?? {};
  if (p.visibility === 'private_reasoning') return null;
  if (p.phase !== 'started' && p.phase !== 'completed' && p.phase !== 'failed' && p.phase !== 'cancelled') return null;
  if (typeof p.id !== 'string' || !p.id || p.id.length > 200) return null;
  if (!Number.isSafeInteger(p.count) || (p.count as number) < 1) return null;
  const locale = getLocale();
  const count = locale === 'zh' ? `（第 ${p.count} 次）` : ` (${p.count})`;
  const duration = typeof p.durationMs === 'number' && Number.isFinite(p.durationMs) && p.durationMs >= 0
    ? `${Math.round(p.durationMs / 1000)}${locale === 'zh' ? ' 秒' : 's'}` : '';
  return {
    kind: 'system',
    turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
    compactionId: `compaction:${event.emitterId ?? ''}:${p.id}`,
    source: '',
    text: [labels[locale][p.phase] + count, duration].filter(Boolean).join(' · '),
    level: p.phase === 'failed' ? 'warning' : 'info',
    agent: event.emitterId ?? '',
    timestamp: event.ts ?? Date.now(),
  };
}
