import { describe, expect, it } from 'bun:test';
import { CLI_PREWARM_ENDPOINT, runCliPrewarm } from './cli-prewarm';

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

describe('CLI composer prewarm', () => {
  it('retries one 503 with bounded backoff, succeeds exactly once, and releases inFlight', async () => {
    const attemptKey = 'sid\u0000agent\u0000codex';
    const inFlight = new Set<string>();
    const succeeded = new Set<string>();
    const requests: string[] = [];
    const delays: number[] = [];

    await runCliPrewarm({
      attemptKey,
      inFlight,
      succeeded,
      sleep: async (delayMs) => { delays.push(delayMs); },
      request: async (endpoint) => {
        requests.push(endpoint);
        return requests.length === 1
          ? response(503, { error: 'temporary provider failure' })
          : response(200, { ok: true });
      },
    });

    // The prewarm transport must never create a hidden model turn: every
    // request in this recovery path is the empty `/api/cli/warm` endpoint,
    // never `/api/cli/chat`.
    expect(requests).toEqual([CLI_PREWARM_ENDPOINT, CLI_PREWARM_ENDPOINT]);
    expect(requests).not.toContain('/api/cli/chat');
    expect(delays).toEqual([100]);
    expect(inFlight.has(attemptKey)).toBe(false);
    expect(succeeded).toEqual(new Set([attemptKey]));
  });

  it('leaves a failed key retryable and does not wait for a real message', async () => {
    const attemptKey = 'sid\u0000agent\u0000codex';
    const inFlight = new Set<string>();
    const succeeded = new Set<string>();
    const requests: string[] = [];
    let releaseWarm!: () => void;
    const warmPending = new Promise<Response>((resolve) => { releaseWarm = () => resolve(response(200, { ok: true })); });

    const prewarm = runCliPrewarm({
      attemptKey,
      inFlight,
      succeeded,
      request: async (endpoint) => {
        requests.push(endpoint);
        return warmPending;
      },
    });
    let messageSent = false;
    await Promise.resolve().then(() => { messageSent = true; });

    expect(messageSent).toBe(true);
    expect(requests).toEqual([CLI_PREWARM_ENDPOINT]);
    expect(requests).not.toContain('/api/cli/chat');
    expect(inFlight.has(attemptKey)).toBe(true);
    expect(succeeded.has(attemptKey)).toBe(false);

    releaseWarm();
    await prewarm;
    expect(inFlight.has(attemptKey)).toBe(false);
    expect(succeeded.has(attemptKey)).toBe(true);
  });

  it('cleans inFlight after all bounded attempts fail without marking success', async () => {
    const attemptKey = 'sid\u0000agent\u0000codex';
    const inFlight = new Set<string>();
    const succeeded = new Set<string>();
    let requestCount = 0;

    await expect(runCliPrewarm({
      attemptKey,
      inFlight,
      succeeded,
      sleep: async () => {},
      request: async () => {
        requestCount += 1;
        return response(503, { error: 'still unavailable' });
      },
    })).rejects.toThrow('HTTP 503');

    expect(requestCount).toBe(2);
    expect(inFlight.has(attemptKey)).toBe(false);
    expect(succeeded.has(attemptKey)).toBe(false);
  });
});
