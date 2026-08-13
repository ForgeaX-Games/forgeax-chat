import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStats, filesByChange } from './stats';

describe('task-flow stats', () => {
  it('derives summary counts from the file list', () => {
    const files = [
      { path: 'a.ts', change: 'edit' as const, insertions: 2, deletions: 1 },
      { path: 'b.png', change: 'new' as const },
      { path: 'c.ts', change: 'del' as const },
    ];
    assert.deepEqual(deriveStats(files), {
      total: 3,
      edits: 1,
      additions: 1,
      deletions: 1,
      insertions: 2,
      deletedLines: 1,
    });
    assert.equal(filesByChange(files).new[0]?.path, 'b.png');
  });
});
