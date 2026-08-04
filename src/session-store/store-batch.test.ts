import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useChatStore } from './store';

describe('chat message batch updates', () => {
  let previousBySid: ReturnType<typeof useChatStore.getState>['bySid'];

  beforeEach(() => {
    previousBySid = useChatStore.getState().bySid;
    useChatStore.setState({ bySid: {} });
  });

  afterEach(() => {
    useChatStore.setState({ bySid: previousBySid });
  });

  it('commits many stream-slot patches with one subscriber notification', () => {
    let notifications = 0;
    const unsubscribe = useChatStore.subscribe(() => { notifications++; });

    useChatStore.getState().batchPatchMessages(
      Array.from({ length: 64 }, (_, index) => ({
        sid: 'batch-sid',
        agentId: `agent-${index}`,
        updater: (messages) => messages.slice(),
      })),
    );

    expect(notifications).toBe(1);
    expect(Object.keys(useChatStore.getState().bySid['batch-sid'].messagesByAgent)).toHaveLength(64);

    useChatStore.getState().batchPatchMessages([{
      sid: 'batch-sid',
      agentId: 'agent-0',
      updater: (messages) => messages,
    }]);
    expect(notifications).toBe(1);

    unsubscribe();
  });
});
