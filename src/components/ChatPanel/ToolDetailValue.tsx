import { useState } from 'react';
import { getLocale } from '@forgeax/interface/i18n';

/** Plain React text only: tool output never becomes executable markup. */
export function ToolDetailValue({ text, diff = false }: { text: string; diff?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 1200 || text.split('\n').length > 16;
  let structured: unknown;
  if (!diff) {
    try { structured = JSON.parse(text); } catch { /* Plain prose or code. */ }
  }
  const object = structured !== null && typeof structured === 'object';
  const envelope = object && 'jsonrpc' in (structured as object) && 'result' in (structured as object)
    ? structured as { result: unknown } : null;
  const shown = long && !expanded ? text.slice(0, 1200).split('\n').slice(0, 16).join('\n') : text;
  return <div className="tx-value">
    {object ? <><StructuredValue value={envelope ? envelope.result : structured} depth={0} />{envelope && <details className="tx-transport-details"><summary>{getLocale() === 'zh' ? '协议详情' : 'Protocol details'}</summary><StructuredValue value={Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'result'))} depth={0} /></details>}</>
      : <pre className="tx-tool-detail-content">{diff ? shown.split('\n').map((line, index) =>
        <span key={index} className={line.startsWith('+') ? 'tx-code-add' : line.startsWith('-') ? 'tx-code-remove' : line.startsWith('@@') ? 'tx-code-range' : undefined}>{line}{'\n'}</span>) : shown}</pre>}
    {long && !object && <button type="button" className="tx-value-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {getLocale() === 'zh' ? (expanded ? '收起' : `展开完整内容 · ${text.length.toLocaleString()} 字符`) : (expanded ? 'Show less' : `Show all · ${text.length.toLocaleString()} characters`)}
    </button>}
  </div>;
}

function StructuredValue({ value, depth }: { value: unknown; depth: number }) {
  const [limit, setLimit] = useState(20);
  if (value === null || typeof value !== 'object') return <span className="tx-data-scalar">{value === null ? 'null' : String(value)}</span>;
  if (depth >= 4) return <pre className="tx-tool-detail-content">{JSON.stringify(value, null, 2)}</pre>;
  const entries = Object.entries(value);
  if (!entries.length) return <span className="tx-data-scalar">{Array.isArray(value) ? '[]' : '{}'}</span>;
  return <dl className="tx-data-fields">{entries.slice(0, limit).map(([key, child]) => <div key={key} className="tx-data-field">
    {child !== null && typeof child === 'object' ? <NestedValue label={key} value={child} depth={depth} /> : <><dt>{key}</dt><dd><StructuredValue value={child} depth={depth + 1} /></dd></>}
  </div>)}{entries.length > limit && <button type="button" className="tx-value-toggle" onClick={() => setLimit(count => count + 20)}>{getLocale() === 'zh' ? '显示更多' : 'Show more'} · {entries.length - limit}</button>}</dl>;
}

function NestedValue({ label, value, depth }: { label: string; value: object; depth: number }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}<span className="tx-data-count">{Object.keys(value).length}</span></summary>
    {open && <StructuredValue value={value} depth={depth + 1} />}
  </details>;
}
