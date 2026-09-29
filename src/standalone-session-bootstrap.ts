import type { ChatHostState } from "./runtime";

export interface StandaloneSessionSummary {
	sid: string;
	displayName?: string;
	lastActivityAt?: number;
}

export interface StandaloneSessionDependencies {
	fetchSessionList: () => Promise<StandaloneSessionSummary[]>;
	ensureSession: () => Promise<{ sid: string }>;
	connect: (sid: string) => void;
	setState: (state: Partial<ChatHostState>) => void;
}

/**
 * Populate the standalone Chat session state without owning first render.
 * A missing server is an empty/degraded Chat surface, not a blank application.
 */
export async function initializeStandaloneSessions(
	dependencies: StandaloneSessionDependencies,
): Promise<void> {
	try {
		let sessions = await dependencies.fetchSessionList();
		if (sessions.length === 0) {
			const ensured = await dependencies.ensureSession();
			sessions = [{ sid: ensured.sid }];
		}
		const activeSid = sessions[0]?.sid ?? null;
		dependencies.setState({
			tabs: sessions.map((session) => ({
				sid: session.sid,
				displayName: session.displayName,
				agentId: null,
				providerOverride: null,
				lastActivityAt: session.lastActivityAt,
			})),
			activeSid,
			currentSessionId: activeSid,
		});
		if (activeSid) dependencies.connect(activeSid);
	} catch {
		// Standalone remains rendered with its empty state while the server is down.
	}
}
