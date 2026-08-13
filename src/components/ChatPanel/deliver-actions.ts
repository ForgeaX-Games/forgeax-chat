import { requestComposerText } from '@forgeax/interface/lib/composer-bridge';

export type DeliverCommandId =
  | 'app.files.reveal';

export type DeliverCommandExecutor = (
  id: DeliverCommandId,
  args: { path: string } | { version: string },
) => Promise<unknown>;

export function createDeliverActions(
  executeCommand: DeliverCommandExecutor,
  requestText: typeof requestComposerText = requestComposerText,
) {
  return {
    onReveal(path: string): void {
      void executeCommand('app.files.reveal', { path }).catch((error) => {
        console.warn('[chat] file reveal command failed', error);
      });
    },
    onNext(text: string, recommendationId?: string): void {
      requestText(text, 'append', recommendationId);
    },
  };
}
