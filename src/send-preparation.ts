export interface ChatSendPreparation { readonly sessionId: string }
type Prepare = (request: ChatSendPreparation) => void | Promise<void>;
const handlers = new Set<Prepare>();

/** Product hosts may establish page-owned resources before a user turn starts. */
export function registerChatSendPreparation(prepare: Prepare): () => void {
  handlers.add(prepare);
  return () => { handlers.delete(prepare); };
}

export function prepareChatSend(request: ChatSendPreparation): Promise<void> | undefined {
  if (handlers.size === 0) return undefined;
  return Promise.resolve().then(() => Promise.all([...handlers].map(prepare => prepare(request)))).then(() => {});
}
