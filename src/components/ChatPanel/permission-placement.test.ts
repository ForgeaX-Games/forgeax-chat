import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('approval is inside the observed conversation content, before the unread overlay', () => {
  const source = readFileSync(new URL('./ChatPanel.tsx', import.meta.url), 'utf8');
  const permission = source.indexOf('<PermissionPrompt />');
  const unread = source.indexOf('{(unread > 0 || (pendingPermission && !following)) && (');
  const handoffs = source.indexOf('<HandoffFeed ');
  expect(permission).toBeGreaterThan(0);
  expect(permission).toBeLessThan(unread);
  expect(permission).toBeLessThan(handoffs);
  expect(source.match(/<PermissionPrompt \/>/g)).toHaveLength(1);
  expect(source.slice(permission, unread)).toMatch(/<PermissionPrompt \/>\s*<\/div>/);
});
