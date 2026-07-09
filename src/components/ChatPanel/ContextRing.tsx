import { useAppStore } from '@forgeax/interface/store';
import { useActiveContextPct } from '../../session-store';

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
  const activeSid = useAppStore((s) => s.activeSid);
  const contextPct = useActiveContextPct();

  if (!activeSid || contextPct <= 0) return null;

  const offset = CIRCUMFERENCE * (1 - contextPct / 100);
  const color = ringColor(contextPct);

  return (
    <div className="cb-context-ring" title={`Context: ${contextPct}%`}>
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
