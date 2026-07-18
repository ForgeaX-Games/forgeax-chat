import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import type { PillPayload } from '@forgeax/interface/lib/composer-bridge';
import './PillChip.css';

interface Props {
  payload: PillPayload;
  /** When true, chip belongs to the composer editor and behaves as an atomic
   *  contenteditable=false unit. Backspace deletes it whole. */
  editable?: boolean;
}

export function PillChip({ payload, editable = false }: Props) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const chipRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!hovered || !chipRef.current) { setPos(null); return; }
    const r = chipRef.current.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 6 });
  }, [hovered]);

  return (
    <span
      ref={chipRef}
      className={`kbl-pill kbl-pill-${payload.kind}`}
      contentEditable={editable ? false : undefined}
      data-pill="1"
      data-pill-kind={payload.kind}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="kbl-pill-icon" aria-hidden="true">{payload.icon ?? '🔖'}</span>
      <span className="kbl-pill-label">{payload.display}</span>
      {hovered && pos && (
        <span
          className="kbl-pill-tip"
          style={{ left: pos.left, top: pos.top }}
          contentEditable={false}
          role="tooltip"
        >
          <span className="kbl-pill-tip-title">{payload.tooltip.title}</span>
          {payload.tooltip.lines.map((l, i) => (
            <span key={i} className="kbl-pill-tip-line">{l}</span>
          ))}
          <span className="kbl-pill-tip-detail" title={t('pillChip.expandedFormTip')}>{payload.detail}</span>
        </span>
      )}
    </span>
  );
}
