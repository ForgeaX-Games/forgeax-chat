import { afterEach, describe, expect, test } from "bun:test";
import {
	browserChatWebSocketUrl,
	type ChatConnection,
	type ChatEventSource,
} from "./connection";
import {
	configureChatRuntime,
	disposeChatConnection,
	parseSse,
	useShellStore,
} from "./runtime";
import {
	_sessionBridgeInternals,
	connectForgeaXWs,
	emitForgeaXMessage,
	getForgeaXWsStatus,
	onSessionEvent,
} from "./session-bridge";
import { subscribeDaemonTick } from "./session-store/daemon-tick";
import { subscribeSessionStream } from "./session-store/session-stream";
import { _chatInternals, useChatStore } from "./session-store/store";

const initialShell = useShellStore.getState();
const initialChat = useChatStore.getState();
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function serveChat() {
	const requests: Array<{ path: string; body: string }> = [];
	const sockets = new Set<{ close(): void }>();
	let nativeReplies = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request, server) {
			const url = new URL(request.url);
			if (url.pathname === "/ws") {
				if (server.upgrade(request, { data: { url: request.url } }))
					return undefined;
				return new Response("upgrade failed", { status: 500 });
			}
			const body = request.method === "POST" ? await request.text() : "";
			requests.push({ path: url.pathname, body });
			if (url.pathname === "/api/threads/sid-history")
				return Response.json({ thread: { runIds: ["run-history"] } });
			if (url.pathname === "/api/runs/run-history/events") {
				if (url.searchParams.get("stream") === "poll")
					return Response.json({
						run: {
							id: "run-history",
							threadId: "sid-history",
							agentId: "forgeax",
							providerId: "test-cli",
							status: "streaming",
							message: "history prompt",
							createdAt: 1,
							lastEventAt: 2,
						},
						events: [],
					});
				const content = JSON.stringify({
					id: "history-token",
					seq: 1,
					ts: 3,
					runId: "run-history",
					event: { type: "TEXT_MESSAGE_CONTENT", delta: "replayed" },
				});
				const finished = JSON.stringify({
					id: "history-done",
					seq: 2,
					ts: 4,
					runId: "run-history",
					event: { type: "RUN_FINISHED" },
				});
				return new Response(
					`event: TEXT_MESSAGE_CONTENT\ndata: ${content}\n\nevent: RUN_FINISHED\ndata: ${finished}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (url.pathname === "/api/cli/chat") {
				if (body.includes("http-error"))
					return Response.json(
						{ error: "provider unavailable" },
						{ status: 503 },
					);
				if (body.includes("wait-for-cancel"))
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(
										'event: token\ndata: {"text":"started"}\n\n',
									),
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				return new Response(
					'event: token\ndata: {"text":"hello","providerId":"test-cli"}\n\nevent: done\ndata: {}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (
				url.pathname.startsWith("/api/sessions/") &&
				url.pathname.endsWith("/messages")
			) {
				if (body.includes("native-wait-for-cancel")) await Bun.sleep(150);
				nativeReplies += 1;
				return Response.json({ ok: true, msgId: "m-1" });
			}
			if (url.pathname.includes("get_agent_model"))
				return Response.json({
					result: { ok: true, data: { selected: "test-model" } },
				});
			return Response.json({ ok: true });
		},
		websocket: {
			open(ws) {
				sockets.add(ws);
				ws.send(
					JSON.stringify({
						type: "session-event",
						sid: new URL(ws.data.url).searchParams.get("sid"),
						emitterId: "forgeax",
						event: {
							source: "agent:forgeax",
							type: "hook:turnStart",
							payload: {},
							ts: 1,
						},
					}),
				);
			},
			close(ws) {
				sockets.delete(ws);
			},
			message() {},
		},
	});
	servers.push(server);
	const base = `http://127.0.0.1:${server.port}`;
	const connection: ChatConnection = {
		request: (path, init) => fetch(new URL(path, base), init),
		openWebSocket: (path) =>
			new WebSocket(new URL(path, base).href.replace(/^http/, "ws")),
		openEventSource: () => {
			throw new Error("SSE history not used in this test");
		},
	};
	return {
		server,
		base,
		requests,
		sockets,
		connection,
		nativeReplies: () => nativeReplies,
	};
}

function proxyEventSource(
	path: string,
	base: string,
	onClose: () => void,
): ChatEventSource {
	const abort = new AbortController();
	const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	const source: ChatEventSource = {
		readyState: 0,
		onerror: null,
		addEventListener(type, listener) {
			const handlers =
				listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
			handlers.add(listener);
			listeners.set(type, handlers);
		},
		close() {
			if (source.readyState === 2) return;
			Object.assign(source, { readyState: 2 });
			abort.abort();
			onClose();
		},
	};
	void fetch(new URL(path, base), { signal: abort.signal })
		.then(async (response) => {
			Object.assign(source, { readyState: 1 });
			if (!response.body) throw new Error("missing SSE body");
			for await (const frame of parseSse(response.body)) {
				const event = new MessageEvent(frame.event, { data: frame.data });
				for (const listener of listeners.get(frame.event) ?? []) {
					if (typeof listener === "function") listener(event);
					else listener.handleEvent(event);
				}
			}
		})
		.catch((error) => {
			if (!abort.signal.aborted)
				source.onerror?.(new ErrorEvent("error", { error }));
		});
	return source;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let n = 0; n < 100; n += 1) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for loopback event");
}

afterEach(() => {
	disposeChatConnection();
	useChatStore.setState(initialChat, true);
	useShellStore.setState(initialShell, true);
	for (const server of servers.splice(0)) server.stop(true);
});

describe("embedded Chat connection against a loopback service", () => {
	test("keeps the legacy Web/Tauri WebSocket scheme mapping", () => {
		expect(
			browserChatWebSocketUrl("/ws?sid=s1", {
				protocol: "tauri:",
				host: "localhost",
			}),
		).toBe("ws://localhost/ws?sid=s1");
		expect(
			browserChatWebSocketUrl("/ws?sid=s1", {
				protocol: "https:",
				host: "studio.example",
			}),
		).toBe("wss://studio.example/ws?sid=s1");
	});

	test("sends a native message and receives its live event without using the page origin", async () => {
		const service = serveChat();
		configureChatRuntime({ connection: service.connection });
		let count = 0;
		let staleCount = 0;
		const staleUnsubscribe = onSessionEvent("integration", () => {
			staleCount += 1;
		});
		const unsubscribe = onSessionEvent("integration", (event) => {
			if (event.sid === "sid-1") count += 1;
		});
		staleUnsubscribe();
		connectForgeaXWs("sid-1");
		await waitFor(() => count === 1);
		expect(staleCount).toBe(0);
		const result = await emitForgeaXMessage("sid-1", "hello", {
			to: "forgeax",
		});
		expect(result).toEqual({ ok: true, msgId: "m-1" });
		expect(
			JSON.parse(
				service.requests.find((r) => r.path.endsWith("/messages"))?.body ??
					"{}",
			),
		).toMatchObject({ content: "hello", to: "forgeax" });
		expect(getForgeaXWsStatus()).toEqual({ connected: true, sid: "sid-1" });
		unsubscribe();
	});

	test("routes the real CLI send and streamed answer through the injected service", async () => {
		const service = serveChat();
		configureChatRuntime({ connection: service.connection });
		useShellStore.setState({
			activeSid: "sid-cli",
			currentSessionId: "sid-cli",
			tabs: [
				{
					sid: "sid-cli",
					agentId: "forgeax",
					providerOverride: "test-cli",
					displayName: "test",
				},
			],
			providerOverride: "test-cli",
		});
		await useChatStore.getState().sendMessage("hello service");
		const messages =
			useChatStore.getState().bySid["sid-cli"]?.messagesByAgent.forgeax ?? [];
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(messages[1]).toMatchObject({
			text: "hello",
			status: "done",
			providerId: "test-cli",
		});
		expect(
			service.requests.some(
				(request) =>
					request.path === "/api/cli/chat" &&
					request.body.includes("hello service"),
			),
		).toBe(true);
	});

	test("surfaces HTTP failures and sends cancellation to the injected service", async () => {
		const service = serveChat();
		configureChatRuntime({ connection: service.connection });
		useShellStore.setState({
			activeSid: "sid-cli",
			currentSessionId: "sid-cli",
			tabs: [
				{
					sid: "sid-cli",
					agentId: "forgeax",
					providerOverride: "test-cli",
					displayName: "test",
				},
			],
			providerOverride: "test-cli",
		});
		await useChatStore.getState().sendMessage("http-error");
		const failed = useChatStore
			.getState()
			.bySid["sid-cli"]?.messagesByAgent.forgeax.at(-1);
		expect(failed).toMatchObject({
			status: "error",
			errorMessage: "503 provider unavailable",
		});
		const pending = useChatStore.getState().sendMessage("wait-for-cancel");
		await waitFor(
			() =>
				useChatStore.getState().bySid["sid-cli"]?.messagesByAgent.forgeax.at(-1)
					?.text === "started",
		);
		useChatStore.getState().cancelStream();
		await Promise.race([
			pending,
			Bun.sleep(1000).then(() => {
				throw new Error("cancel did not finish stream");
			}),
		]);
		await waitFor(() =>
			service.requests.some(
				(request) => request.path === "/api/sessions/sid-cli/abort",
			),
		);
		expect(
			useChatStore.getState().bySid["sid-cli"]?.messagesByAgent.forgeax.at(-1)
				?.status,
		).toBe("done");
		expect(
			useChatStore.getState().bySid["sid-cli"]?.streamingByAgent.forgeax,
		).toBeFalsy();
	});

	test("keeps a cancelled native POST terminal when its delayed response settles", async () => {
		const service = serveChat();
		// A host proxy may finish a request after its caller aborts. The Chat
		// turn must still keep the user's cancellation as its terminal state.
		configureChatRuntime({
			connection: {
				...service.connection,
				request: (path, init) =>
					path.endsWith("/messages")
						? fetch(new URL(path, service.base), { ...init, signal: undefined })
						: service.connection.request(path, init),
			},
		});
		useShellStore.setState({
			activeSid: "sid-native",
			currentSessionId: "sid-native",
			tabs: [
				{
					sid: "sid-native",
					agentId: "forgeax",
					providerOverride: null,
					displayName: "test",
				},
			],
			providerOverride: null,
		});
		const pending = useChatStore
			.getState()
			.sendMessage("native-wait-for-cancel");
		await waitFor(() =>
			service.requests.some(
				(request) => request.path === "/api/sessions/sid-native/messages",
			),
		);
		useChatStore.getState().cancelStream();
		await pending;
		expect(service.nativeReplies()).toBe(1);
		const conversation = useChatStore.getState().bySid["sid-native"];
		expect(conversation?.messagesByAgent.forgeax.at(-1)?.status).toBe("done");
		expect(
			conversation?.messagesByAgent.forgeax.at(-1)?.errorMessage,
		).toBeUndefined();
		expect(conversation?.streamingByAgent.forgeax).toBeFalsy();
		expect(_chatInternals.abortByTab.has("sid-native")).toBe(false);
		await waitFor(() =>
			service.requests.some(
				(request) => request.path === "/api/sessions/sid-native/abort",
			),
		);
	});

	test("opens a real history SSE tail through the host factory and closes it after replay", async () => {
		const service = serveChat();
		let closed = 0;
		configureChatRuntime({
			connection: {
				...service.connection,
				openEventSource: (path) =>
					proxyEventSource(path, service.base, () => {
						closed += 1;
					}),
			},
		});
		useShellStore.setState({
			activeSid: "sid-history",
			currentSessionId: "sid-history",
			tabs: [
				{
					sid: "sid-history",
					agentId: "forgeax",
					providerOverride: "test-cli",
					displayName: "test",
				},
			],
			providerOverride: "test-cli",
		});
		await useChatStore.getState().loadThreadHistory("sid-history");
		await waitFor(
			() =>
				useChatStore
					.getState()
					.bySid["sid-history"]?.messagesByAgent.forgeax.at(-1)?.status ===
				"done",
		);
		expect(
			useChatStore
				.getState()
				.bySid["sid-history"]?.messagesByAgent.forgeax.at(-1)?.text,
		).toBe("replayed");
		expect(
			service.requests.some(
				(request) => request.path === "/api/runs/run-history/events",
			),
		).toBe(true);
		expect(closed).toBe(1);
	});

	test("switching hosts closes the old stream and routes later requests only to the new service", async () => {
		const first = serveChat();
		const second = serveChat();
		configureChatRuntime({ connection: first.connection });
		connectForgeaXWs("sid-1");
		await waitFor(() => first.sockets.size === 1);
		connectForgeaXWs("sid-1");
		expect(first.sockets.size).toBe(1);
		configureChatRuntime({ connection: second.connection });
		await waitFor(() => first.sockets.size === 0);
		connectForgeaXWs("sid-2");
		await waitFor(() => second.sockets.size === 1);
		await emitForgeaXMessage("sid-2", "second");
		expect(
			first.requests.some((request) => request.path.endsWith("/messages")),
		).toBe(false);
		expect(
			second.requests.some((request) => request.path.endsWith("/messages")),
		).toBe(true);
	});

	test("repeated view boot keeps one subscription and disposal releases it", () => {
		let broadcastListeners = 0;
		configureChatRuntime({
			subscribeBroadcast: () => {
				broadcastListeners += 1;
				return () => {
					broadcastListeners -= 1;
				};
			},
		});
		const firstStop = subscribeDaemonTick();
		expect(subscribeDaemonTick()).toBe(firstStop);
		subscribeSessionStream();
		subscribeSessionStream();
		expect(broadcastListeners).toBe(3);
		expect(
			_sessionBridgeInternals.hasSessionEventHandler("session-stream"),
		).toBe(true);
		disposeChatConnection();
		expect(broadcastListeners).toBe(0);
		expect(
			_sessionBridgeInternals.hasSessionEventHandler("session-stream"),
		).toBe(false);
		subscribeDaemonTick();
		subscribeSessionStream();
		expect(broadcastListeners).toBe(3);
		expect(
			_sessionBridgeInternals.hasSessionEventHandler("session-stream"),
		).toBe(true);
	});
});
