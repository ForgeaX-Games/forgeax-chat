import { createContext, useContext, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

export interface SummonSelection {
  summonAgentId: string | null;
  setSummonAgentId: Dispatch<SetStateAction<string | null>>;
  summonManual: boolean;
  setSummonManual: Dispatch<SetStateAction<boolean>>;
  /** Latest visible resolution published after the Composer render commits. */
  resolvedSummonAgentIdRef: MutableRefObject<string | null>;
}

/**
 * Deliberately scoped to one mounted ChatPanel. The summon chip is Composer
 * state, not session/store state: rewind resend controls are siblings of the
 * Composer and need the same current, non-persistent selection to snapshot.
 */
export const SummonSelectionContext = createContext<SummonSelection | null>(null);

export function useSummonSelection(): SummonSelection {
  const selection = useContext(SummonSelectionContext);
  if (!selection) throw new Error('useSummonSelection must be used inside ChatPanel');
  return selection;
}
