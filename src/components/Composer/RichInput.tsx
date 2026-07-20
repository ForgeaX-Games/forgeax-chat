import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { parseSegments, type PillPayload, encodePill } from '@forgeax/interface/lib/composer-bridge';
import './RichInput.css';

// === Pasted-text folding (the reference agent CLI style: "[Pasted text #N +M lines]") ===
//
// A big paste would otherwise flood the composer with hundreds of lines. Instead
// we collapse it into a compact pill chip and keep the FULL text inside the
// pill's `detail`, which `expandPills()` (session-store submit path) restores
// verbatim before the message reaches the model. This reuses the existing pill
// machinery, so there's no separate side-store to keep in sync — the value
// string stays the single source of truth.
//
// Trigger mirrors the reference agent CLI: paste is folded when it exceeds a character
// budget OR spans more lines than we want to show inline.
const PASTE_FOLD_CHAR_THRESHOLD = 800;
const PASTE_FOLD_MAX_LINES = 6;

/** Count added lines the way the reference agent CLI does: "a\nb\nc" → 2 (newline count). */
function pastedTextNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length;
}

/** Build a folded-paste pill. `detail` holds the original text so it expands
 *  back to the raw paste on send; `display` is the compact chip label. */
function buildPastedTextPill(text: string, id: number): PillPayload {
  const numLines = pastedTextNumLines(text);
  const display = numLines === 0 ? `Pasted text #${id}` : `Pasted text #${id} +${numLines} lines`;
  const previewLines = text.split(/\r\n|\r|\n/).slice(0, 6);
  const preview = previewLines.join('\n') + (previewLines.length < text.split(/\r\n|\r|\n/).length ? '\n…' : '');
  return {
    kind: 'paste',
    display,
    icon: '📋',
    // On send this is substituted back in place of the chip → model sees raw text.
    detail: text,
    tooltip: { title: `📋 ${display}`, lines: [`${text.length} chars`, '---', preview] },
  };
}

/** Build a pill for a text file dropped/pasted into the composer. Same
 *  machinery as the folded-paste pill, but labeled with the filename and with
 *  `detail` prefixed by a file header so the model knows where the text came
 *  from. `expandPills()` on send restores the whole thing verbatim. */
export function buildPastedFilePill(name: string, text: string): PillPayload {
  const numLines = text.split(/\r\n|\r|\n/).length;
  const previewLines = text.split(/\r\n|\r|\n/).slice(0, 6);
  const preview = previewLines.join('\n') + (previewLines.length < numLines ? '\n…' : '');
  return {
    kind: 'paste',
    display: `${name} (${numLines} lines)`,
    icon: '📄',
    detail: `[Attached file: ${name}]\n${text}`,
    tooltip: { title: `📄 ${name}`, lines: [`${text.length} chars`, '---', preview] },
  };
}

/** Next paste id for the current buffer: 1 + the max existing "Pasted text #N"
 *  chip in `root`. Numbering restarts per message (buffer clears on send), and
 *  never collides within a message. */
function nextPastedTextId(root: HTMLElement): number {
  let max = 0;
  root.querySelectorAll<HTMLElement>('[data-pill="1"][data-pill-kind="paste"]').forEach((el) => {
    const m = /Pasted text #(\d+)/.exec(el.querySelector('.kbl-pill-label')?.textContent ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  });
  return max + 1;
}

export interface RichInputHandle {
  focus(): void;
  blur(): void;
  getValue(): string;
  setValue(v: string): void;
  insertText(text: string): void;
  insertPill(p: PillPayload): void;
  /** Best-effort caret positions in the serialized (sentinel-string) form. */
  selectionStart(): number;
  selectionEnd(): number;
  setSelection(start: number, end?: number): void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  /** Pasted files (a screenshot, or a file copied in the OS file manager).
   *  When file items are present in the clipboard we hand them up rather than
   *  inserting text — the composer classifies image vs text vs unsupported. */
  onPasteFiles?: (files: File[]) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

// === Serialization helpers ===

/** Walk the editable div in document order and rebuild the sentinel-string. */
function readValue(root: HTMLElement): string {
  let out = '';
  const visit = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue ?? '';
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.tagName === 'BR') { out += '\n'; return; }
    if (el.dataset.pill === '1' && el.dataset.pillToken) { out += el.dataset.pillToken; return; }
    for (const c of Array.from(el.childNodes)) visit(c);
    // Browsers may wrap newlines in <div> blocks; emit a trailing newline so
    // round-trips don't collapse linebreaks. Skip the outermost root.
    if (el !== root && (el.tagName === 'DIV' || el.tagName === 'P')) out += '\n';
  };
  for (const c of Array.from(root.childNodes)) visit(c);
  return out;
}

/** Render a sentinel-string into the editable div as text nodes + chip spans. */
function writeValue(root: HTMLElement, value: string): void {
  root.replaceChildren();
  const segs = parseSegments(value);
  for (const s of segs) {
    if (s.kind === 'text') {
      const parts = s.text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) root.appendChild(document.createTextNode(parts[i]));
        if (i < parts.length - 1) root.appendChild(document.createElement('br'));
      }
    } else {
      root.appendChild(buildChipNode(s.payload, s.token));
    }
  }
}

function buildChipNode(payload: PillPayload, token: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `kbl-pill kbl-pill-${payload.kind}`;
  span.contentEditable = 'false';
  span.dataset.pill = '1';
  span.dataset.pillKind = payload.kind;
  span.dataset.pillToken = token;
  span.setAttribute('role', 'img');
  span.title = [payload.tooltip.title, ...payload.tooltip.lines, '---', payload.detail].join('\n');

  const icon = document.createElement('span');
  icon.className = 'kbl-pill-icon';
  icon.textContent = payload.icon ?? '🔖';
  span.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'kbl-pill-label';
  label.textContent = payload.display;
  span.appendChild(label);

  return span;
}

/** Place the caret immediately after the given node. */
function placeCaretAfter(node: Node): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Place caret at end of root. */
function placeCaretAtEnd(root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// === Component ===

export const RichInput = forwardRef<RichInputHandle, Props>(function RichInput(
  { value, onChange, onKeyDown, onCompositionStart, onCompositionEnd, onPasteFiles, placeholder, className, disabled },
  ref,
) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const lastValueRef = useRef<string>(value);
  const composingRef = useRef<boolean>(false);

  // External value → DOM reconciliation. Only writes when the prop changed AND
  // the current DOM serialization disagrees. Avoids cursor jumps on every
  // keystroke because onInput->onChange feeds value back into us.
  useLayoutEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const dom = readValue(el);
    if (value !== dom) {
      writeValue(el, value);
      lastValueRef.current = value;
    }
  }, [value]);

  const fireChange = () => {
    const el = divRef.current;
    if (!el) return;
    const v = readValue(el);
    if (v === lastValueRef.current) return;
    lastValueRef.current = v;
    onChange(v);
  };

  const insertNodeAtCaret = (node: Node) => {
    const el = divRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    // Capture the last real child BEFORE insertion — DocumentFragments lose
    // their children to the host on insertNode, so `node` itself ends up
    // parentless and setStartAfter() throws.
    const lastInserted: Node | null =
      node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ? (node as DocumentFragment).lastChild
        : node;
    range.insertNode(node);
    if (lastInserted && lastInserted.parentNode) placeCaretAfter(lastInserted);
    fireChange();
  };

  useImperativeHandle(ref, (): RichInputHandle => ({
    focus: () => divRef.current?.focus(),
    blur: () => divRef.current?.blur(),
    getValue: () => (divRef.current ? readValue(divRef.current) : ''),
    setValue: (v) => {
      const el = divRef.current; if (!el) return;
      writeValue(el, v);
      lastValueRef.current = v;
      onChange(v);
    },
    insertText: (text) => {
      const el = divRef.current; if (!el) return;
      const parts = text.split('\n');
      const frag = document.createDocumentFragment();
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) frag.appendChild(document.createTextNode(parts[i]));
        if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
      }
      insertNodeAtCaret(frag);
    },
    insertPill: (payload) => {
      const token = encodePill(payload);
      const chip = buildChipNode(payload, token);
      // Trailing space lets the caret land on plain text so the next keystroke
      // doesn't end up "inside" the chip.
      const frag = document.createDocumentFragment();
      frag.appendChild(chip);
      frag.appendChild(document.createTextNode(' '));
      insertNodeAtCaret(frag);
    },
    selectionStart: () => caretOffset(divRef.current, true),
    selectionEnd: () => caretOffset(divRef.current, false),
    setSelection: (start, end) => {
      const el = divRef.current; if (!el) return;
      setCaretFromOffsets(el, start, end ?? start);
    },
  }));

  const handleInput = () => {
    if (composingRef.current) return;
    fireChange();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) { e.preventDefault(); return; }
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    // Default contenteditable behavior on Enter creates a <div> wrapper which
    // is awkward to serialize. We intercept any Enter that survives the
    // parent's onKeyDown (i.e. the parent decided NOT to submit) and insert
    // a plain <br> instead.
    if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault();
      insertNodeAtCaret(document.createElement('br'));
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // File paste (a screenshot on the clipboard, or a file copied in the OS
    // file manager) — the clipboard exposes it as file item(s), not text/plain.
    // Hand the files up so the composer can attach them; the default
    // contenteditable behavior would drop them.
    const pastedFiles: File[] = [];
    for (const it of Array.from(e.clipboardData.items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) pastedFiles.push(f);
      }
    }
    if (pastedFiles.length > 0 && onPasteFiles) {
      e.preventDefault();
      onPasteFiles(pastedFiles);
      return;
    }
    // Strip rich formatting on paste — contenteditable's default is to keep
    // HTML which can pollute the editor with arbitrary styles. We want plain
    // text only; pills are inserted via the imperative API, never via paste.
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;

    // Big paste → fold into a "[Pasted text #N +M lines]" chip (the reference agent CLI
    // style). The full text rides inside the pill's `detail`, so expandPills()
    // on send restores it verbatim. A trailing space lets the caret land on
    // plain text after the chip.
    const numLines = pastedTextNumLines(text);
    if (text.length > PASTE_FOLD_CHAR_THRESHOLD || numLines > PASTE_FOLD_MAX_LINES) {
      const id = divRef.current ? nextPastedTextId(divRef.current) : 1;
      const payload = buildPastedTextPill(text, id);
      const token = encodePill(payload);
      const chip = buildChipNode(payload, token);
      const frag = document.createDocumentFragment();
      frag.appendChild(chip);
      frag.appendChild(document.createTextNode(' '));
      insertNodeAtCaret(frag);
      return;
    }

    const parts = text.split('\n');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length > 0) frag.appendChild(document.createTextNode(parts[i]));
      if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
    }
    insertNodeAtCaret(frag);
  };

  // Re-focus after disabled flips off (matches the old textarea's behavior in
  // Composer.tsx :628 useEffect on isStreaming).
  useEffect(() => {
    if (!disabled) divRef.current?.focus();
  }, [disabled]);

  return (
    <div
      ref={divRef}
      className={`kbl-rich-input ${className ?? ''} ${disabled ? 'is-disabled' : ''}`}
      contentEditable={!disabled}
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder ?? ''}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onCompositionStart={() => { composingRef.current = true; onCompositionStart?.(); }}
      onCompositionEnd={() => { composingRef.current = false; onCompositionEnd?.(); fireChange(); }}
      onBlur={fireChange}
      suppressContentEditableWarning
      spellCheck={false}
    />
  );
});

// === Caret offset helpers (count by serialized chars) ===

function caretOffset(root: HTMLElement | null, isStart: boolean): number {
  if (!root) return 0;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const node = isStart ? range.startContainer : range.endContainer;
  const offset = isStart ? range.startOffset : range.endOffset;
  if (!root.contains(node) && node !== root) return 0;
  let count = 0;
  const walk = (n: Node): boolean => {
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) count += offset;
      else count += offsetIntoChildren(n, offset);
      return true;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      count += n.nodeValue?.length ?? 0;
      return false;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return false;
    const el = n as HTMLElement;
    if (el.tagName === 'BR') { count += 1; return false; }
    if (el.dataset.pill === '1' && el.dataset.pillToken) { count += el.dataset.pillToken.length; return false; }
    for (const c of Array.from(el.childNodes)) {
      if (walk(c)) return true;
    }
    return false;
  };
  walk(root);
  return count;
}

function offsetIntoChildren(parent: Node, idx: number): number {
  let count = 0;
  const children = Array.from(parent.childNodes).slice(0, idx);
  for (const c of children) {
    if (c.nodeType === Node.TEXT_NODE) count += c.nodeValue?.length ?? 0;
    else if (c.nodeType === Node.ELEMENT_NODE) {
      const el = c as HTMLElement;
      if (el.tagName === 'BR') count += 1;
      else if (el.dataset.pill === '1' && el.dataset.pillToken) count += el.dataset.pillToken.length;
      else count += (el.textContent ?? '').length;
    }
  }
  return count;
}

function setCaretFromOffsets(root: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const startPos = locateOffset(root, start);
  const endPos = locateOffset(root, end);
  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

function locateOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
  let count = 0;
  const walk = (n: Node): { node: Node; offset: number } | null => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.nodeValue?.length ?? 0;
      if (count + len >= target) return { node: n, offset: Math.max(0, target - count) };
      count += len;
      return null;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return null;
    const el = n as HTMLElement;
    if (el.tagName === 'BR') {
      if (count + 1 >= target) return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 };
      count += 1;
      return null;
    }
    if (el.dataset.pill === '1' && el.dataset.pillToken) {
      const len = el.dataset.pillToken.length;
      if (count + len >= target) return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 };
      count += len;
      return null;
    }
    for (const c of Array.from(el.childNodes)) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  const result = walk(root);
  if (result) return result;
  // Fallback: end of root
  placeCaretAtEnd(root);
  const sel = window.getSelection();
  const r = sel?.getRangeAt(0);
  return { node: r?.endContainer ?? root, offset: r?.endOffset ?? 0 };
}
