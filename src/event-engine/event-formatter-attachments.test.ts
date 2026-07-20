/**
 * user_input formatter must recover image attachments on refresh:
 *  - modern: payload.attachments[{path}]
 *  - legacy kernel transcription: path notes only inside llmMessage text
 */
import { describe, expect, it } from 'bun:test';
import { formatEvent } from './event-formatter';
import type { StoredEvent } from './types';

describe('user_input attachment recovery', () => {
  it('passes through path-only attachments', () => {
    const ev = {
      type: 'user_input',
      ts: 1,
      source: 'user',
      payload: {
        content: 'what is this?',
        attachments: [{ kind: 'image', path: '/tmp/uploads/a.png', mediaType: 'image/png' }],
      },
    } as StoredEvent;
    const msg = formatEvent(ev);
    expect(msg?.kind).toBe('user_input');
    expect(msg && 'attachments' in msg && msg.attachments?.[0]?.path).toBe('/tmp/uploads/a.png');
  });

  it('recovers attachments from legacy llmMessage path notes', () => {
    const path = '/Users/you/.forgeax/games/hellforge/sessions/sid/uploads/shot.png';
    const ev = {
      type: 'user_input',
      ts: 1,
      source: 'user',
      payload: {
        content: '图片内容是什么？',
        llmMessage: {
          role: 'user',
          content: [{
            type: 'text',
            text: `图片内容是什么？\n\n[Attached image: ${path} (image/png, 1.5MB)]\nThe user attached the file(s) above.`,
          }],
        },
      },
    } as StoredEvent;
    const msg = formatEvent(ev);
    expect(msg?.kind).toBe('user_input');
    expect(msg && 'attachments' in msg && msg.attachments).toEqual([{
      kind: 'image',
      path,
      mediaType: 'image/png',
      name: 'shot.png',
    }]);
  });
});
