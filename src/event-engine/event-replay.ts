/**
 * Event replay — parse JSONL event streams and rebuild CompletedTurn[]
 * by feeding events through the shared TurnAccumulator.
 *
 * cp'd from @forgeax/orchestrator src/channels/ink-renderer/lib/event-replay.ts
 * (`.js` extension dropped to match local module resolution; otherwise
 * unchanged) plus an additional `trimToCompactBoundary` helper that
 * mirrors framework `applyCompactTruncation` semantics for the UI:
 * discard everything before the most-recent compact_boundary so we don't
 * stream multi-thousand-event compacted history into the client.
 */

import type { StoredEvent, CompletedTurn, ToolCallMessage } from "./types";
import { TurnAccumulator } from "./turn-accumulator";

export interface ReplayResult {
  turns: CompletedTurn[];
  sessionId: string | null;
  contextPct: number;
}

export function parseEventLines(raw: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as StoredEvent;
      if (typeof rec.type === "string") events.push(rec);
    } catch { /* skip malformed */ }
  }
  return events;
}

/**
 * Trim events to clean turn boundaries: discard orphan events before
 * the first turnStart/user_input so partial tail loads don't produce
 * malformed turns.
 */
export function trimToTurnBoundary(events: StoredEvent[]): StoredEvent[] {
  const firstBoundary = events.findIndex(
    e => e.type === "hook:turnStart" || e.type === "user_input",
  );
  return firstBoundary > 0 ? events.slice(firstBoundary) : events;
}

/**
 * Slice to the most-recent compact_boundary onwards, mirroring framework
 * `context-window.ts::applyCompactTruncation` semantics. Everything before
 * a compact_boundary was summarised into its `payload.summary` and no
 * longer needs to be replayed event-by-event in the UI.
 *
 * Includes the boundary event itself so callers can render a "session
 * summary" affordance from `payload.summary` if they want; TurnAccumulator
 * doesn't recognise the type today and silently skips it (acceptable —
 * historical context lives in the summary, not in raw replay).
 *
 * If no compact_boundary is present, returns events unchanged.
 */
export function trimToCompactBoundary(events: StoredEvent[]): StoredEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "compact_boundary") {
      return events.slice(i);
    }
  }
  return events;
}

export function replayEvents(events: StoredEvent[], viewerId?: string): ReplayResult {
  const turns: CompletedTurn[] = [];
  let sessionId: string | null = null;
  let contextPct = 0;

  const acc = new TurnAccumulator({
    onTurn: (turn) => turns.push(turn),
    onUpdateMessage: (callId, merged) => {
      for (let i = turns.length - 1; i >= 0; i--) {
        const msgs = turns[i]!.messages;
        for (let j = msgs.length - 1; j >= 0; j--) {
          const m = msgs[j]!;
          if (m.kind === "tool_call" && (m as ToolCallMessage).id === callId) {
            msgs[j] = { ...m, ...merged };
            return;
          }
        }
      }
    },
    onMeta: (m) => {
      if (m.session) sessionId = m.session;
      if (m.contextPct !== undefined) contextPct = m.contextPct;
    },
  }, viewerId);

  for (const rec of events) acc.feed(rec);
  acc.flush();

  return { turns, sessionId, contextPct };
}
