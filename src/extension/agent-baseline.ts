import manifest from './fixtures/agent-baseline.json';

export interface AgentBaselineAdapter {
  readonly manifest: typeof manifest;
  activate(): { contribution: string; capabilities: readonly string[] };
}

export function createAgentBaselineAdapter(): AgentBaselineAdapter {
  return {
    manifest,
    activate: () => ({
      contribution: 'chat.conversation',
      capabilities: manifest.capabilities,
    }),
  };
}
