import { create } from 'zustand';

interface TaskFlowUiState {
  openProcesses: Record<string, boolean>;
  openTasks: Record<string, boolean>;
  openSteps: Record<string, boolean>;
  sticky: Record<string, boolean>;
  toggleProcess: (id: string, currentOpen: boolean) => void;
  toggleTask: (id: string, currentOpen: boolean) => void;
  toggleStep: (id: string, currentOpen: boolean) => void;
  setSticky: (id: string, value?: boolean) => void;
  resetProcess: (processId: string) => void;
}

export const useTaskFlowUiStore = create<TaskFlowUiState>((set) => ({
  openProcesses: {},
  openTasks: {},
  openSteps: {},
  sticky: {},
  toggleProcess: (id, currentOpen) => set((state) => ({
    // Toggle the effective rendered state, not the raw override. A process may
    // be open by default while no override exists; toggling `undefined` used
    // to write `true`, so the first click appeared to do nothing.
    openProcesses: { ...state.openProcesses, [id]: !currentOpen },
    sticky: { ...state.sticky, [id]: true },
  })),
  toggleTask: (id, currentOpen) => set((state) => ({
    openTasks: { ...state.openTasks, [id]: !currentOpen },
    sticky: { ...state.sticky, [id]: true },
  })),
  toggleStep: (id, currentOpen) => set((state) => ({
    openSteps: { ...state.openSteps, [id]: !currentOpen },
    sticky: { ...state.sticky, [id]: true },
  })),
  setSticky: (id, value = true) => set((state) => ({
    sticky: { ...state.sticky, [id]: value },
  })),
  /** Reset the auto-managed process collapse state. The no-op identity check
   * prevents sibling settled processes from causing an update-depth loop. */
  resetProcess: (processId) => set((state) => {
    if (state.openProcesses[processId] === false && !(processId in state.sticky)) return state;
    const sticky = { ...state.sticky };
    delete sticky[processId];
    return { openProcesses: { ...state.openProcesses, [processId]: false }, sticky };
  }),
}));
