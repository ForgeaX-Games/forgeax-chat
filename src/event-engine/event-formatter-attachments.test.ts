/**
 * user_input formatter must recover image attachments on refresh:
 *  - modern: payload.attachments[{path}]
 *  - legacy kernel transcription: path notes only inside llmMessage text
 */
import { describe, expect, it } from 'bun:test';
import { formatEvent, normalizeHookToolCall } from './event-formatter';
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

describe('agent_log visibility boundary', () => {
  it('projects only an explicitly public summary', () => {
    const msg = formatEvent({
      type: 'agent_log',
      ts: 2,
      emitterId: 'forge',
      payload: { visibility: 'public_summary', summary: 'Inspecting the project structure.' },
    } as StoredEvent);
    expect(msg).toMatchObject({ kind: 'assistant_complete', publicSummary: 'Inspecting the project structure.' });
  });

  it('drops private and unknown logs fail-closed', () => {
    for (const visibility of ['private_reasoning', 'future_value', undefined]) {
      const msg = formatEvent({
        type: 'agent_log',
        ts: 2,
        emitterId: 'forge',
        payload: { visibility, content: 'PRIVATE_CANARY' },
      } as StoredEvent);
      expect(msg).toBeNull();
    }
  });
});

describe('cross-kernel task-flow tool normalization', () => {
  it('projects namespaced and provider-native aliases to canonical UI names', () => {
    expect(normalizeHookToolCall('mcp__fxt__TodoWrite', { todos: [] })).toEqual({
      name: 'todo_write',
      args: { todos: [] },
    });
    expect(normalizeHookToolCall('AskUserQuestion', { question: 'Pick one' })).toEqual({
      name: 'ask_user',
      args: { question: 'Pick one' },
    });
    expect(normalizeHookToolCall('Write', { file_path: 'src/game.ts' })).toEqual({
      name: 'write_file',
      args: { file_path: 'src/game.ts' },
    });
  });

  it('preserves CLI permission-side-channel provenance on AskUserQuestion', () => {
    const msg = formatEvent({
      type: 'hook:toolCall',
      emitterId: 'forge',
      ts: 3,
      payload: {
        name: 'AskUserQuestion',
        callId: 'cli-ask-1',
        permissionPrompt: true,
        args: { questions: [{ question: 'Pick one' }] },
      },
    } as StoredEvent);
    expect(msg).toMatchObject({ kind: 'tool_call', id: 'cli-ask-1', permissionPrompt: true });
  });
});
