import { describe, expect, test } from 'bun:test';
import manifest from './fixtures/agent-baseline.json';

describe('Agent baseline extension contract', () => {
  test('exposes only public Chat contributions and capabilities', () => {
    expect(manifest.kind).toBe('agent');
    expect(manifest.contributions).toContain('chat.conversation');
    expect(manifest.capabilities).toEqual(['agent.session.read', 'agent.session.write']);
    expect(JSON.stringify(manifest)).not.toMatch(/engine|editor/i);
  });
});
