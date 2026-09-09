import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../../session-store';
import { messageReadSnapshot, unreadMessageCount } from './unread-messages';

function reply(texts: string[], id = 'reply'): ChatMessage {
  return { id, role: 'assistant', status: 'streaming', text: texts.join(''),
    segments: texts.map((text, ts) => ({ kind: 'text', ts, text })) } as ChatMessage;
}

describe('unread public returns', () => {
  test('does not re-count a long streaming reply when scrolling up', () => {
    const history = [reply(Array.from({ length: 108 }, () => 'Already read'))];
    const seen = messageReadSnapshot(history);
    expect(unreadMessageCount(history, seen)).toBe(0);
    const next = [reply([...history[0].segments!.map(s => 'Already read'), 'New return'])];
    expect(unreadMessageCount(next, seen)).toBe(1);
    expect(unreadMessageCount(next, messageReadSnapshot(next))).toBe(0);
  });

  test('counts growth in the current return once, never once per token', () => {
    const seen = messageReadSnapshot([reply(['Read', 'Part'])]);
    expect(unreadMessageCount([reply(['Read', 'Partial response'])], seen)).toBe(1);
    expect(unreadMessageCount([reply(['Read', 'Partial response continues'])], seen)).toBe(1);
    expect(unreadMessageCount([reply(['Read', 'Partial response continues', 'Next'])], seen)).toBe(2);
  });

  test('counts first text after an empty streaming placeholder', () => {
    const seen = messageReadSnapshot([reply([])]);
    expect(unreadMessageCount([reply(['First output'])], seen)).toBe(1);
  });

  test('keeps prior history read after returning to bottom a second time', () => {
    const seen = messageReadSnapshot([reply(['Old', 'Latest'])]);
    expect(unreadMessageCount([reply(['Old', 'Latest'])], seen)).toBe(0);
    expect(unreadMessageCount([reply(['Old', 'Latest grows'])], seen)).toBe(1);
  });

  test('does not count tool status changes or private reasoning as messages', () => {
    const message = reply(['Read']);
    const seen = messageReadSnapshot([message]);
    const next = {...message, status: 'done', segments:[...message.segments!, {kind:'thinking',ts:2,text:'Private reasoning',visibility:'private_reasoning'}]} as ChatMessage;
    expect(unreadMessageCount([next], seen)).toBe(0);
  });
});
