import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentMatches, avatarInitials, avatarInitialsForAgents, canSummonSpecialistFromActiveThread, extensionIdToAgentKey, preferredAgentKeyForPage, reconcileSummonSelection, queuedSendOptions, resolveSummonAgentId } from './agent-key';

describe('Composer specialist keys', () => {
  it('normalises extension and plugin preferred-agent ids', () => {
    assert.equal(extensionIdToAgentKey('@forgeax-extension/agent-gen3d'), 'gen3d');
    assert.equal(extensionIdToAgentKey('@forgeax-plugin/agent-lowpoly'), 'lowpoly');
    assert.equal(extensionIdToAgentKey('reia'), 'reia');
  });

  it('resolves the active page preferred agent from the real extension API shape', () => {
    const extensions = [{
      id: '@forgeax-extension/skill',
      version: '0.1.0',
      kind: 'workbench',
      displayName: { zh: '技能特效', en: 'Skills & VFX' },
      contributes: {
        pages: [{
          id: 'skill',
          title: { zh: '技能特效', en: 'Skills & VFX' },
          preferredAgent: '@forgeax-extension/agent-vfx-artist-3d',
        }],
      },
      // A stale legacy value must never override the page-level contract.
      workbench: { preferredAgent: 'wrong-agent' },
    }];

    assert.equal(
      preferredAgentKeyForPage(
        extensions,
        '@forgeax-extension/skill',
        '@forgeax-extension/skill#page/skill',
      ),
      'vfx-artist-3d',
    );
  });

  it('resolves bare ids and the exact page in a multi-page extension', () => {
    const extensions = [{
      id: '@forgeax-extension/reel',
      contributes: {
        pages: [
          { id: 'overview', preferredAgent: '@forgeax-extension/agent-director' },
          { id: 'reel', preferredAgent: 'reia' },
        ],
      },
    }];

    assert.equal(
      preferredAgentKeyForPage(
        extensions,
        '@forgeax-extension/reel',
        '@forgeax-extension/reel#page/reel',
      ),
      'reia',
    );
  });

  it('returns null when the active page has no preferred agent or is not a page', () => {
    const extensions = [{
      id: '@forgeax-extension/narrative',
      contributes: { pages: [{ id: 'narrative' }] },
    }];

    assert.equal(
      preferredAgentKeyForPage(
        extensions,
        '@forgeax-extension/narrative',
        '@forgeax-extension/narrative#page/narrative',
      ),
      null,
    );
    assert.equal(
      preferredAgentKeyForPage(
        extensions,
        '@forgeax-extension/narrative',
        '@forgeax-extension/narrative#page/missing',
      ),
      null,
    );
    assert.equal(
      preferredAgentKeyForPage(
        extensions,
        '@forgeax-extension/narrative',
        '@forgeax-extension/narrative#panel/narrative',
      ),
      null,
    );
    assert.equal(preferredAgentKeyForPage(extensions, undefined, undefined), null);
  });

  it('keeps server initials but derives readable labels for emoji avatars', () => {
    assert.equal(avatarInitials('cc-coder', 'CC'), 'CC');
    assert.equal(avatarInitials('character-designer-2d', '🧑'), 'CD');
    const agents = [
      { id: 'character-designer-2d', avatar: '🧑' },
      { id: 'codex-default', avatar: '🤖' },
    ];
    const expected = { 'character-designer-2d': 'CD', 'codex-default': 'CO' };
    assert.deepEqual(avatarInitialsForAgents(agents), expected);
    assert.deepEqual(avatarInitialsForAgents([...agents].reverse()), expected);
  });

  it('matches multi-instance runtime agents', () => {
    assert.equal(agentMatches('gen3d#1', 'gen3d'), true);
    assert.equal(agentMatches('gen3d-alt', 'gen3d'), false);
  });

  it('resets only for a panel change and never lets late defaults overwrite manual choice', () => {
    expect(reconcileSummonSelection({ summonAgentId: 'old', manual: true }, 'new', true))
      .toEqual({ summonAgentId: 'new', manual: false });
    expect(reconcileSummonSelection({ summonAgentId: 'manual', manual: true }, 'late-default', false))
      .toEqual({ summonAgentId: 'manual', manual: true });
    expect(reconcileSummonSelection({ summonAgentId: null, manual: false }, 'late-default', false, ['late-default']))
      .toEqual({ summonAgentId: 'late-default', manual: false });
    // A page without preferredAgent still permits manual selection; a later
    // registry update removing it must revoke that selection rather than send it.
    expect(reconcileSummonSelection({ summonAgentId: 'removed', manual: true }, null, false, ['other']))
      .toEqual({ summonAgentId: null, manual: true });
  });

  it('keeps the selection origin when a known agent invalidates, so only automatic defaults recover', () => {
    expect(reconcileSummonSelection({ summonAgentId: 'auto', manual: false }, null, false, ['other']))
      .toEqual({ summonAgentId: null, manual: false });
    expect(reconcileSummonSelection({ summonAgentId: null, manual: false }, 'recovered-default', false, ['recovered-default']))
      .toEqual({ summonAgentId: 'recovered-default', manual: false });
    expect(reconcileSummonSelection({ summonAgentId: 'manual', manual: true }, null, false, ['other']))
      .toEqual({ summonAgentId: null, manual: true });
    expect(reconcileSummonSelection({ summonAgentId: null, manual: true }, 'later-default', false, ['later-default']))
      .toEqual({ summonAgentId: null, manual: true });
  });

  it('only resolves a currently visible specialist for a new message', () => {
    expect(resolveSummonAgentId('iori', ['iori', 'mika'])).toBe('iori');
    expect(resolveSummonAgentId('iori', ['mika'])).toBeNull();
    expect(resolveSummonAgentId('iori', undefined)).toBeNull();
    expect(resolveSummonAgentId(null, ['iori'])).toBeNull();
  });

  it('fails closed until the active thread is affirmatively known to be root, then restores its selection', () => {
    const rawMainSelection = 'iori';
    const catalog = ['iori', 'mika'];
    // #57 keeps Composer mounted while root identity may still be loading.
    // Treat both unknown and known-sub-agent views as unable to inherit the
    // main-thread expert.
    expect(canSummonSpecialistFromActiveThread('suzu', null)).toBe(false);
    expect(resolveSummonAgentId(rawMainSelection, catalog, canSummonSpecialistFromActiveThread('suzu', null))).toBeNull();
    expect(canSummonSpecialistFromActiveThread('suzu', 'forge')).toBe(false);
    expect(resolveSummonAgentId(rawMainSelection, catalog, canSummonSpecialistFromActiveThread('suzu', 'forge'))).toBeNull();
    // Returning to the parked root re-enables the still-valid raw choice.
    expect(canSummonSpecialistFromActiveThread('forge', 'forge')).toBe(true);
    expect(resolveSummonAgentId(rawMainSelection, catalog, canSummonSpecialistFromActiveThread('forge', 'forge'))).toBe('iori');
  });

  it('does not erase raw selection while the agent list is unknown', () => {
    expect(reconcileSummonSelection({ summonAgentId: 'iori', manual: true }, null, false, undefined))
      .toEqual({ summonAgentId: 'iori', manual: true });
    expect(reconcileSummonSelection({ summonAgentId: 'preferred', manual: false }, null, false, undefined))
      .toEqual({ summonAgentId: 'preferred', manual: false });
  });

  it('sends a queued item using its own snapshot, including send-now steer', () => {
    expect(queuedSendOptions('iori', false, true)).toEqual({ summonAgentId: 'iori' });
    expect(queuedSendOptions('iori', true, true)).toEqual({ handoff: 'steer', summonAgentId: 'iori' });
    expect(queuedSendOptions(null, false, true)).toEqual({ summonAgentId: null });
  });
});
