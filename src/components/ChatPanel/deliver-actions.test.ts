import { describe, expect, it } from 'bun:test';
import { createDeliverActions } from './deliver-actions';

describe('createDeliverActions', () => {
  it('dispatches host commands with the task-flow payloads', async () => {
    const calls: Array<{ id: string; args: unknown }> = [];
    const textRequests: Array<{ text: string; mode: string | undefined }> = [];
    const actions = createDeliverActions(
      async (id, args) => {
        calls.push({ id, args });
      },
      (text, mode) => {
        textRequests.push({ text, mode });
      },
    );

    actions.onReveal('src/main.ts');
    actions.onNext('Tune movement');
    expect(calls).toEqual([
      { id: 'app.files.reveal', args: { path: 'src/main.ts' } },
    ]);
    expect(textRequests).toEqual([{ text: 'Tune movement', mode: 'append' }]);
  });
});
