import { describe, expect, test } from 'bun:test';
import { agentLookupKey, extensionIdForAgent } from './extension-page-for-agent';

const EXTENSIONS = [
  { id: '@forgeax-extension/gen3d', contributes: { pages: [{ id: 'main', preferredAgent: '@forgeax-extension/agent-gen3d' }] } },
  { id: '@forgeax-extension/scene-generator', contributes: { pages: [{ id: 'main', preferredAgent: 'sino' }] } },
  { id: '@forgeax-extension/3d-lowpoly', contributes: { pages: [{ id: 'main', preferredAgent: '@forgeax-plugin/agent-lowpoly' }] } },
  { id: '@forgeax-extension/lowpoly-obj', contributes: { pages: [{ id: 'main', preferredAgent: '@forgeax-extension/agent-cc-coder' }] } },
  { id: '@forgeax-extension/reel', contributes: { pages: [{ id: 'main', preferredAgent: 'reia' }] } },
  { id: '@forgeax-extension/hidden', contributes: { pages: [{ id: 'main' }] } },
];

describe('agentLookupKey', () => {
  test('strips extension id and agent- prefix', () => {
    expect(agentLookupKey('@forgeax-extension/agent-gen3d')).toBe('gen3d');
  });

  test('strips instance suffix', () => {
    expect(agentLookupKey('gen3d#1')).toBe('gen3d');
  });

  test('keeps bare agent ids', () => {
    expect(agentLookupKey('sino')).toBe('sino');
  });
});

describe('extensionIdForAgent', () => {
  test('opens gen3d for the Gen3D catalog / capsule id', () => {
    expect(extensionIdForAgent('gen3d', EXTENSIONS)).toBe('@forgeax-extension/gen3d');
  });

  test('matches a live session path with instance suffix', () => {
    expect(extensionIdForAgent('gen3d#1', EXTENSIONS)).toBe('@forgeax-extension/gen3d');
  });

  test('matches Sino by exact preferredAgent id', () => {
    expect(extensionIdForAgent('sino', EXTENSIONS)).toBe('@forgeax-extension/scene-generator');
  });

  test('matches lowpoly across @forgeax-plugin vs @forgeax-extension', () => {
    expect(extensionIdForAgent('lowpoly', EXTENSIONS)).toBe('@forgeax-extension/3d-lowpoly');
  });

  test('returns null for Forge (no preferred page)', () => {
    expect(extensionIdForAgent('forge', EXTENSIONS)).toBeNull();
  });

  test('returns null when two extension pages claim the same agent', () => {
    const dup = [
      ...EXTENSIONS,
      { id: '@forgeax-extension/gen3d-alt', contributes: { pages: [{ id: 'main', preferredAgent: 'gen3d' }] } },
    ];
    expect(extensionIdForAgent('gen3d', dup)).toBeNull();
  });
});
