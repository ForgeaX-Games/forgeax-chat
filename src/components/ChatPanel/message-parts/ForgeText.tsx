import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import { TypewriterText } from '../TypewriterText';

/** Measure rendered content, so languages, code and tables share one visual limit. */
export function ForgeText({ text, animated, size = 'md' }: {
  text: string; animated: boolean; size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setOverflow(node.scrollHeight > Math.min(360, window.innerHeight * 0.5) + 24);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [text, animated]);
  const foldable = !animated && overflow;
  const folded = foldable && !expanded;
  return <div ref={root} className={`kc-text ${folded ? 'kc-text-folded' : ''}${size === 'sm' ? ' mp-sm' : ''}`}>
    <div ref={content} className="kc-text-content"><TypewriterText text={text} animated={animated} /></div>
    {foldable && <button type="button" className="kc-fold-toggle no-motion-lift" aria-expanded={expanded}
      onClick={() => {
        // Expanding keeps the visible beginning in place instead of jumping to the end.
        if (expanded) requestAnimationFrame(() => root.current?.scrollIntoView({ block: 'nearest' }));
        setExpanded(value => !value);
      }}>
      {expanded ? t('forgeText.collapse') : t('forgeText.expand', { count: text.length })}
    </button>}
  </div>;
}
