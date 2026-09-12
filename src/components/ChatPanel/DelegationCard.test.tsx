import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('@forgeax/interface/i18n', () => ({ getLocale: () => 'en' }));
mock.module('./use-agent-thread', () => ({ useOpenAgentThread: () => () => {} }));
mock.module('./useAgentNames', () => ({ useAgentNames: () => (id: string) => id }));
const { DelegationCard } = await import('./DelegationCard');
test('parallel delegation is separate from todo and retains the owning task identity', () => {
  const html = renderToStaticMarkup(<DelegationCard snapshot={{ delegationId: 'd1', ownerTaskId: 'task-old', agent: 'suzu', status: 'waiting_permission' }} text="Waiting for approval" />);
  expect(html).toContain('Parallel delegation');
  expect(html).toContain('Waiting for approval');
  expect(html).toContain('data-owner-task-id="task-old"');
  expect(html).toContain('data-status="waiting_permission"');
  expect(html).not.toContain('Running');
  expect(html).not.toContain('tx-status-in_progress');
});
