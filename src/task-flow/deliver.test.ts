import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskFlowToolCall } from './model';
import { readDeliver } from './deliver';

describe('readDeliver', () => {
  it('prefers the complete structured compatibility field over display text', () => {
    const tool: TaskFlowToolCall = {
      callId: 'deliver-1',
      name: 'deliver_summary',
      args: {},
      status: 'done',
      result: '{"outcome":"truncated"}',
      resultData: {
        summary: {
          outcome: 'Complete',
          files: Array.from({ length: 60 }, (_, index) => ({ path: `src/${index}.ts`, change: 'edit' })),
        },
      },
    };
    const result = readDeliver(tool);
    assert.equal(result?.outcome, 'Complete');
    assert.equal(result?.files.length, 60);
  });

  it('accepts the legacy full result string and rejects invalid payloads', () => {
    const valid: TaskFlowToolCall = {
      callId: 'deliver-2',
      name: 'deliver_summary',
      args: {},
      status: 'done',
      fullResultContent: JSON.stringify({
        outcome: 'Done',
        files: [],
        tests: [{ name: 'legacy test', ok: true }],
        build: { version: 'legacy-build' },
      }),
    };
    assert.deepEqual(readDeliver(valid), {
      outcome: 'Done',
      roundLabel: undefined,
      files: [],
      tests: [{ name: 'legacy test', ok: true }],
      next: undefined,
      build: { version: 'legacy-build', label: undefined },
      agents: undefined,
      durationMs: undefined,
      costUsd: undefined,
      derivedUnavailable: undefined,
      unattributedCount: undefined,
    });
    assert.equal(readDeliver({ ...valid, fullResultContent: '{"files":[]}' }), null);
  });

  it('normalizes the host-enriched contract envelope from every complete string field', () => {
    const envelope = {
      ok: true,
      summary: {
        outcome: 'Delivered',
        roundLabel: 'Round 7',
        tests: [
          { name: 'unit tests', pass: true },
          { name: 'build', pass: false },
        ],
        build: 'v1.2.3',
        files: [{ path: 'src/game.ts', change: 'edit', insertions: 4, deletions: 1, binary: false }],
        meta: {
          durationMs: 1234,
          agents: ['forge', 'iori'],
          costUsd: 0.42,
          derivedUnavailable: true,
          unattributedCount: 2,
        },
      },
    };
    const serialized = JSON.stringify(envelope);

    for (const field of ['resultData', 'fullResultContent', 'result'] as const) {
      const result = readDeliver({
        callId: `deliver-${field}`,
        name: 'deliver_summary',
        args: {},
        status: 'done',
        [field]: serialized,
      });
      assert.deepEqual(result, {
        outcome: 'Delivered',
        roundLabel: 'Round 7',
        files: [{ path: 'src/game.ts', change: 'edit', insertions: 4, deletions: 1 }],
        tests: [
          { name: 'unit tests', ok: true },
          { name: 'build', ok: false },
        ],
        next: undefined,
        build: { version: 'v1.2.3' },
        agents: ['forge', 'iori'],
        durationMs: 1234,
        costUsd: 0.42,
        derivedUnavailable: true,
        unattributedCount: 2,
      });
    }
  });

  it('reads the complete result when the display result exceeds its 2000-character limit', () => {
    const envelope = {
      ok: true,
      summary: {
        outcome: 'Large delivery',
        files: Array.from({ length: 140 }, (_, index) => ({
          path: `src/generated/${index}.ts`,
          change: 'new',
          insertions: index,
          deletions: 0,
          binary: false,
        })),
        meta: { durationMs: 10, agents: [], derivedUnavailable: false },
      },
    };
    const fullResultContent = JSON.stringify(envelope);
    assert.ok(fullResultContent.length > 2000);
    const result = readDeliver({
      callId: 'deliver-large',
      name: 'deliver_summary',
      args: {},
      status: 'done',
      result: fullResultContent.slice(0, 2000),
      fullResultContent,
    });

    assert.equal(result?.files.length, 140);
    assert.equal(result?.files.at(-1)?.path, 'src/generated/139.ts');
    assert.equal(result?.derivedUnavailable, false);
  });
});
