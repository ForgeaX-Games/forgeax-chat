import { describe, expect, test } from 'bun:test';
import { deriveExecutionStage, executionStageLabelKey } from './execution-stage';

describe('deriveExecutionStage', () => {
  test('keeps a silent running turn explicitly unknown', () => {
    expect(deriveExecutionStage({ status: 'running' })).toBe('unknown');
  });

  test('uses streamed text/thinking as generation evidence', () => {
    expect(deriveExecutionStage({ status: 'running', text: 'partial answer' })).toBe('generating');
    expect(deriveExecutionStage({
      status: 'running',
      segments: [{ kind: 'thinking', ts: 1, text: 'checking', visibility: 'public_summary' }],
    })).toBe('generating');
  });

  test('prioritizes explicit authorization and input waits over generic output', () => {
    expect(deriveExecutionStage({
      status: 'running',
      text: 'before permission',
      toolCalls: [{ callId: 'p', name: 'ask_user', args: {}, status: 'running', permissionPrompt: true }],
    })).toBe('waiting_for_input');
    expect(deriveExecutionStage({
      status: 'waiting',
      toolCalls: [{ callId: 'q', name: 'ask_user', args: {}, status: 'running', permissionPrompt: false }],
    })).toBe('waiting_for_input');
  });

  test('distinguishes ordinary tool and child execution', () => {
    expect(deriveExecutionStage({
      status: 'running',
      toolCalls: [{ callId: 't', name: 'read_file', args: {}, status: 'running' }],
    })).toBe('tool_execution');
    expect(deriveExecutionStage({
      status: 'running',
      toolCalls: [{ callId: 's', name: 'subagent', args: {}, status: 'running' }],
      subAgents: {
        child: { emitterId: 'child', text: '', toolCalls: [], status: 'streaming', startedAt: 1 },
      },
    })).toBe('child_execution');
  });

  test('does not reuse an earlier text segment after a tool has finished', () => {
    expect(deriveExecutionStage({
      status: 'running',
      text: 'before the tool',
      segments: [
        { kind: 'text', ts: 1, text: 'before the tool' },
        { kind: 'tool', ts: 2, tool: { callId: 't', name: 'read_file', args: {}, status: 'done' } },
      ],
    })).toBe('unknown');
  });

  test('does not guess an explanation for an unclassified wait', () => {
    expect(deriveExecutionStage({ status: 'waiting' })).toBe('unknown');
    expect(deriveExecutionStage({ status: 'done' })).toBe('unknown');
  });

  test('maps every stage to a stable translation key', () => {
    expect(executionStageLabelKey('tool_execution')).toBe('executionStage.toolExecution');
    expect(executionStageLabelKey('unknown')).toBe('executionStage.unknown');
  });
});

test('terminal messages never advertise a stale pending tool as live work', () => {
  for (const status of ['done', 'error'] as const) {
    expect(deriveExecutionStage({ status, toolCalls: [{ callId: 'ask', name: 'ask_user', args: {}, status: 'running' }] })).toBe('unknown');
  }
});
