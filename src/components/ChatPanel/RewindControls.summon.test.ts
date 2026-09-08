import { describe, expect, test } from 'bun:test';
import { rewindSendOptions } from './rewind-send-options';

describe('rewind resend summon snapshot', () => {
  test('keeps the selected specialist for an idle resend', () => {
    expect(rewindSendOptions('iori', false)).toEqual({ summonAgentId: 'iori' });
  });

  test('keeps an explicit clear for an idle resend', () => {
    expect(rewindSendOptions(null, false)).toEqual({ summonAgentId: null });
  });

  test('keeps the selected specialist while steering a streaming turn', () => {
    expect(rewindSendOptions('iori', true)).toEqual({ handoff: 'steer', summonAgentId: 'iori' });
  });

  test('keeps an explicit clear while steering a streaming turn', () => {
    expect(rewindSendOptions(null, true)).toEqual({ handoff: 'steer', summonAgentId: null });
  });

  test('is a value snapshot before an asynchronous rewind settles', async () => {
    let currentSelection: string | null = 'iori';
    const sendOptions = rewindSendOptions(currentSelection, true);
    currentSelection = null;
    await Promise.resolve();

    expect(currentSelection).toBeNull();
    expect(sendOptions).toEqual({ handoff: 'steer', summonAgentId: 'iori' });
  });
});
