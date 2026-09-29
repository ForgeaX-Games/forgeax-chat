import { describe, expect, it } from "bun:test";
import {
	advanceComposerTextBridgeRevision,
	type ComposerTextBridgeState,
	clearComposerTextRequest,
	enqueueComposerTextRequest,
} from "./composer-text-bridge";

const initialState = (): ComposerTextBridgeState => ({
	pendingText: null,
	textQueue: [],
	composerRevision: 0,
	lastRecommendationId: null,
	seenRecommendations: {},
});

describe("Chat-owned composer text bridge", () => {
	it("queues text requests in FIFO order and advances after consumption", () => {
		const first = enqueueComposerTextRequest(initialState(), {
			text: "A",
			mode: "append",
			recommendationId: "artifact:0",
		});
		const second = enqueueComposerTextRequest(first, {
			text: "B",
			mode: "replace",
		});

		expect(second.pendingText?.text).toBe("A");
		expect(clearComposerTextRequest(second).pendingText?.text).toBe("B");
	});

	it("deduplicates one recommendation revision but preserves A to B to A", () => {
		const request = (
			state: ComposerTextBridgeState,
			text: string,
			id: string,
		) =>
			enqueueComposerTextRequest(state, {
				text,
				mode: "append",
				recommendationId: id,
			});
		const consume = (state: ComposerTextBridgeState) =>
			clearComposerTextRequest(state);

		const first = request(initialState(), "A", "artifact:0");
		expect(request(first, "A", "artifact:0")).toBe(first);
		const second = request(consume(first), "B", "artifact:1");
		const third = request(consume(second), "A", "artifact:0");

		expect([
			first.pendingText?.text,
			second.pendingText?.text,
			third.pendingText?.text,
		]).toEqual(["A", "B", "A"]);
		expect(third.composerRevision).toBe(3);
	});

	it("starts a fresh recommendation revision after a manual edit boundary", () => {
		const first = enqueueComposerTextRequest(initialState(), {
			text: "A",
			mode: "append",
			recommendationId: "artifact:0",
		});
		const advanced = advanceComposerTextBridgeRevision(
			clearComposerTextRequest(first),
		);
		const repeated = enqueueComposerTextRequest(advanced, {
			text: "A",
			mode: "append",
			recommendationId: "artifact:0",
		});

		expect(repeated).not.toBe(advanced);
		expect(repeated.pendingText?.text).toBe("A");
		expect(repeated.composerRevision).toBe(3);
	});
});
