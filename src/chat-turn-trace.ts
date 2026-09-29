export interface ChatTelemetrySpan {
	kind: "span";
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTs: number;
	endTs?: number;
	provisional?: boolean;
	attrs?: Record<string, unknown>;
	status?: { code: "ok" | "error"; message?: string };
	sid?: string;
	agentId?: string;
}

export type ChatTelemetryRecord = ChatTelemetrySpan;

export interface ChatPassiveFeedbackScope {
	sid?: string;
	agentId?: string;
}

export interface ChatTurnTraceSinks {
	pushTelemetry(records: ChatTelemetryRecord[]): void;
	reportPassiveFeedbackSignal(signal: {
		code: string;
		message: string;
		scope?: ChatPassiveFeedbackScope;
	}): void;
	reportPassiveFeedbackRecovery(resolution: {
		exceptionKey: string;
		scope?: ChatPassiveFeedbackScope;
	}): void;
}

export interface ChatTurnTraceLifecycle {
	beginChatTurn(
		agentId: string,
		sid?: string,
		kernel?: string,
	): { traceparent: string };
	chatFirstToken(agentId: string): void;
	chatToolResult(agentId: string): void;
	chatTurnEnd(
		agentId: string,
		outcome: "ok" | "cancelled" | "error",
		errorMessage?: string,
	): void;
	dispose(): void;
}

interface SpanContext {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTs: number;
	sid?: string;
	agentId?: string;
}

interface ActiveTurn {
	traceId: string;
	root: SpanContext;
	request?: SpanContext;
	stream?: SpanContext;
	firstTokenSeen: boolean;
	ended: boolean;
	kernel?: string;
	stallTimer?: ReturnType<typeof setTimeout>;
	stallGeneration: number;
	stalls: number;
}

export const AGENT_UNRESPONSIVE_TIMEOUT_MS = 600_000;

function randomHex(bytes: number): string {
	const values = new Uint8Array(bytes);
	let filled = false;
	try {
		const cryptoImpl = globalThis.crypto;
		if (cryptoImpl?.getRandomValues) {
			cryptoImpl.getRandomValues(values);
			filled = true;
		}
	} catch {
		filled = false;
	}
	if (!filled) {
		for (let index = 0; index < bytes; index += 1) {
			values[index] = Math.floor(Math.random() * 256);
		}
	}
	return [...values]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

export function toTraceparent(context: SpanContext): string {
	return `00-${context.traceId}-${context.spanId}-01`;
}

function postTelemetry(records: ChatTelemetryRecord[]): void {
	let fetchImpl: typeof fetch | undefined;
	try {
		fetchImpl = globalThis.fetch;
	} catch {
		return;
	}
	if (!fetchImpl) return;

	let controller: AbortController | undefined;
	try {
		const AbortControllerImpl = globalThis.AbortController;
		controller = AbortControllerImpl ? new AbortControllerImpl() : undefined;
	} catch {
		controller = undefined;
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	if (controller) {
		try {
			timeout = globalThis.setTimeout(() => {
				try {
					controller?.abort();
				} catch {
					// A broken abort implementation must not affect Chat.
				}
			}, 5_000);
		} catch {
			timeout = undefined;
		}
	}

	try {
		void fetchImpl("/api/telemetry", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ records }),
			...(controller ? { signal: controller.signal } : {}),
		})
			.catch(() => undefined)
			.finally(() => {
				if (timeout === undefined) return;
				try {
					globalThis.clearTimeout(timeout);
				} catch {
					// Telemetry cleanup must never affect Chat.
				}
			});
	} catch {
		if (timeout !== undefined) {
			try {
				globalThis.clearTimeout(timeout);
			} catch {
				// Telemetry cleanup must never affect Chat.
			}
		}
	}
}

export function createChatTurnTraceLifecycle(
	sinks: ChatTurnTraceSinks,
): ChatTurnTraceLifecycle {
	const active = new Map<string, ActiveTurn>();
	const uploadBuffer: ChatTelemetryRecord[] = [];
	let disposed = false;

	const emit = (span: ChatTelemetrySpan): void => {
		try {
			sinks.pushTelemetry([span]);
		} catch {
			// Product telemetry is an optional sink.
		}
		uploadBuffer.push(span);
	};

	const flush = (): void => {
		if (uploadBuffer.length === 0) return;
		postTelemetry(uploadBuffer.splice(0));
	};

	const startSpan = (
		name: string,
		options: {
			traceId: string;
			parentSpanId?: string;
			sid?: string;
			agentId?: string;
			attrs?: Record<string, unknown>;
		},
	): SpanContext => {
		const context: SpanContext = {
			traceId: options.traceId,
			spanId: randomHex(8),
			name,
			startTs: Date.now(),
			...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
			...(options.sid ? { sid: options.sid } : {}),
			...(options.agentId ? { agentId: options.agentId } : {}),
		};
		emit({
			kind: "span",
			...context,
			provisional: true,
			...(options.attrs ? { attrs: options.attrs } : {}),
		});
		return context;
	};

	const endSpan = (
		context: SpanContext,
		status?: { code: "ok" | "error"; message?: string },
		attrs?: Record<string, unknown>,
	): void => {
		emit({
			kind: "span",
			traceId: context.traceId,
			spanId: context.spanId,
			...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
			name: context.name,
			startTs: context.startTs,
			endTs: Date.now(),
			...(context.sid ? { sid: context.sid } : {}),
			...(context.agentId ? { agentId: context.agentId } : {}),
			...(status ? { status } : {}),
			...(attrs ? { attrs } : {}),
		});
	};

	const clearStall = (turn: ActiveTurn): void => {
		turn.stallGeneration += 1;
		if (turn.stallTimer === undefined) return;
		const timer = turn.stallTimer;
		turn.stallTimer = undefined;
		try {
			globalThis.clearTimeout(timer);
		} catch {
			// A broken timer host must not block turn settlement.
		}
	};

	const scopeFor = (
		agentId: string,
		turn: ActiveTurn,
	): ChatPassiveFeedbackScope => ({
		agentId,
		...(turn.root.sid ? { sid: turn.root.sid } : {}),
	});

	const resolveStall = (agentId: string, turn: ActiveTurn): void => {
		const reported = turn.stalls > 0;
		clearStall(turn);
		if (!reported) return;
		try {
			sinks.reportPassiveFeedbackRecovery({
				exceptionKey: "agent-unresponsive",
				scope: scopeFor(agentId, turn),
			});
		} catch {
			// Product feedback is an optional sink.
		}
	};

	const armStall = (agentId: string): void => {
		if (disposed) return;
		const turn = active.get(agentId);
		if (!turn) return;

		const generation = turn.stallGeneration + 1;
		turn.stallGeneration = generation;
		let registering = true;
		let firedSynchronously = false;
		const callback = (): void => {
			if (registering) {
				firedSynchronously = true;
				return;
			}
			const current = active.get(agentId);
			if (
				disposed ||
				current !== turn ||
				current.stallGeneration !== generation ||
				current.firstTokenSeen ||
				current.ended
			)
				return;
			current.stallTimer = undefined;

			current.stalls += 1;
			const waitedMs = AGENT_UNRESPONSIVE_TIMEOUT_MS * current.stalls;
			const kernel = current.kernel ?? "unknown";
			const seconds = Math.round(waitedMs / 1_000);
			const stall = startSpan("ui.stall", {
				traceId: current.traceId,
				parentSpanId: current.root.spanId,
				agentId,
				sid: current.root.sid,
				attrs: { waitedMs, kernel, reason: "no-first-token" },
			});
			endSpan(
				stall,
				{
					code: "error",
					message: `no response after ${seconds}s (kernel=${kernel})`,
				},
				{ waitedMs, kernel },
			);
			try {
				globalThis.console?.warn(
					`[trace] ui.stall: no first token after ${seconds}s, kernel=${kernel} sid=${current.root.sid ?? "-"}`,
				);
			} catch {
				// Console availability must not affect tracing.
			}
			try {
				sinks.reportPassiveFeedbackSignal({
					code: "ui.stall",
					message: `Agent did not respond after ${seconds} seconds\nkernel=${kernel}\nsid=${current.root.sid ?? "-"}`,
					scope: scopeFor(agentId, current),
				});
			} catch {
				// Product feedback is an optional sink.
			}
			flush();
			armStall(agentId);
		};

		try {
			const timer = globalThis.setTimeout(
				callback,
				AGENT_UNRESPONSIVE_TIMEOUT_MS,
			);
			registering = false;
			if (
				firedSynchronously ||
				disposed ||
				active.get(agentId) !== turn ||
				turn.stallGeneration !== generation ||
				turn.ended ||
				turn.firstTokenSeen
			) {
				if (turn.stallGeneration === generation) turn.stallGeneration += 1;
				try {
					globalThis.clearTimeout(timer);
				} catch {
					// The stale callback remains fenced by identity and disposed state.
				}
				return;
			}
			turn.stallTimer = timer;
		} catch {
			registering = false;
			if (turn.stallGeneration === generation) turn.stallGeneration += 1;
			turn.stallTimer = undefined;
		}
	};

	const beginChatTurn = (
		agentId: string,
		sid?: string,
		kernel?: string,
	): { traceparent: string } => {
		const traceId = randomHex(16);
		const previous = active.get(agentId);
		if (previous) resolveStall(agentId, previous);

		const root = startSpan("ui.send", {
			traceId,
			sid,
			agentId,
			...(kernel ? { attrs: { kernel } } : {}),
		});
		const request = startSpan("ui.request", {
			traceId,
			parentSpanId: root.spanId,
			sid,
			agentId,
		});
		const turn: ActiveTurn = {
			traceId,
			root,
			request,
			firstTokenSeen: false,
			ended: false,
			kernel,
			stallGeneration: 0,
			stalls: 0,
		};
		active.set(agentId, turn);
		flush();
		armStall(agentId);
		return { traceparent: toTraceparent(request) };
	};

	const chatFirstToken = (agentId: string): void => {
		const turn = active.get(agentId);
		if (!turn || turn.firstTokenSeen || turn.ended) return;
		turn.firstTokenSeen = true;
		resolveStall(agentId, turn);
		if (turn.request) endSpan(turn.request, { code: "ok" });
		turn.stream = startSpan("ui.stream", {
			traceId: turn.traceId,
			parentSpanId: turn.root.spanId,
			agentId,
			sid: turn.root.sid,
		});
	};

	const chatToolResult = (agentId: string): void => {
		const turn = active.get(agentId);
		if (!turn || turn.ended) return;
		resolveStall(agentId, turn);
	};

	const chatTurnEnd = (
		agentId: string,
		outcome: "ok" | "cancelled" | "error",
		errorMessage?: string,
	): void => {
		const turn = active.get(agentId);
		if (!turn || turn.ended) return;
		turn.ended = true;
		resolveStall(agentId, turn);

		const status: { code: "ok" | "error"; message?: string } =
			outcome === "error"
				? { code: "error", ...(errorMessage ? { message: errorMessage } : {}) }
				: { code: "ok" };
		if (turn.request && !turn.firstTokenSeen) endSpan(turn.request, status);
		if (turn.stream) endSpan(turn.stream, status);

		const render = startSpan("ui.render", {
			traceId: turn.traceId,
			parentSpanId: turn.root.spanId,
			agentId,
			sid: turn.root.sid,
		});
		let finished = false;
		const finish = (paintDeferred: boolean): void => {
			if (finished || disposed) return;
			finished = true;
			const rootAttrs = {
				...(turn.kernel ? { kernel: turn.kernel } : {}),
				...(outcome === "cancelled" ? { cancelled: true } : {}),
				...(paintDeferred ? { paintDeferred: true } : {}),
			};
			endSpan(
				render,
				status,
				paintDeferred ? { paintDeferred: true } : undefined,
			);
			endSpan(
				turn.root,
				status,
				Object.keys(rootAttrs).length > 0 ? rootAttrs : undefined,
			);
			if (active.get(agentId) === turn) active.delete(agentId);
			flush();
		};

		let hidden = false;
		let scheduleFrame: typeof requestAnimationFrame | undefined;
		try {
			hidden = globalThis.document?.visibilityState === "hidden";
			scheduleFrame = globalThis.requestAnimationFrame;
		} catch {
			finish(false);
			return;
		}
		if (hidden || !scheduleFrame) {
			finish(hidden);
			return;
		}
		try {
			scheduleFrame(() => finish(false));
		} catch {
			finish(false);
		}
	};

	return {
		beginChatTurn,
		chatFirstToken,
		chatToolResult,
		chatTurnEnd,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const turn of active.values()) clearStall(turn);
			active.clear();
			uploadBuffer.length = 0;
		},
	};
}
