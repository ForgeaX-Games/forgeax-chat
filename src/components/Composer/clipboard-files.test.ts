import { expect, test } from 'bun:test';
import { clipboardFiles } from './clipboard-files';
const image = new File(['png'], 'shot.png', { type: 'image/png' });
const pdf = new File(['pdf'], 'paper.pdf', { type: 'application/pdf' });
const transfer = (files: File[], items: unknown[]) => ({ files, items }) as unknown as DataTransfer;
test('accepts file-list-only screenshots and documents', () => {
  expect(clipboardFiles(transfer([image, pdf], []))).toEqual([image, pdf]);
});
test('does not duplicate files exposed through both clipboard views', () => {
  expect(clipboardFiles(transfer([image], [{ kind:'file', getAsFile: () => image }]))).toEqual([image]);
});
test('falls back to file items and ignores unavailable or text items', () => {
  expect(clipboardFiles(transfer([], [{kind:'string'}, {kind:'file',getAsFile:()=>null}, {kind:'file',getAsFile:()=>pdf}]))).toEqual([pdf]);
  expect(clipboardFiles(transfer([], []))).toEqual([]);
});
