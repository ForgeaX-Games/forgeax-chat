import type { ToolCall } from '../../../session-store';

/**
 * Time-ordered interleave segment — pure computation, no React.
 *
 * Output element is either:
 *   - `{ kind: 'text', value: string }` — a slice of the source `text`
 *   - `{ kind: 'tool', value: ToolCall }` — a tool call to render inline
 *
 * Callers (ForgeCard, SubAgentCard) decide which component renders each kind.
 * This keeps the algorithm reusable across main/sub bubbles with different
 * size variants of ForgeText / ToolChipRow.
 */
export type InterleaveSegment =
  | { kind: 'text'; value: string }
  | { kind: 'tool'; value: ToolCall };

/**
 * Snap a raw char offset to a "natural" boundary so the tool chip doesn't land
 * mid-word or mid-paragraph (reads as a jarring cut). Priority:
 *   ① back to \n\n    (within ±80)
 *   ② forward to \n\n (within ±80)
 *   ③ back to sentence end (。．.！!？?) within ±200
 *   ④ back to \n        within ±200
 *   ⑤ back to whitespace (space/tab) within ±200
 *   ⑥ raw fallback
 *
 * Whitespace fallback (iter-81) handles 200+ char dense ASCII text (URLs,
 * code) where the prior fallback to raw cut mid-token.
 */
function snap(raw: number, text: string): number {
  if (raw >= text.length) return text.length;
  if (raw <= 0) return 0;
  const lo = Math.max(0, raw - 200);
  const hi = Math.min(text.length, raw + 200);
  // Paragraph snap bounded ±80: pushing tool chip >80 chars loses temporal
  // fidelity. Long reflection segments >80 chars without internal \n\n fall
  // through to sentence/line/space (also <200-char snaps).
  const paraLo = Math.max(0, raw - 80);
  const paraHi = Math.min(text.length, raw + 80);
  for (let i = raw - 1; i > paraLo; i--) {
    if (text[i] === '\n' && text[i - 1] === '\n') return i + 1;
  }
  for (let i = raw; i < paraHi - 1; i++) {
    if (text[i] === '\n' && text[i + 1] === '\n') return i + 2;
  }
  for (let i = raw - 1; i > lo; i--) {
    if ('。．.！!？?'.includes(text[i])) return i + 1;
  }
  for (let i = raw - 1; i > lo; i--) {
    if (text[i] === '\n') return i + 1;
  }
  for (let i = raw - 1; i > lo; i--) {
    if (text[i] === ' ' || text[i] === '\t') return i + 1;
  }
  return raw;
}

/**
 * Build interleaved segments by splicing `ordered` tool calls into `text` at
 * their `tc.at` positions (after snap()-ing to natural boundaries).
 *
 * `ordered` must be tool calls with `typeof at === 'number'`, pre-sorted
 * ascending. Caller is expected to have filtered orphan tools (typeof at !==
 * 'number') and render them separately at the end.
 */
export function buildInterleavedSegments(text: string, ordered: ToolCall[]): InterleaveSegment[] {
  const segments: InterleaveSegment[] = [];
  let cursor = 0;
  for (const tc of ordered) {
    const raw = Math.min(text.length, tc.at ?? text.length);
    const at = Math.max(cursor, snap(raw, text));
    if (at > cursor) segments.push({ kind: 'text', value: text.slice(cursor, at) });
    segments.push({ kind: 'tool', value: tc });
    cursor = at;
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) });
  return segments;
}

/**
 * Partition toolCalls into (ordered with valid `at`) + (orphans).
 *
 * Convenience helper so callers don't repeat the filter/sort/dedup logic.
 */
export function partitionToolCalls(toolCalls: ToolCall[]): {
  ordered: ToolCall[];
  orphans: ToolCall[];
} {
  const ordered = toolCalls
    .filter((t) => typeof t.at === 'number')
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const orphans = toolCalls.filter((t) => typeof t.at !== 'number');
  return { ordered, orphans };
}
