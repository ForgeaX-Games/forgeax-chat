export const CLI_PREWARM_MAX_ATTEMPTS = 2;
export const CLI_PREWARM_ENDPOINT = '/api/cli/warm';
// Prewarm is optional. After a complete retry cycle fails, pause this provider
// briefly so fast session switching cannot multiply a shared provider outage.
export const CLI_PREWARM_COOLDOWN_MS = 5_000;
const CLI_PREWARM_BASE_DELAY_MS = 100;
const CLI_PREWARM_MAX_DELAY_MS = 1_000;

type Sleep = (delayMs: number) => Promise<void>;

interface PrewarmState {
  attemptKey: string;
  /** Shared per provider, unlike attemptKey which is per session/agent. */
  cooldownKey: string;
  inFlight: Set<string>;
  /** Prevent concurrent requests for one provider across different sessions. */
  providerInFlight: Set<string>;
  succeeded: Set<string>;
  /** Maps provider keys to their exclusive cooldown deadline. */
  cooldowns: Map<string, number>;
  request: (endpoint: typeof CLI_PREWARM_ENDPOINT) => Promise<Response>;
  sleep?: Sleep;
  now?: () => number;
}

interface PrewarmOptions {
  maxAttempts?: number;
  sleep?: Sleep;
}

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

function retryDelayMs(attempt: number): number {
  return Math.min(CLI_PREWARM_BASE_DELAY_MS * (2 ** attempt), CLI_PREWARM_MAX_DELAY_MS);
}

function clearExpiredCooldowns(cooldowns: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of cooldowns) {
    if (expiresAt <= now) cooldowns.delete(key);
  }
}

async function prewarmWithRetry(
  request: () => Promise<Response>,
  { maxAttempts = CLI_PREWARM_MAX_ATTEMPTS, sleep: wait = sleep }: PrewarmOptions = {},
): Promise<void> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await request();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as { ok?: boolean; error?: string };
      if (result.ok === false) throw new Error(result.error ?? 'prewarm failed');
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
      await wait(retryDelayMs(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('prewarm failed');
}

/**
 * Start one keyed prewarm without making it part of the real message turn.
 * Only a fully successful warm is terminal. A complete failed retry cycle
 * pauses the provider briefly; expired entries are cleared opportunistically.
 */
export async function runCliPrewarm({
  attemptKey,
  cooldownKey,
  inFlight,
  providerInFlight,
  succeeded,
  cooldowns,
  request,
  sleep: wait,
  now: getNow = Date.now,
}: PrewarmState): Promise<void> {
  const now = getNow();
  clearExpiredCooldowns(cooldowns, now);
  if ((cooldowns.get(cooldownKey) ?? 0) > now) return;
  if (succeeded.has(attemptKey) || inFlight.has(attemptKey) || providerInFlight.has(cooldownKey)) return;
  inFlight.add(attemptKey);
  providerInFlight.add(cooldownKey);
  try {
    await prewarmWithRetry(() => request(CLI_PREWARM_ENDPOINT), { sleep: wait });
    succeeded.add(attemptKey);
  } catch (error) {
    cooldowns.set(cooldownKey, getNow() + CLI_PREWARM_COOLDOWN_MS);
    throw error;
  } finally {
    inFlight.delete(attemptKey);
    providerInFlight.delete(cooldownKey);
  }
}
