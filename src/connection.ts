/** The host owns URL resolution and authentication when Chat is embedded. */
export interface ChatWebSocket {
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<string>) => void,
	): void;
	addEventListener(
		type: "open" | "close" | "error",
		listener: (event: Event) => void,
	): void;
	close(): void;
}

export interface ChatEventSource {
	readonly readyState: number;
	onerror: ((event: Event) => void) | null;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
	): void;
	close(): void;
}

export interface ChatConnection {
	request(path: string, init?: RequestInit): Promise<Response>;
	openWebSocket(path: string): ChatWebSocket;
	openEventSource(path: string): ChatEventSource;
}

const browserConnection: ChatConnection = {
	request: (path, init) => fetch(path, init),
	openWebSocket: (path) =>
		new WebSocket(browserChatWebSocketUrl(path, location)),
	openEventSource: (path) => new EventSource(path),
};

/** Keep Tauri's custom page scheme on the same local WebSocket origin. */
export function browserChatWebSocketUrl(
	path: string,
	page: Pick<Location, "protocol" | "host">,
): string {
	const protocol = page.protocol === "https:" ? "wss:" : "ws:";
	return new URL(path, `${protocol}//${page.host}`).href;
}

let connection: ChatConnection = browserConnection;
const cleanups = new Set<() => void>();

export function registerChatConnectionCleanup(cleanup: () => void): () => void {
	cleanups.add(cleanup);
	return () => cleanups.delete(cleanup);
}

function closeConnections(): void {
	for (const cleanup of cleanups) cleanup();
}

export function setChatConnection(next: ChatConnection): void {
	if (connection === next) return;
	closeConnections();
	connection = next;
}

/** Call when an embedding view is disposed. A later mount can configure again. */
export function disposeChatConnection(): void {
	closeConnections();
	connection = browserConnection;
}

export function chatRequest(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return connection.request(path, init);
}

export function chatWebSocket(path: string): ChatWebSocket {
	return connection.openWebSocket(path);
}

export function chatEventSource(path: string): ChatEventSource {
	return connection.openEventSource(path);
}
