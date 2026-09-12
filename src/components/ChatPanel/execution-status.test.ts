import { expect, test } from 'bun:test';
import { processWaitsForPermission } from './execution-status';
import type { ProcessTrace } from '../../task-flow/model';
const process: ProcessTrace = { id: 't1', startedAt: 1, phase: 'running', entries: [], agentIds: ['forge', 'suzu'] };
test('approval wait is scoped to the process owner and never revives a stopped process', () => {
  expect(processWaitsForPermission(process, { agent: 'forge' })).toBe(true);
  expect(processWaitsForPermission(process, { agent: 'suzu' })).toBe(false);
  expect(processWaitsForPermission(process, null)).toBe(false);
  expect(processWaitsForPermission({ ...process, phase: 'error' }, { agent: 'forge' })).toBe(false);
});
