// Minimal markdown renderer for assistant text. No external deps; handles the
// patterns that appear in @forgeax/orchestrator output: bold/italic, inline code, fenced
// code blocks, headings, ordered/unordered lists, blockquotes, links, hr.
// When the agent emits richer markdown we'll graduate to react-markdown — until
// then, the goal is "make `**bold**` actually bold" without pulling in a tree.

import { useTranslation } from "@forgeax/chat/runtime";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	SOFT_REFLECTION_RE,
	STRONG_CORR_RE,
	STRONG_REFLECTION_RE,
} from "./reflection-i18n";

// Copy-on-hover button for fenced code blocks. Tries the async clipboard
// API first, falls back to the synchronous textarea+execCommand path used
// in older browsers / non-secure iframe contexts.
function copyToClipboard(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		return navigator.clipboard
			.writeText(text)
			.then(() => true)
			.catch(() => fallback(text));
	}
	return Promise.resolve(fallback(text));
	function fallback(t: string): boolean {
		try {
			const ta = document.createElement("textarea");
			ta.value = t;
			ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			const ok = document.execCommand("copy");
			document.body.removeChild(ta);
			return ok;
		} catch {
			return false;
		}
	}
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
	const [copied, setCopied] = useState(false);
	const onCopy = async () => {
		const ok = await copyToClipboard(body);
		if (ok) {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		}
	};
	return (
		<div className="md-code-wrap">
			{lang && <span className="md-code-lang">{lang}</span>}
			<button
				type="button"
				className="md-copy-btn"
				onClick={onCopy}
				aria-label="Copy code"
			>
				{copied ? "✓ Copied" : "Copy"}
			</button>
			<pre className="md-code">
				<code data-lang={lang || undefined}>{body}</code>
			</pre>
		</div>
	);
}

type SourceText = { sourceOffset: number; text: string };

type BlockData =
	| { kind: "para"; lines: SourceText[]; reflection?: boolean }
	| { kind: "heading"; level: number; text: string }
	| { kind: "code"; lang: string; body: string }
	| { kind: "ul"; items: SourceText[] }
	| { kind: "ol"; items: SourceText[] }
	| { kind: "quote"; lines: SourceText[] }
	| {
			kind: "table";
			header: SourceText[];
			rows: SourceText[][];
			aligns: Array<"left" | "center" | "right">;
	  }
	| { kind: "hr" };

type Block = BlockData & { sourceOffset: number };

// GFM table: row starts with `|`, has `|` separators, and next line is a
// separator row like `|---|---:|:--:|` (cells made of -, :, |). We split on
// `|` and drop the leading/trailing empty cells (rows are wrapped in pipes).
function splitTableRow(line: string, sourceOffset = 0): SourceText[] {
	const trimmed = line.trim();
	const leadingWhitespace = line.indexOf(trimmed);
	const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	const contentOffset =
		sourceOffset + leadingWhitespace + (trimmed.startsWith("|") ? 1 : 0);
	let offset = contentOffset;
	return content.split("|").map((cell) => {
		const text = cell.trim();
		const cellOffset = offset + cell.indexOf(text);
		offset += cell.length + 1;
		return { sourceOffset: cellOffset, text };
	});
}
// GFM table separator cell → column alignment. `:---:` center, `---:` right,
// `:---` or plain `---` left. Defensive: empty/short cells default left.
function parseTableAligns(sepRow: string): Array<"left" | "center" | "right"> {
	return splitTableRow(sepRow).map(({ text }) => {
		const left = text.startsWith(":");
		const right = text.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		return "left";
	});
}

// Heuristic: detect "self-correction / second thought" paragraphs that
// @forgeax/orchestrator produces between hook:assistantMessage steps. Two tiers reduce
// false positives: STRONG markers ("我错了", "let me redo", "ごめん") are
// high-confidence alone; SOFT markers ("其实", "等等", "espera,") need
// corroboration ("错", "重新", "equivoqué", etc.) in the first 200 chars,
// since they overlap with normal narration. Coverage: zh-CN, en, ja, ko,
// es, fr, de — add the relevant locale to all three tables when extending.
// `让我重新` + neg lookahead for organizing verbs (整理/规划/梳理/组织/排列/
// 安排) so narration like "让我重新整理思路" doesn't false-positive. Real
// corrections use re-doing verbs (考虑/算/检查/看/写/做/...) which all pass.
// Reflection markers extracted into ./reflection-i18n.ts so each language
// block can be edited independently. 9 langs as of iter-80 (zh/en/ja/ko/es/
// fr/de/it/pt/ru); see file for full list + Arabic-defer note.
// Two-tier corroboration: STRONG = explicit correction nouns/verbs (fire from
// any distance ≤ 40 chars after the soft marker); WEAK = ambiguous single chars
// like `错`/`忘` that also appear in teaching ("很多人会错的认为"), so they
// must sit close to the marker (≤ 8 chars) to count.
const WEAK_CORR_RE = /(错|忘)/;
function looksLikeReflection(text: string): boolean {
	const stripped = text.trim().replace(/^[*_>#`\s-]+/, "");
	const head = stripped.slice(0, 30);
	if (STRONG_REFLECTION_RE.test(head)) return true;
	const softMatch = SOFT_REFLECTION_RE.exec(head);
	if (!softMatch) return false;
	// Skip past the soft marker so it can't corroborate itself (e.g. "不对称
	// 加密" — the SOFT marker "不对" would otherwise CORR-match its own "不对").
	// Two-tier window: STRONG correction words (不对/重新/wrong/mistake/...) fire
	// from anywhere in the next 40 chars; WEAK chars (错/忘) fire only within 8
	// chars (close to marker) to reject teaching FPs like "其实这是常见误解，很多
	// 人会错的..." where `错` is far from the marker.
	const tail = stripped.slice(softMatch[0].length);
	return (
		STRONG_CORR_RE.test(tail.slice(0, 40)) ||
		WEAK_CORR_RE.test(tail.slice(0, 8))
	);
}

// ── Block parsing — 2026-06 rewrite (FIXES AN INFINITE LOOP) ────────────────
// The previous parseBlocks defined "where does a block start" TWICE: once as the
// if-chain that dispatched each block kind, and again as a separate list of
// negated regexes that told the paragraph loop when to stop. Those two copies
// drifted apart. The paragraph terminator was LOOSER than the dispatcher, so
// some lines fell through every dispatch `if` (treated as not-a-block) yet were
// rejected by the paragraph loop (treated as a block) — a "gap line" that no
// branch ever consumed. `i` then never advanced and `while (i < lines.length)`
// spun forever. Because parseBlocks runs synchronously on the main thread for
// every streamed chat delta, a single such line HARD-FROZE the browser tab
// (100% CPU, unrecoverable). Real triggers were common in streamed output:
//   • a fence info-string the strict opener rejected but the loose `/^```/`
//     paragraph-exclusion still bailed on, e.g.  ```ts title
//   • a hash-only "heading" with no body, e.g.  "###   "
// Fix: detection lives in ONE place (`blockStartKind`); both the dispatch switch
// and the paragraph terminator derive from it, so they can no longer disagree.
// One deliberate behavior normalization falls out of de-duplicating the rules:
// `***` now interrupts a paragraph as a thematic break (matching `---`, which
// already did, and CommonMark) — the old code let `***` slip into paragraph text
// purely because of the same dual-rule drift. Everything else is unchanged.
//
// Block-start regexes, defined once. The fence opener is strict (whole line is
// ``` + optional word/dash lang) and the closer is bare ```; everything else
// mirrors the consumers below so detection and termination can't drift.
const RE_BLANK = /^\s*$/;
const RE_FENCE = /^```\s*([\w-]*)\s*$/;
const RE_FENCE_CLOSE = /^```\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_HR = /^(?:---+|\*\*\*+)\s*$/;
const RE_TABLE_ROW = /^\s*\|.+\|\s*$/;
const RE_TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const RE_UL = /^\s*[-*+]\s+/;
const RE_OL = /^\s*\d+\.\s+/;
const RE_QUOTE = /^\s*>\s?/;

type BlockStart =
	| "blank"
	| "code"
	| "heading"
	| "hr"
	| "table"
	| "ul"
	| "ol"
	| "quote"
	| null;

// Single source of truth for "what block (if any) begins at lines[i]". Both the
// dispatch switch and the paragraph terminator derive from this, so the two can
// never disagree about where a paragraph ends — the historical infinite-loop
// class (e.g. a "```ts title" line the strict fence rejected but the paragraph
// loop also refused to consume) is structurally impossible. `null` means the
// line is paragraph text. Table needs one line of lookahead for its separator.
function blockStartKind(lines: string[], i: number): BlockStart {
	const line = lines[i];
	if (RE_BLANK.test(line)) return "blank";
	if (RE_FENCE.test(line)) return "code";
	if (RE_HEADING.test(line)) return "heading";
	if (RE_HR.test(line)) return "hr";
	if (
		RE_TABLE_ROW.test(line) &&
		i + 1 < lines.length &&
		RE_TABLE_SEP.test(lines[i + 1])
	)
		return "table";
	if (RE_UL.test(line)) return "ul";
	if (RE_OL.test(line)) return "ol";
	if (RE_QUOTE.test(line)) return "quote";
	return null;
}

export function parseBlocks(src: string): Block[] {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	const lineOffsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineOffsets.push(offset);
		offset += line.length + 1;
	}
	const out: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const start = i;
		const pushBlock = (block: BlockData) =>
			out.push({ ...block, sourceOffset: lineOffsets[start] });
		switch (blockStartKind(lines, i)) {
			case "blank":
				i++;
				break;
			case "code": {
				const lang = RE_FENCE.exec(lines[i])?.[1] || "";
				i++;
				const body: string[] = [];
				while (i < lines.length && !RE_FENCE_CLOSE.test(lines[i])) {
					body.push(lines[i]);
					i++;
				}
				if (i < lines.length) i++; // consume closing fence
				pushBlock({ kind: "code", lang, body: body.join("\n") });
				break;
			}
			case "heading": {
				const h = RE_HEADING.exec(lines[i])!;
				pushBlock({ kind: "heading", level: h[1].length, text: h[2] });
				i++;
				break;
			}
			case "hr":
				pushBlock({ kind: "hr" });
				i++;
				break;
			case "table": {
				const header = splitTableRow(lines[i], lineOffsets[i]);
				const rawAligns = parseTableAligns(lines[i + 1]);
				// Normalize aligns to match header column count: pad with 'left' if the
				// separator row has fewer cells (broken markdown), truncate if it has
				// more. Without this, `styleFor(idx)` returned `undefined` past the
				// shorter array, which rendered correctly but masked authoring bugs.
				const aligns: Array<"left" | "center" | "right"> = Array.from(
					{ length: header.length },
					(_, idx) => rawAligns[idx] ?? "left",
				);
				i += 2; // skip header + separator
				const rows: SourceText[][] = [];
				while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
					rows.push(splitTableRow(lines[i], lineOffsets[i]));
					i++;
				}
				pushBlock({ kind: "table", header, rows, aligns });
				break;
			}
			case "ul": {
				const items: SourceText[] = [];
				while (i < lines.length && RE_UL.test(lines[i])) {
					const marker = RE_UL.exec(lines[i])![0];
					items.push({
						sourceOffset: lineOffsets[i] + marker.length,
						text: lines[i].slice(marker.length),
					});
					i++;
				}
				pushBlock({ kind: "ul", items });
				break;
			}
			case "ol": {
				const items: SourceText[] = [];
				while (i < lines.length && RE_OL.test(lines[i])) {
					const marker = RE_OL.exec(lines[i])![0];
					items.push({
						sourceOffset: lineOffsets[i] + marker.length,
						text: lines[i].slice(marker.length),
					});
					i++;
				}
				pushBlock({ kind: "ol", items });
				break;
			}
			case "quote": {
				const buf: SourceText[] = [];
				while (i < lines.length && RE_QUOTE.test(lines[i])) {
					const marker = RE_QUOTE.exec(lines[i])![0];
					buf.push({
						sourceOffset: lineOffsets[i] + marker.length,
						text: lines[i].slice(marker.length),
					});
					i++;
				}
				pushBlock({ kind: "quote", lines: buf });
				break;
			}
			case null: {
				// paragraph: consume until blank line / next block start
				const buf: SourceText[] = [];
				while (i < lines.length && blockStartKind(lines, i) === null) {
					buf.push({ sourceOffset: lineOffsets[i], text: lines[i] });
					i++;
				}
				pushBlock({
					kind: "para",
					lines: buf,
					reflection: buf.length > 0 ? looksLikeReflection(buf[0].text) : false,
				});
				break;
			}
		}
		// Progress guard: every branch above advances i, so this is dead code today.
		// It exists so that if a future block kind is ever added that consumes zero
		// lines, a malformed line degrades to "one skipped line" instead of hard-
		// freezing this synchronous, main-thread parse over streamed input.
		if (i === start) i++;
	}
	return out;
}

// Inline pass: single regex with alternation finds the FIRST occurrence of any
// pattern (bold / italic-asterisk / italic-underscore / inline-code / link).
// Bold matches first because `**` outranks `*` in left-to-right priority. Note:
// nested bold inside italic (`*X **B** Y*`) is intentionally NOT supported —
// the alternation needed for it caused catastrophic backtracking on streamed
// text, so we treat it as a known limitation rather than risk runaway regex.
function renderInline(
	text: string,
	sourceOffset = 0,
): (string | ReactElement)[] {
	const out: (string | ReactElement)[] = [];
	// Patterns L→R:
	//   1. Bold `**X**` — content holds lone `*` but not `**`.
	//   2. Italic-with-one-bold `*PRE**B**POST*` — bounded `[^*\n]` content
	//      classes avoid the catastrophic-backtracking trap iter-44 hit. Only
	//      handles a single nested bold; deeper nesting still degrades to
	//      separate italics + raw `**`.
	//   3. Italic-* — simple, no internal asterisks.
	//   4. Bold-__  — CommonMark `__X__`, word-boundary guard rejects `my__var__`.
	//   5. Italic-_ — word-boundary lookarounds reject `snake_case_var`.
	//   6. Inline code, 7. links — atomic.
	const re =
		/\*\*((?:[^*]|\*(?!\*))+?)\*\*|\*([^*\n]*)\*\*([^*\n]+)\*\*([^*\n]*)\*|\*([^*\n]+?)\*|(?<!\w)__([^_\n]+?)__(?!\w)|(?<!\w)_([^_\n]+?)_(?!\w)|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
	let last = 0;
	while (true) {
		const m = re.exec(text);
		if (m === null) break;
		if (m.index > last) out.push(text.slice(last, m.index));
		const k = `${sourceOffset + m.index}`;
		if (m[1] !== undefined) {
			out.push(
				<strong key={`b${k}`}>
					{renderInline(m[1], sourceOffset + m.index + 2)}
				</strong>,
			);
		} else if (m[3] !== undefined) {
			// Italic wrapping a nested bold: emit <em>{pre}<strong>{bold}</strong>{post}</em>.
			// pre/post may be empty (e.g. `***bold***` after iter-73 triple-strip is
			// handled, so this is mainly for `*pre **bold** post*` shape).
			out.push(
				<em key={`ib${k}`}>
					{m[2] && renderInline(m[2], sourceOffset + m.index + 1)}
					<strong>
						{renderInline(m[3], sourceOffset + m.index + m[2].length + 3)}
					</strong>
					{m[4] &&
						renderInline(
							m[4],
							sourceOffset + m.index + m[2].length + m[3].length + 5,
						)}
				</em>,
			);
		} else if (m[5] !== undefined) {
			out.push(
				<em key={`i${k}`}>{renderInline(m[5], sourceOffset + m.index + 1)}</em>,
			);
		} else if (m[6] !== undefined) {
			out.push(
				<strong key={`bu${k}`}>
					{renderInline(m[6], sourceOffset + m.index + 2)}
				</strong>,
			);
		} else if (m[7] !== undefined) {
			out.push(
				<em key={`iu${k}`}>
					{renderInline(m[7], sourceOffset + m.index + 1)}
				</em>,
			);
		} else if (m[8] !== undefined) {
			out.push(
				<code key={`c${k}`} className="md-inline-code">
					{m[8]}
				</code>,
			);
		} else if (m[9] !== undefined) {
			out.push(
				<a key={`a${k}`} href={m[10]} target="_blank" rel="noreferrer">
					{m[9]}
				</a>,
			);
		}
		last = re.lastIndex;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

// memleak case-15 (md-stream-throttle) — while a message streams, the store
// appends every token / tool-call marker into the same running message, and
// ForgeCard renders the tail segment with animated=true → MarkdownView. Parsing
// + rebuilding the WHOLE element tree on every delta is O(n²) over the message
// length and outran V8 GC → JS-heap OOM crashed the renderer (4GB). Throttle the
// text MarkdownView actually renders to ~8fps: leading-edge so a static/done
// message (text set once) renders immediately with no lag, trailing-edge so the
// final streamed text is always rendered in full. Bounds parse+rebuild count to
// ~(duration/THROTTLE) instead of one-per-token.
const MD_STREAM_THROTTLE_MS = 120;
function useThrottledValue<T>(value: T, ms: number): T {
	const [shown, setShown] = useState(value);
	const lastAt = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		// Equality guard breaks the render loop: once `shown` has converged to
		// `value`, re-running this effect produces NO further setState. Without it,
		// the leading edge fired `setShown(value)` unconditionally every time the
		// effect ran, which under fast streaming re-renders exceeded React's
		// nested-update limit ("Maximum update depth exceeded").
		if (shown === value) return;
		const since = Date.now() - lastAt.current;
		if (since >= ms) {
			lastAt.current = Date.now();
			setShown(value);
		} else {
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				lastAt.current = Date.now();
				setShown(value);
			}, ms - since);
		}
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, [value, ms, shown]);
	return shown;
}

export function MarkdownView({ text }: { text: string }) {
	const { t } = useTranslation();
	const throttledText = useThrottledValue(text, MD_STREAM_THROTTLE_MS);
	const blocks = useMemo(() => parseBlocks(throttledText), [throttledText]);
	// The block→element build (renderInline for every block) is as expensive as
	// the parse and previously ran on EVERY render; memoize it on the throttled
	// blocks so it too fires at most ~8fps during streaming, not per token.
	const body = useMemo(
		() =>
			blocks.map((b) => {
				switch (b.kind) {
					case "heading": {
						const lvl = Math.min(6, Math.max(1, b.level));
						const cls = `md-h md-h${lvl}`;
						const inner = renderInline(b.text, b.sourceOffset);
						if (lvl === 1)
							return (
								<h1 key={b.sourceOffset} className={cls}>
									{inner}
								</h1>
							);
						if (lvl === 2)
							return (
								<h2 key={b.sourceOffset} className={cls}>
									{inner}
								</h2>
							);
						if (lvl === 3)
							return (
								<h3 key={b.sourceOffset} className={cls}>
									{inner}
								</h3>
							);
						if (lvl === 4)
							return (
								<h4 key={b.sourceOffset} className={cls}>
									{inner}
								</h4>
							);
						if (lvl === 5)
							return (
								<h5 key={b.sourceOffset} className={cls}>
									{inner}
								</h5>
							);
						return (
							<h6 key={b.sourceOffset} className={cls}>
								{inner}
							</h6>
						);
					}
					case "code":
						return (
							<CodeBlock key={b.sourceOffset} lang={b.lang} body={b.body} />
						);
					case "ul":
						return (
							<ul key={b.sourceOffset} className="md-ul">
								{b.items.map((item) => {
									const { sourceOffset, text } = item;
									// GFM task list: "[ ] todo" / "[x] done" / "[X] done"
									const m = /^\s*\[( |x|X)\]\s+(.*)$/.exec(text);
									if (m) {
										const checked = m[1].toLowerCase() === "x";
										// Tooltip + aria-disabled make explicit that this is a status
										// indicator, not an interactive control. Editing chat history
										// after-the-fact would falsify the record, so toggle is
										// intentionally not wired.
										return (
											<li
												key={sourceOffset}
												className={`md-task ${checked ? "is-checked" : ""}`}
											>
												<span
													className="md-task-box"
													role="img"
													aria-disabled="true"
													aria-label={
														checked
															? t("markdownView.taskDoneReadonly")
															: t("markdownView.taskTodoReadonly")
													}
													title={t("markdownView.taskStatusReadonly")}
												>
													{checked ? "✓" : " "}
												</span>
												{renderInline(
													m[2],
													sourceOffset + m[0].length - m[2].length,
												)}
											</li>
										);
									}
									return (
										<li key={sourceOffset}>
											{renderInline(text, sourceOffset)}
										</li>
									);
								})}
							</ul>
						);
					case "ol":
						return (
							<ol key={b.sourceOffset} className="md-ol">
								{b.items.map(({ sourceOffset, text }) => (
									<li key={sourceOffset}>{renderInline(text, sourceOffset)}</li>
								))}
							</ol>
						);
					case "quote":
						return (
							<blockquote key={b.sourceOffset} className="md-quote">
								{b.lines.map(({ sourceOffset, text }) => (
									<p key={sourceOffset}>{renderInline(text, sourceOffset)}</p>
								))}
							</blockquote>
						);
					case "table": {
						// Only attach style for non-default alignment — keeps DOM lean.
						const styleFor = (i2: number) =>
							b.aligns[i2] !== "left" ? { textAlign: b.aligns[i2] } : undefined;
						// Cell content: split on `<br>` / `<br/>` / `<br />` (GFM extension
						// for soft line breaks inside table cells — real fenced code/list
						// can't fit on one source line, but `<br>` is the common workaround).
						// Each <br>-separated segment goes through renderInline so inline
						// markdown still works around the breaks.
						const renderCell = ({ sourceOffset, text }: SourceText) => {
							const parts = text.split(/<br\s*\/?>/i);
							if (parts.length === 1) return renderInline(text, sourceOffset);
							const out: ReactNode[] = [];
							let partOffset = sourceOffset;
							for (const part of parts) {
								if (partOffset > sourceOffset) {
									out.push(<br key={`br-${partOffset}`} />);
								}
								out.push(...renderInline(part, partOffset));
								partOffset += part.length + 4;
							}
							return out;
						};
						return (
							<div key={b.sourceOffset} className="md-table-wrap">
								<table className="md-table">
									<thead>
										<tr>
											{b.header.map((cell, j) => (
												<th key={cell.sourceOffset} style={styleFor(j)}>
													{renderCell(cell)}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{b.rows.map((row) => (
											<tr key={row[0]?.sourceOffset ?? b.sourceOffset}>
												{row.map((cell, k) => (
													<td key={cell.sourceOffset} style={styleFor(k)}>
														{renderCell(cell)}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);
					}
					case "hr":
						return <hr key={b.sourceOffset} className="md-hr" />;
					default: {
						const isReflection = b.kind === "para" && b.reflection;
						return (
							<p
								key={b.sourceOffset}
								className={`md-p${isReflection ? " md-reflection" : ""}`}
							>
								{b.lines.map(({ sourceOffset, text }) => (
									<span key={sourceOffset}>
										{sourceOffset > b.sourceOffset && <br />}
										{renderInline(text, sourceOffset)}
									</span>
								))}
							</p>
						);
					}
				}
			}),
		[blocks, t],
	);
	return <div className="md">{body}</div>;
}
