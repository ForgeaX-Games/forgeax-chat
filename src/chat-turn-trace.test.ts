import { afterEach, describe, expect, test } from "bun:test";
import {
	AGENT_UNRESPONSIVE_TIMEOUT_MS,
	type ChatTelemetrySpan,
	createChatTurnTraceLifecycle,
} from "./chat-turn-trace";

const originalFetch = globalThis.fetch;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalDocument = Object.getOwnPropertyDescriptor(
	globalThis,
	"document",
);

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	if (originalDocument)
		Object.defineProperty(globalThis, "document", originalDocument);
	else delete (globalThis as { document?: unknown }).document;
});

function createHarness() {
	const spans: ChatTelemetrySpan[] = [];
	const signals: unknown[] = [];
	const recoveries: unknown[] = [];
	globalThis.fetch = (() =>
		Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	}) as typeof requestAnimationFrame;
	const lifecycle = createChatTurnTraceLifecycle({
		pushTelemetry: (records) => spans.push(...records),
		reportPassiveFeedbackSignal: (signal) => signals.push(signal),
		reportPassiveFeedbackRecovery: (resolution) => recoveries.push(resolution),
	});
	const finals = (name: string) =>
		spans.filter((span) => span.name === name && span.endTs !== undefined);
	return { lifecycle, spans, signals, recoveries, finals };
}

interface FakeTimer {
	id: number;
	callback: () => void;
	due: number;
	delay: number;
	cleared: boolean;
}

function installFakeTimers() {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const timers: FakeTimer[] = [];
	let now = 0;
	let nextId = 1;

	globalThis.setTimeout = ((callback: () => void, delay = 0) => {
		const timer = {
			id: nextId++,
			callback,
			due: now + delay,
			delay,
			cleared: false,
		};
		timers.push(timer);
		return timer.id as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		const timer = timers.find(
			(candidate) => candidate.id === (handle as unknown as number),
		);
		if (timer) timer.cleared = true;
	}) as typeof clearTimeout;

	return {
		timers,
		activeStalls: () =>
			timers.filter(
				(timer) =>
					timer.delay === AGENT_UNRESPONSIVE_TIMEOUT_MS && !timer.cleared,
			),
		advanceBy(milliseconds: number) {
			const target = now + milliseconds;
			for (;;) {
				const next = timers
					.filter((timer) => !timer.cleared && timer.due <= target)
					.sort((left, right) => left.due - right.due || left.id - right.id)[0];
				if (!next) break;
				next.cleared = true;
				now = next.due;
				next.callback();
			}
			now = target;
		},
		restore() {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		},
	};
}

describe("Chat-owned turn tracing", () => {
	test("creates the established traceparent and closes the full span tree", () => {
		const { lifecycle, spans, finals } = createHarness();

		const { traceparent } = lifecycle.beginChatTurn(
			"forge",
			"sid-1",
			"codebuddy",
		);
		lifecycle.chatFirstToken("forge");
		lifecycle.chatFirstToken("forge");
		lifecycle.chatTurnEnd("forge", "ok");

		expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		const send = finals("ui.send")[0]!;
		const children = ["ui.request", "ui.stream", "ui.render"].map(
			(name) => finals(name)[0]!,
		);
		expect(
			spans.filter(
				(span) => span.name === "ui.stream" && span.endTs !== undefined,
			),
		).toHaveLength(1);
		expect(children.every((span) => span.traceId === send.traceId)).toBe(true);
		expect(children.every((span) => span.parentSpanId === send.spanId)).toBe(
			true,
		);
		expect(children.every((span) => span.status?.code === "ok")).toBe(true);
		expect(send.attrs).toEqual({ kernel: "codebuddy" });
	});

	test("keeps cancellation distinct without counting it as an error", () => {
		const { lifecycle, finals } = createHarness();

		lifecycle.beginChatTurn("forge", "sid-1");
		lifecycle.chatFirstToken("forge");
		lifecycle.chatTurnEnd("forge", "cancelled");

		expect(finals("ui.send")[0]?.status?.code).toBe("ok");
		expect(finals("ui.send")[0]?.attrs).toEqual({ cancelled: true });
	});

	test("propagates error status and closes a turn that ended before any token", () => {
		const errorHarness = createHarness();
		errorHarness.lifecycle.beginChatTurn("forge", "sid-error");
		errorHarness.lifecycle.chatFirstToken("forge");
		errorHarness.lifecycle.chatTurnEnd("forge", "error", "boom");

		expect(errorHarness.finals("ui.send")[0]?.status).toEqual({
			code: "error",
			message: "boom",
		});
		expect(errorHarness.finals("ui.stream")[0]?.status).toEqual({
			code: "error",
			message: "boom",
		});

		const noTokenHarness = createHarness();
		noTokenHarness.lifecycle.beginChatTurn("mochi", "sid-no-token");
		noTokenHarness.lifecycle.chatTurnEnd("mochi", "ok");

		expect(noTokenHarness.finals("ui.request")).toHaveLength(1);
		expect(noTokenHarness.finals("ui.stream")).toHaveLength(0);
		expect(noTokenHarness.finals("ui.send")).toHaveLength(1);
	});

	test("keeps concurrent agent turns in separate trace trees", () => {
		const { lifecycle, finals } = createHarness();

		lifecycle.beginChatTurn("forge", "sid-1");
		lifecycle.beginChatTurn("mochi", "sid-1");
		lifecycle.chatFirstToken("forge");
		lifecycle.chatFirstToken("mochi");
		lifecycle.chatTurnEnd("forge", "ok");
		lifecycle.chatTurnEnd("mochi", "ok");

		const forgeSend = finals("ui.send").find(
			(span) => span.agentId === "forge",
		)!;
		const mochiSend = finals("ui.send").find(
			(span) => span.agentId === "mochi",
		)!;
		const forgeStream = finals("ui.stream").find(
			(span) => span.agentId === "forge",
		)!;
		expect(forgeSend.traceId).not.toBe(mochiSend.traceId);
		expect(forgeStream.traceId).toBe(forgeSend.traceId);
		expect(forgeStream.parentSpanId).toBe(forgeSend.spanId);
	});

	test("closes hidden-tab rendering immediately and marks it as deferred", () => {
		const { lifecycle, finals } = createHarness();
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { visibilityState: "hidden" },
		});
		globalThis.requestAnimationFrame = (() =>
			1) as typeof requestAnimationFrame;

		lifecycle.beginChatTurn("forge", "sid-hidden");
		lifecycle.chatFirstToken("forge");
		lifecycle.chatTurnEnd("forge", "ok");

		expect(finals("ui.render")[0]?.attrs).toEqual({ paintDeferred: true });
		expect(finals("ui.send")[0]?.attrs).toEqual({ paintDeferred: true });
	});

	test("warns only at 600 seconds and clears the scoped incident on recovery", () => {
		const clock = installFakeTimers();
		const { lifecycle, signals, recoveries, finals } = createHarness();
		try {
			lifecycle.beginChatTurn("forge", "sid-stall", "codebuddy");
			clock.advanceBy(150_000);
			expect(finals("ui.stall")).toHaveLength(0);
			clock.advanceBy(450_000);
			expect(finals("ui.stall")).toHaveLength(1);
			expect(signals).toEqual([
				expect.objectContaining({
					code: "ui.stall",
					scope: { sid: "sid-stall", agentId: "forge" },
				}),
			]);
			expect(clock.activeStalls()).toHaveLength(1);

			lifecycle.chatToolResult("forge");
			expect(clock.activeStalls()).toHaveLength(0);
			expect(recoveries).toEqual([
				{
					exceptionKey: "agent-unresponsive",
					scope: { sid: "sid-stall", agentId: "forge" },
				},
			]);
			lifecycle.chatTurnEnd("forge", "ok");
		} finally {
			lifecycle.dispose();
			clock.restore();
		}
	});

	test("fences a cleared callback after a replacement turn", () => {
		const clock = installFakeTimers();
		const { lifecycle, finals } = createHarness();
		try {
			lifecycle.beginChatTurn("forge", "sid-old");
			const stale = clock.activeStalls()[0]!;
			lifecycle.beginChatTurn("forge", "sid-new");
			stale.callback();
			expect(finals("ui.stall")).toHaveLength(0);
			expect(clock.activeStalls()).toHaveLength(1);
		} finally {
			lifecycle.dispose();
			clock.restore();
		}
	});

	test("fences a retained callback after same-turn tool recovery", () => {
		const clock = installFakeTimers();
		const { lifecycle, signals, recoveries, finals } = createHarness();
		try {
			lifecycle.beginChatTurn("forge", "sid-tool", "codebuddy");
			clock.advanceBy(AGENT_UNRESPONSIVE_TIMEOUT_MS);
			const retained = clock.activeStalls()[0]!;
			lifecycle.chatToolResult("forge");
			retained.callback();

			expect(finals("ui.stall")).toHaveLength(1);
			expect(signals).toHaveLength(1);
			expect(recoveries).toEqual([
				{
					exceptionKey: "agent-unresponsive",
					scope: { sid: "sid-tool", agentId: "forge" },
				},
			]);
			expect(clock.activeStalls()).toHaveLength(0);
		} finally {
			lifecycle.dispose();
			clock.restore();
		}
	});

	test("isolates synchronous and register-then-throw timer hosts", () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const originalFetchForTest = globalThis.fetch;
		const callbacks: Array<() => void> = [];
		globalThis.fetch = undefined as unknown as typeof fetch;
		try {
			globalThis.setTimeout = ((callback: () => void) => {
				callback();
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout;
			const synchronous = createHarness();
			globalThis.fetch = undefined as unknown as typeof fetch;
			expect(() =>
				synchronous.lifecycle.beginChatTurn("forge", "sid-sync"),
			).not.toThrow();
			expect(synchronous.signals).toHaveLength(0);
			synchronous.lifecycle.dispose();

			globalThis.setTimeout = ((callback: () => void) => {
				callbacks.push(callback);
				throw new Error("registered then threw");
			}) as typeof setTimeout;
			const throwing = createHarness();
			globalThis.fetch = undefined as unknown as typeof fetch;
			expect(() =>
				throwing.lifecycle.beginChatTurn("forge", "sid-throw"),
			).not.toThrow();
			expect(() => callbacks[0]?.()).not.toThrow();
			expect(throwing.signals).toHaveLength(0);
			throwing.lifecycle.dispose();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
			globalThis.fetch = originalFetchForTest;
		}
	});

	test("closes an ended old turn when its retained frame runs after a replacement", () => {
		const { lifecycle, finals } = createHarness();
		const frames: FrameRequestCallback[] = [];
		globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		}) as typeof requestAnimationFrame;

		lifecycle.beginChatTurn("forge", "sid-old");
		lifecycle.chatFirstToken("forge");
		lifecycle.chatTurnEnd("forge", "ok");
		lifecycle.beginChatTurn("forge", "sid-new");
		frames[0]?.(0);

		expect(
			finals("ui.render").filter((span) => span.sid === "sid-old"),
		).toHaveLength(1);
		expect(
			finals("ui.send").filter((span) => span.sid === "sid-old"),
		).toHaveLength(1);
		lifecycle.chatTurnEnd("forge", "ok");
		frames[1]?.(0);
		lifecycle.dispose();
	});

	test("isolates AbortController construction and abort failures", () => {
		const originalAbortController = globalThis.AbortController;
		const originalSetTimeout = globalThis.setTimeout;
		try {
			Object.defineProperty(globalThis, "AbortController", {
				configurable: true,
				value: class ThrowingAbortController {
					constructor() {
						throw new Error("constructor failed");
					}
				},
			});
			const construction = createHarness();
			expect(() =>
				construction.lifecycle.beginChatTurn("forge", "sid-constructor"),
			).not.toThrow();
			construction.lifecycle.dispose();

			Object.defineProperty(globalThis, "AbortController", {
				configurable: true,
				value: class ThrowingAbortController {
					signal = {} as AbortSignal;
					abort() {
						throw new Error("abort failed");
					}
				},
			});
			globalThis.setTimeout = ((callback: () => void, delay = 0) => {
				if (delay === 5_000) callback();
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout;
			const abort = createHarness();
			expect(() =>
				abort.lifecycle.beginChatTurn("mochi", "sid-abort"),
			).not.toThrow();
			abort.lifecycle.dispose();
		} finally {
			Object.defineProperty(globalThis, "AbortController", {
				configurable: true,
				value: originalAbortController,
			});
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	test("falls back when browser capability getters throw", () => {
		const cryptoDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			"crypto",
		);
		const documentDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			"document",
		);
		const frameDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			"requestAnimationFrame",
		);
		try {
			Object.defineProperty(globalThis, "crypto", {
				configurable: true,
				get() {
					throw new Error("crypto getter failed");
				},
			});
			const cryptoFailure = createHarness();
			expect(() =>
				cryptoFailure.lifecycle.beginChatTurn("forge", "sid-crypto"),
			).not.toThrow();
			cryptoFailure.lifecycle.dispose();

			if (cryptoDescriptor)
				Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
			else delete (globalThis as { crypto?: unknown }).crypto;
			const documentFailure = createHarness();
			documentFailure.lifecycle.beginChatTurn("mochi", "sid-document");
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				get() {
					throw new Error("document getter failed");
				},
			});
			expect(() =>
				documentFailure.lifecycle.chatTurnEnd("mochi", "ok"),
			).not.toThrow();
			expect(documentFailure.finals("ui.send")).toHaveLength(1);
			documentFailure.lifecycle.dispose();

			if (documentDescriptor)
				Object.defineProperty(globalThis, "document", documentDescriptor);
			else delete (globalThis as { document?: unknown }).document;
			const frameFailure = createHarness();
			frameFailure.lifecycle.beginChatTurn("sino", "sid-frame");
			Object.defineProperty(globalThis, "requestAnimationFrame", {
				configurable: true,
				get() {
					throw new Error("frame getter failed");
				},
			});
			expect(() =>
				frameFailure.lifecycle.chatTurnEnd("sino", "ok"),
			).not.toThrow();
			expect(frameFailure.finals("ui.send")).toHaveLength(1);
			frameFailure.lifecycle.dispose();
		} finally {
			if (cryptoDescriptor)
				Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
			else delete (globalThis as { crypto?: unknown }).crypto;
			if (documentDescriptor)
				Object.defineProperty(globalThis, "document", documentDescriptor);
			else delete (globalThis as { document?: unknown }).document;
			if (frameDescriptor)
				Object.defineProperty(
					globalThis,
					"requestAnimationFrame",
					frameDescriptor,
				);
			else
				delete (globalThis as { requestAnimationFrame?: unknown })
					.requestAnimationFrame;
		}
	});

	test("isolates product sink failures from every turn transition", () => {
		globalThis.fetch = (() => {
			throw new Error("fetch failed");
		}) as typeof fetch;
		globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		}) as typeof requestAnimationFrame;
		const lifecycle = createChatTurnTraceLifecycle({
			pushTelemetry: () => {
				throw new Error("telemetry failed");
			},
			reportPassiveFeedbackSignal: () => {
				throw new Error("signal failed");
			},
			reportPassiveFeedbackRecovery: () => {
				throw new Error("recovery failed");
			},
		});

		expect(() => {
			lifecycle.beginChatTurn("forge", "sid-1");
			lifecycle.chatFirstToken("forge");
			lifecycle.chatToolResult("forge");
			lifecycle.chatTurnEnd("forge", "ok");
			lifecycle.dispose();
		}).not.toThrow();
	});
});
