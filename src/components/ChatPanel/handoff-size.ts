export const DEFAULT_HANDOFF_HEIGHT = 132;
export const MIN_HANDOFF_HEIGHT = 96;
export const MIN_CHAT_HEIGHT = 160;
export const handoffStorageKey = (sid: string) => `forgeax.chat.handoff-height.v1:${sid}`;

export function readHandoffHeight(sid: string): number {
  try {
    const value = Number(localStorage.getItem(handoffStorageKey(sid)));
    return Number.isFinite(value) && value >= MIN_HANDOFF_HEIGHT ? value : DEFAULT_HANDOFF_HEIGHT;
  } catch { return DEFAULT_HANDOFF_HEIGHT; }
}

export function handoffBounds(available: number) {
  const max = Math.max(0, available - MIN_CHAT_HEIGHT);
  return { min: Math.min(MIN_HANDOFF_HEIGHT, max), max };
}
