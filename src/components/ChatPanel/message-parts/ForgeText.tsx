import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@forgeax/interface/i18n';
import { TypewriterText } from '../TypewriterText';

/**
 * Long assistant messages dominate the scroll; clip them with a fade gradient +
 * "Show full" toggle. Don't clip while streaming (animated=true) — the
 * typewriter cursor needs to stay at the tail. Threshold scales with viewport
 * height (≈ 2.2 chars per pixel of vertical room) so a 800h laptop folds at
 * ~1760 and a 1440h desktop at ~3168; clamped to [1200, 4000] to keep extremes
 * sane.
 */
function calcFoldThreshold(): number {
  const h = typeof window !== 'undefined' ? window.innerHeight : 900;
  return Math.max(1200, Math.min(4000, Math.floor(h * 2.2)));
}

// Module-level shared fold threshold. ForgeText renders once per text block and
// chat history is never virtualized/unmounted, so a per-instance
// `window.addEventListener('resize')` leaked ~1 listener per rendered message
// forever. Instead keep ONE window 'resize' listener for the whole app and let
// each instance subscribe a cheap callback to a Set (cleaned up on unmount).
let _foldThreshold = calcFoldThreshold();
const _foldSubs = new Set<(t: number) => void>();
const _FOLD_RESIZE_FLAG = '__forgeFoldResizeBound';
if (typeof window !== 'undefined' && !(window as unknown as Record<string, unknown>)[_FOLD_RESIZE_FLAG]) {
  (window as unknown as Record<string, unknown>)[_FOLD_RESIZE_FLAG] = true;
  let tid: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (tid) clearTimeout(tid);
    tid = setTimeout(() => {
      _foldThreshold = calcFoldThreshold();
      _foldSubs.forEach((fn) => fn(_foldThreshold));
    }, 200);
  });
}

function useFoldThreshold(): number {
  const [threshold, setThreshold] = useState(_foldThreshold);
  useEffect(() => {
    // re-sync in case the viewport changed between module-eval and this mount
    setThreshold(_foldThreshold);
    _foldSubs.add(setThreshold);
    return () => { _foldSubs.delete(setThreshold); };
  }, []);
  return threshold;
}

// Per-text CJK density: CJK glyphs are ~12px wide vs ASCII ~7px in our font,
// so a 2000-char English message fills ~40% the screen area of a 2000-char
// Chinese one. Sample first 300 chars and return ratio in [0, 1].
function cjkRatio(s: string): number {
  const n = Math.min(s.length, 300);
  if (n === 0) return 1; // empty → treat as CJK to avoid div-by-zero issues
  let cjk = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x309F) ||
        (c >= 0x30A0 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7AF)) cjk++;
  }
  return cjk / n;
}

/**
 * ForgeText — markdown-or-typewriter text block with fold/expand.
 *
 * Props:
 *   text       — body
 *   animated   — when true, TypewriterText renders cursor + step-dump tail
 *                animation (used while streaming). When false, rendering
 *                delegates to MarkdownView via TypewriterText's internal swap.
 *   size       — visual variant. 'md' (default) uses .kc-text / .kc-text-folded.
 *                'sm' would use .mp-sm-* CSS variants (added in a later commit).
 *
 * Fold logic: text is foldable when !animated AND length > viewport-adjusted
 * threshold. Equivalent to the previous `status !== 'running'` rule under the
 * mapping `animated = status === 'running'`.
 */
export function ForgeText({
  text,
  animated,
  size = 'md',
}: {
  text: string;
  animated: boolean;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const threshold = useFoldThreshold();
  // Adjust per-text: pure English text (cjkR=0) gets threshold × 2.5; pure
  // Chinese (cjkR=1) gets threshold × 1. Linear interp via 1 / (0.4 + 0.6r).
  const adjustedThreshold = Math.floor(threshold / (0.4 + 0.6 * cjkRatio(text)));
  const foldable = !animated && text.length > adjustedThreshold;
  const folded = foldable && !expanded;
  const toggleRef = useRef<HTMLButtonElement>(null);
  // After expand, re-anchor the toggle with scrollIntoView so the user keeps
  // spatial continuity. Double RAF guarantees React has committed + browser has
  // done layout before we measure. 'behavior' downgrades to 'instant' when
  // prefers-reduced-motion is set.
  const onToggle = () => {
    setExpanded((v) => !v);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        toggleRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'instant' : 'smooth' });
      });
    });
  };
  // size === 'sm' currently shares .kc-text* class names; .mp-sm-* variant
  // CSS will be added in a follow-up commit when SubAgentCard starts consuming
  // size='sm'. For now md = sm visually (no SubAgentCard caller yet).
  const cls = `kc-text ${folded ? 'kc-text-folded' : ''}${size === 'sm' ? ' mp-sm' : ''}`;
  return (
    <div className={cls}>
      <TypewriterText text={text} animated={animated} />
      {foldable && (
        <button
          type="button"
          ref={toggleRef}
          className="kc-fold-toggle"
          onClick={onToggle}
        >
          {expanded ? t('forgeText.collapse') : t('forgeText.expand', { count: text.length })}
        </button>
      )}
    </div>
  );
}
