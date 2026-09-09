import { afterEach, expect, test } from 'bun:test';
import { handoffBounds, readHandoffHeight } from './handoff-size';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
test('reserves chat space and bounds small viewports', () => {
  expect(handoffBounds(600)).toEqual({min:96,max:440});
  expect(handoffBounds(200)).toEqual({min:40,max:40});
  expect(handoffBounds(100)).toEqual({min:0,max:0});
});
test('loads only the current session and rejects corrupt sizes', () => {
  const values = new Map([
    ['forgeax.chat.handoff-height.v1:A', '232'],
    ['forgeax.chat.handoff-height.v1:bad', 'NaN'],
    ['forgeax.chat.handoff-height.v1:small', '-1'],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:{getItem:(key:string)=>values.get(key)??null}});
  expect(readHandoffHeight('A')).toBe(232);
  for (const sid of ['B','bad','small']) expect(readHandoffHeight(sid)).toBe(132);
});
test('disabled storage falls back without breaking chat', () => {
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, get:()=>{throw Error('denied');}});
  expect(readHandoffHeight('A')).toBe(132);
});
