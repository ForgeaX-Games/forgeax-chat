import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

function section(text: string, from: string, until: string): string {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = text.indexOf(until, start);
  assert.ok(end > start, `missing ${until}`);
  return text.slice(start, end);
}

describe('inter-agent handoff navigation contract', () => {
  it('does not auto-select a teammate from the dispatch event', () => {
    const capsuleListener = section(
      source('ChatAgentCapsule.tsx'),
      "onSessionEvent('chat-agent-capsule-pat'",
      '  // 气泡显示期间',
    );
    const parkingListener = section(
      source('use-agent-thread.ts'),
      '  useEffect(() => {\n    return subscribeToParkedHandoff',
      '  const backToMain',
    );

    assert.doesNotMatch(capsuleListener, /setTabAgent\(/);
    assert.doesNotMatch(parkingListener, /setTabAgent\(/);
    assert.match(parkingListener, /subscribeToParkedHandoff\(onSessionEvent, activeSid,/);
    assert.match(parkingListener, /setLastSubBySid\(/);
  });

  it('keeps selecting a teammate behind an explicit return action', () => {
    const returnToSub = section(
      source('use-agent-thread.ts'),
      '  const returnToSub',
      '  // A sub-agent view',
    );
    assert.match(returnToSub, /setTabAgent\(activeSid, id\)/);
    assert.match(returnToSub, /openAgentWorkspace\(id,/);
  });

  it('keeps the parked-handoff subscription owned by ChatPanel alone', () => {
    const chatPanel = source('ChatPanel.tsx');
    const planCard = source('PlanCard.tsx');
    const taskCard = source('TaskCard.tsx');

    assert.match(chatPanel, /useAgentThreadNav\(\)/);
    assert.doesNotMatch(planCard, /useAgentThreadNav\(\)/);
    assert.doesNotMatch(taskCard, /useAgentThreadNav\(\)/);
    assert.match(planCard, /useOpenAgentThread\(\)/);
    assert.match(taskCard, /useOpenAgentThread\(\)/);
  });
});
