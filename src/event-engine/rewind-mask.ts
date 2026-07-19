/** rewind-mask(interface 镜像)—— 与 server `src/checkpoint/rewind-mask.ts`
 *  同语义的纯函数。改语义时两边同步。
 *
 *  - 活跃(未 cancel)的 `rewind_boundary` 屏蔽 [目标 user_input .. boundary];
 *  - `rewind_cancel` 使对应 boundary 失效(区间重新可见);
 *  - boundary/cancel 事件本身永不渲染;
 *  - 挂起态(boundary 后无新 user_input)由 findPendingRewind 识别,UI 用
 *    keepBoundaryVisible 保留该区间自己渲染置灰。 */

import type { StoredEvent } from "./types";

export const REWIND_BOUNDARY = "rewind_boundary";
export const REWIND_CANCEL = "rewind_cancel";

export interface RewindBoundaryInfo {
  boundaryId: string;
  targetMsgId: string;
  targetTs: number;
  mode: string;
  index: number;
  ts: number;
}

function boundaryInfo(ev: StoredEvent, index: number): RewindBoundaryInfo | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const boundaryId = p.boundaryId as string | undefined;
  if (!boundaryId) return null;
  return {
    boundaryId,
    targetMsgId: (p.targetMsgId as string) ?? "",
    targetTs: (p.targetTs as number) ?? (ev.ts as number),
    mode: (p.mode as string) ?? "conversation",
    index,
    ts: ev.ts as number,
  };
}

function cancelledIds(events: StoredEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const ev of events) {
    if (ev.type !== REWIND_CANCEL) continue;
    const id = ((ev.payload ?? {}) as Record<string, unknown>).boundaryId as string | undefined;
    if (id) ids.add(id);
  }
  return ids;
}

function rangeStart(events: StoredEvent[], b: RewindBoundaryInfo): number {
  for (let j = b.index - 1; j >= 0; j--) {
    const e = events[j]!;
    if (e.type === "user_input" && ((e.payload ?? {}) as Record<string, unknown>).msgId === b.targetMsgId) return j;
  }
  for (let j = 0; j < b.index; j++) {
    if ((events[j]!.ts as number) >= b.targetTs) return j;
  }
  return b.index;
}

export function applyRewindMask(
  events: StoredEvent[],
  opts: { keepBoundaryVisible?: string } = {},
): StoredEvent[] {
  let sawRewind = false;
  for (const ev of events) {
    if (ev.type === REWIND_BOUNDARY || ev.type === REWIND_CANCEL) { sawRewind = true; break; }
  }
  if (!sawRewind) return events;

  const cancelled = cancelledIds(events);
  const drop = new Array<boolean>(events.length).fill(false);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === REWIND_CANCEL) { drop[i] = true; continue; }
    if (ev.type !== REWIND_BOUNDARY) continue;
    drop[i] = true;
    const b = boundaryInfo(ev, i);
    if (!b) continue;
    if (cancelled.has(b.boundaryId)) continue;
    if (opts.keepBoundaryVisible === b.boundaryId) continue;
    const start = rangeStart(events, b);
    for (let j = start; j < i; j++) drop[j] = true;
  }
  return events.filter((_, i) => !drop[i]);
}

export function findPendingRewind(events: StoredEvent[]): RewindBoundaryInfo | null {
  const cancelled = cancelledIds(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "user_input") return null;
    if (ev.type !== REWIND_BOUNDARY) continue;
    const b = boundaryInfo(ev, i);
    if (!b) continue;
    if (cancelled.has(b.boundaryId)) continue;
    return b;
  }
  return null;
}
