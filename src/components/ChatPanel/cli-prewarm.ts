export const CLI_PREWARM_MAX_ATTEMPTS = 2;
export const CLI_PREWARM_ENDPOINT = '/api/cli/warm';
const CLI_PREWARM_BASE_DELAY_MS = 100;
const CLI_PREWARM_MAX_DELAY_MS = 1_000;

type Sleep = (delayMs: number) => Promise<void>;

interface PrewarmState {
  attemptKey: string;
  inFlight: Set<string>;
  succeeded: Set<string>;
  request: (endpoint: typeof CLI_PREWARM_ENDPOINT) => Promise<Response>;
  sleep?: Sleep;
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
 * Only a fully successful warm is terminal; every exit path releases inFlight.
 */
export async function runCliPrewarm({
  attemptKey,
  inFlight,
  succeeded,
  request,
  sleep: wait,
}: PrewarmState): Promise<void> {
  if (succeeded.has(attemptKey) || inFlight.has(attemptKey)) return;
  inFlight.add(attemptKey);
  try {
    await prewarmWithRetry(() => request(CLI_PREWARM_ENDPOINT), { sleep: wait });
    succeeded.add(attemptKey);
  } finally {
    inFlight.delete(attemptKey);
  }
}
