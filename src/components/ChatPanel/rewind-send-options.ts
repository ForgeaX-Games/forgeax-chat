import type { SendMessageOpts } from '../../session-store';

/** Capture the specialist choice with the resend action, including an explicit clear. */
export function rewindSendOptions(
  summonAgentId: string | null,
  isStreaming: boolean,
): Pick<SendMessageOpts, 'handoff' | 'summonAgentId'> {
  return {
    ...(isStreaming ? { handoff: 'steer' as const } : {}),
    summonAgentId,
  };
}
