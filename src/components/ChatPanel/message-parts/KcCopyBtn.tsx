import { useState } from 'react';
import { CheckCircle2, Copy } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';

// Strip markdown syntax to plain text for clipboard. Users paste into
// Slack/Notion/editors that don't auto-parse markdown — `**bold**` showing
// literally is jarring. Code-block fences drop but body preserved; links
// flatten to `text (url)`; task checkboxes normalize to ✓/☐.
function stripMarkdown(s: string): string {
  return s
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^(\s*[-*]\s)\[x\]\s/gim, '$1✓ ')
    .replace(/^(\s*[-*]\s)\[ \]\s/gm, '$1☐ ')
    // GFM table separator row — drop entirely.
    .replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]+\|?[ \t]*$/gm, '')
    // GFM table data row — re-join cells with ` · `.
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, body: string) =>
      body.split('|').map((c) => c.trim()).filter(Boolean).join(' · '))
    // CommonMark `***x***` = bold+italic combined — handle first.
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
    .replace(/___([^_\n]+)___/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * KcCopyBtn — message-level copy button. Complements per-code-block Copy in
 * CodeBlock.tsx by letting users grab the whole assistant reply (plain text,
 * markdown stripped) without manual selection.
 *
 * stopPropagation is critical — the parent kc-header toggles collapse.
 *
 * Props:
 *   text — markdown source to strip + copy
 *   size — visual variant ('md' default; 'sm' uses .mp-sm-* CSS variants)
 */
export function KcCopyBtn({ text, size = 'md' }: { text: string; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const out = stripMarkdown(text);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(out);
      else {
        const ta = document.createElement('textarea');
        ta.value = out; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied; user can retry */ }
  };
  const smCls = size === 'sm' ? ' mp-sm' : '';
  return (
    <button type="button" className={`kc-copy-btn${smCls}`} onClick={onCopy} title={t('kcCopyBtn.copyMessage')}>
      {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
