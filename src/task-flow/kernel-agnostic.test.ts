import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KERNEL_IDS = /claude-code|codex|cursor-agent|codebuddy|kimi-code|forgeax-core/;
const sourceRoot = join(import.meta.dir, '..');
const taskFlowRoot = join(sourceRoot, 'task-flow');
const taskFlowFiles = readdirSync(taskFlowRoot)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => join(taskFlowRoot, name));
const renderingFiles = [
  'ProcessAccordion.tsx',
  'PlanCard.tsx',
  'TaskCard.tsx',
  'DeliverCard.tsx',
  'agent-identity.ts',
  'StepDetail.tsx',
  'StepRow.tsx',
  'FilePill.tsx',
].map((name) => join(sourceRoot, 'components', 'ChatPanel', name));

describe('task-flow kernel boundary', () => {
  test('projection and task-flow rendering do not branch on kernel ids', () => {
    const files = [...taskFlowFiles, ...renderingFiles].filter((file) => statSync(file).isFile());
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return KERNEL_IDS.test(source) ? [file] : [];
    });
    expect(offenders).toEqual([]);
  });
});
