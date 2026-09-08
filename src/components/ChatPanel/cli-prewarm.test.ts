import { describe, expect, it } from 'bun:test';
import {
  CLI_PREWARM_COOLDOWN_MS,
  CLI_PREWARM_ENDPOINT,
  runCliPrewarm,
} from './cli-prewarm';

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
      cooldownKey: 'codex',
      inFlight,
      providerInFlight: new Set(),
      succeeded,
      cooldowns: new Map(),
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
      cooldownKey: 'codex',
      inFlight,
      providerInFlight: new Set(),
      succeeded,
      cooldowns: new Map(),
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

  it('keeps one provider single-flight across fast session switches and releases it on completion', async () => {
    const inFlight = new Set<string>();
    const providerInFlight = new Set<string>();
    const succeeded = new Set<string>();
    const cooldowns = new Map<string, number>();
    const requests: string[] = [];
    let releaseWarm!: () => void;
    const warmPending = new Promise<Response>((resolve) => {
      releaseWarm = () => resolve(response(200, { ok: true }));
    });
    const request = async (endpoint: string) => {
      requests.push(endpoint);
      return warmPending;
    };

    const first = runCliPrewarm({
      attemptKey: 'sid-a\u0000agent\u0000claude-code',
      cooldownKey: 'claude-code',
      inFlight,
      providerInFlight,
      succeeded,
      cooldowns,
      request,
    });
    await Promise.resolve();

    const second = runCliPrewarm({
      attemptKey: 'sid-b\u0000agent\u0000claude-code',
      cooldownKey: 'claude-code',
      inFlight,
      providerInFlight,
      succeeded,
      cooldowns,
      request,
    });
    await Promise.resolve();

    expect(requests).toEqual([CLI_PREWARM_ENDPOINT]);
    expect(providerInFlight).toEqual(new Set(['claude-code']));

    releaseWarm();
    await Promise.all([first, second]);
    expect(providerInFlight.size).toBe(0);
  });

  it('cleans inFlight after all bounded attempts fail without marking success', async () => {
    const attemptKey = 'sid\u0000agent\u0000codex';
    const inFlight = new Set<string>();
    const providerInFlight = new Set<string>();
    const succeeded = new Set<string>();
    let requestCount = 0;

    await expect(runCliPrewarm({
      attemptKey,
      cooldownKey: 'codex',
      inFlight,
      providerInFlight,
      succeeded,
      cooldowns: new Map(),
      sleep: async () => {},
      request: async () => {
        requestCount += 1;
        return response(503, { error: 'still unavailable' });
      },
    })).rejects.toThrow('HTTP 503');

    expect(requestCount).toBe(2);
    expect(inFlight.has(attemptKey)).toBe(false);
    expect(providerInFlight.size).toBe(0);
    expect(succeeded.has(attemptKey)).toBe(false);
  });

  it('opens a provider-level cooldown after repeated failures, then expires and cleans it', async () => {
    const inFlight = new Set<string>();
    const succeeded = new Set<string>();
    const cooldowns = new Map<string, number>();
    let now = 10_000;
    let requestCount = 0;
    const request = async () => {
      requestCount += 1;
      return response(503, { error: 'provider unavailable' });
    };

    await expect(runCliPrewarm({
      attemptKey: 'sid-a\u0000agent\u0000claude-code',
      cooldownKey: 'claude-code',
      inFlight,
      providerInFlight: new Set(),
      succeeded,
      cooldowns,
      now: () => now,
      sleep: async () => {},
      request,
    })).rejects.toThrow('HTTP 503');

    expect(requestCount).toBe(2);
    expect(cooldowns.get('claude-code')).toBe(now + CLI_PREWARM_COOLDOWN_MS);
    cooldowns.set('another-provider', now + 1);

    // A fast session switch must not turn one failed provider into another
    // two-request burst while its breaker is open.
    await runCliPrewarm({
      attemptKey: 'sid-b\u0000agent\u0000claude-code',
      cooldownKey: 'claude-code',
      inFlight,
      providerInFlight: new Set(),
      succeeded,
      cooldowns,
      now: () => now,
      sleep: async () => {},
      request,
    });
    expect(requestCount).toBe(2);

    now += CLI_PREWARM_COOLDOWN_MS;
    await expect(runCliPrewarm({
      attemptKey: 'sid-c\u0000agent\u0000claude-code',
      cooldownKey: 'claude-code',
      inFlight,
      providerInFlight: new Set(),
      succeeded,
      cooldowns,
      now: () => now,
      sleep: async () => {},
      request,
    })).rejects.toThrow('HTTP 503');

    expect(requestCount).toBe(4);
    expect(cooldowns.size).toBe(1);
    expect(cooldowns.has('another-provider')).toBe(false);
  });
});
