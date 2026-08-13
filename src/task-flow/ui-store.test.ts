import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTaskFlowUiStore } from './ui-store';

describe('task-flow ui store', () => {
  it('toggles the effective task state instead of assuming every task starts open', () => {
    const id = 'round:folded-task';
    useTaskFlowUiStore.getState().toggleTask(id, false);
    assert.equal(useTaskFlowUiStore.getState().openTasks[id], true);
    useTaskFlowUiStore.getState().toggleTask(id, true);
    assert.equal(useTaskFlowUiStore.getState().openTasks[id], false);
  });

  it('marks manual toggles sticky and resets a completed process', () => {
    const store = useTaskFlowUiStore.getState();
    store.resetProcess('process-1');
    store.toggleProcess('process-1', false);
    assert.equal(useTaskFlowUiStore.getState().sticky['process-1'], true);
    assert.equal(useTaskFlowUiStore.getState().openProcesses['process-1'], true);
    useTaskFlowUiStore.getState().resetProcess('process-1');
    assert.equal(useTaskFlowUiStore.getState().openProcesses['process-1'], false);
    assert.equal(useTaskFlowUiStore.getState().sticky['process-1'], undefined);
  });

  it('toggles default-open process and step state on the first click', () => {
    const store = useTaskFlowUiStore.getState();
    store.toggleProcess('default-open-process', true);
    assert.equal(useTaskFlowUiStore.getState().openProcesses['default-open-process'], false);
    useTaskFlowUiStore.getState().toggleStep('default-open-step', true);
    assert.equal(useTaskFlowUiStore.getState().openSteps['default-open-step'], false);
  });

  it('resetProcess is idempotent — a redundant reset must not produce a new state', () => {
    // A store write re-renders every subscriber; with two settled rounds on screen
    // their "reset when no longer live" effects would ping-pong forever and React
    // throws "Maximum update depth exceeded". So a no-op reset must keep identity.
    const store = useTaskFlowUiStore.getState();
    store.resetProcess('process-idem');
    const afterFirst = useTaskFlowUiStore.getState();
    afterFirst.resetProcess('process-idem');
    assert.equal(useTaskFlowUiStore.getState(), afterFirst, 'redundant reset changed the state object');

    // Two independent rounds must not invalidate each other's state either.
    useTaskFlowUiStore.getState().resetProcess('process-other');
    const twoRounds = useTaskFlowUiStore.getState();
    twoRounds.resetProcess('process-idem');
    assert.equal(useTaskFlowUiStore.getState(), twoRounds, 'reset of an already-reset round churned state');
  });
});
