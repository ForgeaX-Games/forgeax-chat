import { expect, test } from 'bun:test';
import { executionFailureKind, executionFailureMessages } from './execution-failure';

test('summarizes public validation errors even when a protocol envelope is truncated', () => {
  const text = 'protocol: tool "example_tool" failed 2 consecutive times: {"toolUseId":"call_x","isError":true,"content":"Invalid arguments for example_tool at $.params.operationId: value does not match pattern';
  expect(executionFailureKind(text + '…')).toBe('validation');
  expect(executionFailureKind('{"errorCategory":"validation","validationPath":"$.value"}')).toBe('validation');
  expect(executionFailureMessages('zh-CN').validation).not.toContain('网络');
  expect(executionFailureMessages('en').validation).not.toContain('retry');
});
test('unknown or truncated diagnostics always get a short generic message', () => {
  for (const text of ['{"nested":', 'Something failed at stack frame\n'.repeat(50), '<script>alert(1)</script>']) {
    const kind = executionFailureKind(text);
    expect(kind).toBe('unknown');
    expect(executionFailureMessages()[kind].length).toBeLessThan(100);
  }
  expect(executionFailureKind('protocol: tool "example" failed 2 consecutive times: {')).toBe('protocol');
  expect(executionFailureKind('Turn interrupted')).toBe('interrupted');
});
