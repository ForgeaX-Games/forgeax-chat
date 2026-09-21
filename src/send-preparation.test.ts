import { expect, test } from 'bun:test';
import { prepareChatSend, registerChatSendPreparation } from './send-preparation';
test('awaits origin preparation and propagates rejection before send', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let prepared = false;
  const remove = registerChatSendPreparation(async ({ sessionId }) => { expect(sessionId).toBe('session'); await gate; prepared = true; });
  const pending = prepareChatSend({ sessionId: 'session' });
  expect(prepared).toBe(false); finish(); await pending; expect(prepared).toBe(true); remove();
  const fail = registerChatSendPreparation(() => { throw new Error('origin unavailable'); });
  await expect(prepareChatSend({ sessionId: 'session' })).rejects.toThrow('origin unavailable'); fail();
  await prepareChatSend({ sessionId: 'session' });
});
