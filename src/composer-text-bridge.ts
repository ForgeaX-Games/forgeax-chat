import { create } from "zustand";

export type ComposerTextMode = "append" | "replace";

export interface ComposerTextRequest {
	text: string;
	mode: ComposerTextMode;
	/** Stable identity of a recommendation action. */
	recommendationId?: string;
	/** Assigned by the bridge for telemetry and deterministic ordering. */
	composerRevision?: number;
}

export interface ComposerTextBridgeState {
	pendingText: ComposerTextRequest | null;
	textQueue: ComposerTextRequest[];
	composerRevision: number;
	lastRecommendationId: string | null;
	seenRecommendations: Record<string, number>;
}

interface ComposerTextBridgeStore extends ComposerTextBridgeState {
	request: (request: ComposerTextRequest) => void;
	clear: () => void;
	advanceRevision: () => void;
}

/** Queue a request while keeping repeated recommendation clicks idempotent. */
export function enqueueComposerTextRequest(
	state: ComposerTextBridgeState,
	request: ComposerTextRequest,
): ComposerTextBridgeState {
	let revision = state.composerRevision;
	let seen = state.seenRecommendations;
	if (request.mode === "append" && request.recommendationId) {
		if (
			state.lastRecommendationId === request.recommendationId &&
			seen[request.recommendationId] === revision
		)
			return state;
		if (state.lastRecommendationId !== request.recommendationId) {
			revision += 1;
			seen = {};
		}
		seen = { ...seen, [request.recommendationId]: revision };
	}
	const next = { ...request, composerRevision: revision };
	return {
		textQueue: [...state.textQueue, next],
		pendingText: state.textQueue.length === 0 ? next : state.pendingText,
		composerRevision: revision,
		lastRecommendationId:
			request.recommendationId ?? state.lastRecommendationId,
		seenRecommendations: seen,
	};
}

export function clearComposerTextRequest(
	state: ComposerTextBridgeState,
): ComposerTextBridgeState {
	const textQueue = state.textQueue.slice(1);
	return { ...state, textQueue, pendingText: textQueue[0] ?? null };
}

export function advanceComposerTextBridgeRevision(
	state: ComposerTextBridgeState,
): ComposerTextBridgeState {
	return {
		...state,
		composerRevision: state.composerRevision + 1,
		lastRecommendationId: null,
		seenRecommendations: {},
	};
}

const useComposerTextBridge = create<ComposerTextBridgeStore>((set) => ({
	pendingText: null,
	textQueue: [],
	composerRevision: 0,
	lastRecommendationId: null,
	seenRecommendations: {},
	request: (request) =>
		set((state) => enqueueComposerTextRequest(state, request)),
	clear: () => set((state) => clearComposerTextRequest(state)),
	advanceRevision: () =>
		set((state) => advanceComposerTextBridgeRevision(state)),
}));

/** Publish plain text into the Chat composer. */
export function requestComposerText(
	text: string,
	mode: ComposerTextMode = "append",
	recommendationId?: string,
): void {
	if (!text) return;
	useComposerTextBridge.getState().request({ text, mode, recommendationId });
}

/** React hook for the next pending plain-text request. */
export function useComposerPendingText(): ComposerTextRequest | null {
	return useComposerTextBridge((state) => state.pendingText);
}

/** Drop the consumed request and advance the FIFO queue. */
export function clearComposerPendingText(): void {
	useComposerTextBridge.getState().clear();
}

/** Mark a manual edit, send, or clear boundary in the recommendation stream. */
export function advanceComposerTextRevision(): void {
	useComposerTextBridge.getState().advanceRevision();
}
