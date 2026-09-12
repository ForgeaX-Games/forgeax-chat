import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProcessPhase, ProcessTrace } from '../../task-flow/model';
import { tasksFromProcess } from '../../task-flow/process-tasks';

mock.module('@forgeax/interface/i18n', () => ({ getLocale: () => 'en', useTranslation: () => ({ t: (key: string) => key }) }));
mock.module('./agent-identity', () => ({ useAgentIdentities: () => () => undefined }));
mock.module('./use-agent-thread', () => ({ useOpenAgentThread: () => () => {} }));
mock.module('./AgentIdentityAvatar', () => ({ AgentIdentityAvatar: () => null }));
const { PlanCard } = await import('./PlanCard');

function render(phase: ProcessPhase, completed = false) {
  const process: ProcessTrace = {
    id: 'sino-turn', phase, startedAt: 1, agentIds: ['sino'], entries: [],
    todo: { updatedAt: 2, items: completed
      ? [{ content: 'Done', status: 'completed' }, { content: 'Dropped', status: 'cancelled' }]
      : [{ content: 'Reshape', status: 'in_progress' }, { content: 'Verify', status: 'pending' }] },
  };
  return renderToStaticMarkup(<PlanCard tasks={tasksFromProcess(process)} phase={phase} fallbackAgentId="sino" />);
}

describe('plan lifecycle rendering', () => {
  for (const phase of ['done', 'error', 'aborted'] as const) {
    test(`${phase} stops the header spinner and active row without inventing completion`, () => {
      const html = render(phase);
      expect(html).toContain('tx-plan-owner-state is-stopped');
      expect(html).not.toContain('is-running');
      expect(html).not.toContain('class="spin"');
      expect(html).not.toContain('tx-status-in_progress');
      expect(html).not.toContain('tx-status-completed');
      expect(html).toContain(phase === 'done' ? 'lucide-circle-pause' : 'lucide-circle-alert');
    });
  }
  for (const phase of ['running', 'waiting_for_input'] as const) {
    test(`${phase} keeps the unfinished plan active`, () => {
      const html = render(phase);
      expect(html).toContain('tx-plan-owner-state is-running');
      expect(html).toContain('spin');
      expect(html).toContain('tx-status-in_progress');
    });
  }
  test('explicitly settled checklist shows completion', () => {
    expect(render('done', true)).toContain('tx-plan-owner-state is-done');
    expect(render('running', true)).toContain('tx-plan-owner-state is-done');
  });
  test('failure or cancellation never gets a successful owner badge', () => {
    expect(render('error', true)).not.toContain('is-done');
    expect(render('aborted', true)).not.toContain('is-done');
  });
});
