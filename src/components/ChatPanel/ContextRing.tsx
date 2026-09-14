import { getLocale } from '@forgeax/interface/i18n';
import { useShellStore } from '@forgeax/interface/store';
import { useActiveContextUsage } from '../../session-store';

function ringColor(pct: number): string {
  if (pct >= 85) return '#ef4444';
  if (pct >= 70) return '#f97316';
  if (pct >= 50) return '#eab308';
  return '#22c55e';
}

const R = 8;
const STROKE = 3;
const SIZE = (R + STROKE) * 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

export default function ContextRing() {
  const activeSid = useShellStore((s) => s.activeSid);
  const usage = useActiveContextUsage();
  const contextPct = usage?.pct ?? 0;
  const zh = getLocale() === 'zh';
  const detail = usage?.source === 'runtime'
    ? `${((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)).toLocaleString()} / ${usage.contextWindow?.toLocaleString()} tokens`
    : (zh ? '估算用量' : 'Estimated usage');
  const title = `${zh ? '当前上下文' : 'Current context'}: ${contextPct}% · ${detail}. ${zh ? '用量会随请求和历史重新载入而变化；压缩会单独显示。' : 'Usage can change between requests or when history reloads. Compaction is shown separately.'}`;

  if (!activeSid || contextPct <= 0) return null;

  const offset = CIRCUMFERENCE * (1 - contextPct / 100);
  const color = ringColor(contextPct);

  return (
    <div className="cb-context-ring" title={title} aria-label={title}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="var(--border-subtle, #333)"
          strokeWidth={STROKE}
          opacity={0.3}
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className="cb-context-label">{contextPct}%</span>
    </div>
  );
}
