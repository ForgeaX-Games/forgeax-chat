import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CheckCircle2, Loader2, AlertCircle, Wrench } from 'lucide-react';
import { useTranslation } from '@forgeax/interface/i18n';
import type { ToolCall } from '../../../session-store';

const TC_PREVIEW_LIMIT = 2000;

// Per-tool arg priority: for glob/grep the search pattern is more telling than
// the (often verbose) path; for file ops the file path is the key info; for
// bash/admin_shell the command itself.
const ARG_PRIORITY_BY_TOOL: Record<string, string[]> = {
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  read_file: ['file_path', 'path'],
  write_file: ['file_path', 'path'],
  edit_file: ['file_path', 'path'],
  multi_edit: ['file_path', 'path'],
  apply_patch: ['file_path', 'path'],
  list_dir: ['path'],
  bash: ['command'],
  admin_shell: ['command'],
  run_on_host: ['command'],
  web_fetch: ['url', 'query'],
  web_search: ['query'],
  send_media: ['file_path', 'path', 'url'],
  subagent: ['template', 'name', 'prompt'],
  set_role: ['role', 'name'],
  create_agent: ['name', 'template'],
};

const ARG_PRIORITY_RULES: Array<[RegExp, string[]]> = [
  [/(?:^|_)(?:db|sql|mysql|sqlite|postgres|mongo|redis)(?:$|_)/i, ['query', 'sql', 'statement', 'table']],
  [/(?:glob|grep|search|find)/i, ['pattern', 'query', 'path']],
  [/(?:read|write|edit|patch|append|insert)_?|_file\b/i, ['file_path', 'path']],
  [/(?:bash|shell|exec|run|command)/i, ['command']],
  [/(?:fetch|http|request|api|url)/i, ['url', 'query']],
  [/(?:list|dir|ls|tree)/i, ['path']],
  [/(?:web|browser|navigate|screenshot|click)/i, ['url', 'selector', 'query']],
  [/(?:agent|subagent|spawn|role|template)/i, ['template', 'name', 'prompt']],
  [/(?:send|message|notify|publish|emit)/i, ['message', 'text', 'body']],
];
const ARG_PRIORITY_DEFAULT = ['path', 'file_path', 'pattern', 'command', 'url', 'query', 'message', 'name'];

function argPreview(tc: ToolCall): string {
  const a = tc.args as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== 'object') return '';
  let keys = ARG_PRIORITY_BY_TOOL[tc.name];
  if (!keys) {
    const rule = ARG_PRIORITY_RULES.find(([re]) => re.test(tc.name));
    keys = rule ? rule[1] : ARG_PRIORITY_DEFAULT;
  }
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string' && v.length > 0) return v.length > 60 ? v.slice(0, 57) + '…' : v;
  }
  const firstStr = Object.values(a).find((v) => typeof v === 'string' && v.length > 0) as string | undefined;
  if (firstStr) return firstStr.length > 60 ? firstStr.slice(0, 57) + '…' : firstStr;
  return '';
}

// JSON pretty-printer with JSONL support. Object/array bodies get 2-space
// indent; bare JSON values (string/number/bool/null) keep their original form
// but flag isJson so the syntax tokenizer kicks in for color.
function maybePrettyJson(s: string): { text: string; isJson: boolean } {
  const trimmed = s.trim();
  if (!trimmed) return { text: s, isJson: false };
  const first = trimmed[0];
  if (trimmed.includes('\n')) {
    const lines = trimmed.split('\n').filter((l) => l.trim());
    if (lines.length >= 2 && lines.every((l) => /^\s*[{\[]/.test(l))) {
      try {
        const parsed = lines.map((l) => JSON.parse(l));
        return { text: parsed.map((p) => JSON.stringify(p, null, 2)).join('\n\n'), isJson: true };
      } catch { /* not actually JSONL — fall through */ }
    }
  }
  if (first === '{' || first === '[') {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== 'object' || obj === null) return { text: s, isJson: false };
      return { text: JSON.stringify(obj, null, 2), isJson: true };
    } catch { /* not JSON — fall through */ }
  }
  if (first === '"' || /^(?:true|false|null|-?\d)/.test(trimmed)) {
    try { JSON.parse(trimmed); return { text: s, isJson: true }; } catch { /* not JSON */ }
  }
  return { text: s, isJson: false };
}

// Lightweight JSON syntax highlighter — single regex alternation, no AST.
function tokenizeJson(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /"(?:\\.|[^"\\])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `j${n++}`;
    if (m[1] !== undefined) {
      out.push(<span key={k} className="jh-key">{m[0].slice(0, -m[1].length)}</span>);
      out.push(m[1]);
    } else if (m[0][0] === '"') {
      out.push(<span key={k} className="jh-str">{m[0]}</span>);
    } else if (m[0] === 'true' || m[0] === 'false') {
      out.push(<span key={k} className="jh-bool">{m[0]}</span>);
    } else if (m[0] === 'null') {
      out.push(<span key={k} className="jh-null">{m[0]}</span>);
    } else {
      out.push(<span key={k} className="jh-num">{m[0]}</span>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Convert raw byte count to human-friendly unit. <1KB → '512 B'; 1KB-1MB → '12.4 KB'; ≥1MB → '1.2 MB'.
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * ToolChipRow — a single tool invocation chip with expandable result panel.
 *
 * Props:
 *   tc   — ToolCall from the store
 *   size — visual variant ('md' default; 'sm' uses .mp-sm-* CSS variants
 *          added in a follow-up commit for SubAgentCard).
 */
const TAIL_LINES = 5;

export function ToolChipRow({ tc, size = 'md' }: { tc: ToolCall; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const userToggledRef = useRef(false);
  const wasStreamingRef = useRef(false);

  const streamingRaw = tc.status === 'running' && typeof tc.args === 'string' && tc.args.length > 0
    ? tc.args : '';
  const streamingContent = useMemo(() => extractStreamingContent(tc.name, streamingRaw), [tc.name, streamingRaw]);
  const isStreaming = tc.status === 'running' && streamingContent.length > 0;

  // Rolling tail: only show last N lines during streaming
  const streamingTail = useMemo(() => {
    if (!isStreaming) return '';
    const lines = streamingContent.split('\n');
    return lines.length > TAIL_LINES ? lines.slice(-TAIL_LINES).join('\n') : streamingContent;
  }, [isStreaming, streamingContent]);

  // Auto-open when streaming starts; auto-collapse when streaming ends
  useEffect(() => {
    if (isStreaming && !open && !userToggledRef.current) {
      setOpen(true);
      wasStreamingRef.current = true;
    }
    if (!isStreaming && wasStreamingRef.current && !userToggledRef.current) {
      setOpen(false);
      wasStreamingRef.current = false;
    }
  }, [isStreaming, open]);

  const handleToggle = () => {
    userToggledRef.current = true;
    setOpen((v) => !v);
  };

  const detail = tc.result ?? tc.error ?? '';
  const hasDetail = (tc.status === 'done' || tc.status === 'error') && detail.length > 0;
  const hasContent = hasDetail || isStreaming;
  const pretty = hasDetail ? maybePrettyJson(detail) : { text: streamingTail, isJson: false };
  const isLong = !isStreaming && pretty.text.length > TC_PREVIEW_LIMIT;
  const displayed = isLong && !showAll ? pretty.text.slice(0, TC_PREVIEW_LIMIT) : pretty.text;
  const argP = argPreview(tc);
  const fullText = hasDetail ? (maybePrettyJson(detail)).text : '';
  const totalBytes = useMemo(() => new TextEncoder().encode(fullText).length, [fullText]);
  const totalLines = useMemo(() => fullText.split('\n').length, [fullText]);
  const smCls = size === 'sm' ? ' mp-sm' : '';
  return (
    <div className={`tool-chip-wrap ${open ? 'expanded' : ''}${smCls}`}>
      <button
        type="button"
        className={`tool-chip tool-${tc.status} ${hasContent || hasDetail ? 'clickable' : ''}${smCls}`}
        onClick={() => (hasContent || hasDetail) && handleToggle()}
        disabled={!hasContent && !hasDetail}
      >
        <Wrench size={12} className="tc-icon" />
        <span className="tc-name">{tc.name}</span>
        {argP && <span className="tc-arg" title={argP}>{argP}</span>}
        {tc.status === 'running' && <Loader2 size={12} className="spin" />}
        {tc.status === 'done' && <CheckCircle2 size={12} />}
        {tc.status === 'error' && <AlertCircle size={12} />}
        {(hasContent || hasDetail) && !isStreaming && (open ? <ChevronUp size={12} className="tc-toggle" /> : <ChevronDown size={12} className="tc-toggle" />)}
      </button>
      {open && (hasContent || hasDetail) && (
        <>
          <pre className={`tc-result ${tc.status === 'error' ? 'is-error' : ''} ${isStreaming ? 'is-streaming' : ''} ${showAll ? 'is-expanded' : ''}${smCls}`}>
            {!isStreaming && pretty.isJson && <span className="tc-result-badge">json</span>}
            {!isStreaming && pretty.isJson ? tokenizeJson(displayed) : displayed}
            {isStreaming && <span className="tc-cursor" />}
          </pre>
          {isLong && !isStreaming && (
            <button
              type="button"
              className={`tc-result-toggle${smCls}`}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? t('toolChip.collapse', { chars: fullText.length, lines: totalLines, bytes: fmtBytes(totalBytes) })
                : t('toolChip.viewAll', { chars: fullText.length - TC_PREVIEW_LIMIT, lines: totalLines, bytes: fmtBytes(totalBytes) })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Extract meaningful content from partial JSON args string for live display.
 *  For write_file/edit_file, show the content/new_string being written.
 *  For shell/bash, show the command. For others, show raw truncated args. */
function extractStreamingContent(toolName: string, raw: string): string {
  if (!raw) return '';
  // For file-writing tools, try to extract the content field value
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'multi_edit') {
    const contentKeys = ['"content":', '"new_string":', '"new_content":'];
    for (const key of contentKeys) {
      const idx = raw.lastIndexOf(key);
      if (idx < 0) continue;
      const afterKey = raw.slice(idx + key.length).trimStart();
      if (afterKey.startsWith('"')) {
        // Extract the string value (may be partial/unterminated)
        return unescapePartialJsonString(afterKey.slice(1));
      }
    }
  }
  // For shell tools, extract command
  if (toolName === 'shell' || toolName === 'bash' || toolName === 'admin_shell') {
    const idx = raw.indexOf('"command":');
    if (idx >= 0) {
      const after = raw.slice(idx + '"command":'.length).trimStart();
      if (after.startsWith('"')) return unescapePartialJsonString(after.slice(1));
    }
  }
  // Fallback: show raw (truncated) for any tool with streaming args
  if (raw.length > 200) return raw.slice(0, 200) + '…';
  return raw;
}

function unescapePartialJsonString(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') { out += '\n'; i += 2; }
      else if (next === 't') { out += '\t'; i += 2; }
      else if (next === '"') { out += '"'; i += 2; }
      else if (next === '\\') { out += '\\'; i += 2; }
      else if (next === '/') { out += '/'; i += 2; }
      else { out += s[i]; i++; }
    } else if (s[i] === '"') {
      break; // end of JSON string value
    } else {
      out += s[i]; i++;
    }
  }
  return out;
}
