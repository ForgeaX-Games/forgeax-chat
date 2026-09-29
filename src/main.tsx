// Standalone Chat entry. Product-shell services are injected by @forgeax/ide in
// the assembled product; this entry intentionally runs with Chat's local host
// fallback and only establishes the session bridge needed by the conversation.
//
// Why only <ChatPanel/> (no DockShell/surfaces): an app dev server proxies only
// /api·/ws, so mounting DockShell's surface iframes would SPA-fall back to this
// app's own index.html and nest infinitely. We mount just the chat surface
// full-viewport over the booted shared store + chat session stream.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./standalone.css";
import {
	BrandProvider,
	ErrorBoundary,
	initI18n,
	subscribePermissionStream,
	useShellStore,
} from "@forgeax/chat/runtime";
import { applyTheme } from "@forgeax/design/theme";
import { ChatPanel } from "./components/ChatPanel/ChatPanel";
import {
	connectForgeaXWs,
	ensureSession,
	fetchSessionList,
	subscribeDaemonTick,
	subscribeSessionStream,
} from "./session-store";
import { initializeStandaloneSessions } from "./standalone-session-bootstrap";

// The single surface child fills the full-viewport flex shell.
const SHELL_CSS = `
.forgeax-standalone-shell { position: fixed; inset: 0; display: flex; overflow: hidden; background: var(--color-background, #0e1216); }
.forgeax-standalone-shell > * { flex: 1 1 auto; min-width: 0; min-height: 0; }
`;

async function boot(): Promise<void> {
	// Dark-only today; index.html already dual-marks data-theme + .dark for no-flash.
	applyTheme("dark");
	initI18n();

	const rootEl = document.getElementById("root");
	if (!rootEl) throw new Error("#root missing");

	// Attach Chat's event reducer before the socket so no first frame is lost.
	subscribeSessionStream();
	subscribePermissionStream();
	subscribeDaemonTick();

	createRoot(rootEl).render(
		<StrictMode>
			<ErrorBoundary scope="chat-standalone">
				<BrandProvider>
					<style>{SHELL_CSS}</style>
					<div className="forgeax-standalone-shell studio-shell studio-shell--preview-skin">
						<ChatPanel />
					</div>
				</BrandProvider>
			</ErrorBoundary>
		</StrictMode>,
	);

	void initializeStandaloneSessions({
		fetchSessionList,
		ensureSession,
		connect: connectForgeaXWs,
		setState: useShellStore.setState,
	});

	if (import.meta.env.DEV) {
		(window as unknown as Record<string, unknown>).__dev = useShellStore;
	}
	(
		window as unknown as { __forgeaxBoot?: { done?: () => void } }
	).__forgeaxBoot?.done?.();
}

void boot();
