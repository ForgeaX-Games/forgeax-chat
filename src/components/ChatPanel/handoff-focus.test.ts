import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../session-bridge";
import type { LiveAgentRootShape } from "./handoff-focus";
import {
	agentIdFromRef,
	askUserCallIdFromPayload,
	askUserToolNameFromPayload,
	focusAgentIdFromAskUser,
	focusAgentIdFromHandoff,
	parkedAgentIdFromInterAgentHandoff,
	parkedSubAgentId,
	pickLiveRootAgentId,
	rememberLastSubAgent,
	resolveSessionRootAgentId,
	subscribeToParkedHandoff,
} from "./handoff-focus";

describe("session root identity", () => {
	test("prefers the active session tree over the product catalog main agent", () => {
		expect(resolveSessionRootAgentId("codex-default", "forge")).toBe(
			"codex-default",
		);
	});

	test("falls back to the product catalog before the session tree arrives", () => {
		expect(resolveSessionRootAgentId(null, "forge")).toBe("forge");
	});
});

describe("live root selection", () => {
	const row = (
		path: string,
		depth: number,
		parent: string | null,
	): LiveAgentRootShape => ({ path, depth, parent });

	test("picks the root-shaped row, by depth or by a null parent", () => {
		expect(
			pickLiveRootAgentId([
				row("codex-default", 1, null),
				row("codex-default/gen3d", 2, "codex-default"),
			]),
		).toBe("codex-default");
		// parent === null is the second root shape: depth can arrive as 0 for a
		// top-level CLI persona, so neither test alone is sufficient.
		expect(
			pickLiveRootAgentId([
				row("forge/gen3d", 2, "forge"),
				row("forge", 0, null),
			]),
		).toBe("forge");
	});

	test("a child-only tree has no root — never promote an arbitrary child", () => {
		// Sub-agent rows can arrive before their parent, or a session can be
		// filtered down to a teammate. Naming gen3d the session root would flip
		// inSubAgentView on the real main thread and send 返回主对话 to a teammate.
		const childrenOnly = [
			row("forge/gen3d", 2, "forge"),
			row("forge/sino", 3, "forge/gen3d"),
		];
		expect(pickLiveRootAgentId(childrenOnly)).toBeNull();
		expect(
			resolveSessionRootAgentId(pickLiveRootAgentId(childrenOnly), "forge"),
		).toBe("forge");
	});

	test("an empty live list falls through to the catalog main agent", () => {
		expect(pickLiveRootAgentId([])).toBeNull();
		expect(resolveSessionRootAgentId(pickLiveRootAgentId([]), "forge")).toBe(
			"forge",
		);
	});

	test("no live root and no catalog main agent stays null rather than guessing", () => {
		expect(
			resolveSessionRootAgentId(
				pickLiveRootAgentId([row("forge/gen3d", 2, "forge")]),
				null,
			),
		).toBeNull();
	});
});

describe("handoff focus", () => {
	test("strips path and instance suffix", () => {
		expect(agentIdFromRef("gen3d")).toBe("gen3d");
		expect(agentIdFromRef("forge/gen3d")).toBe("gen3d");
		expect(agentIdFromRef("gen3d#1")).toBe("gen3d");
	});

	test("identifies the teammate after a real handoff", () => {
		expect(focusAgentIdFromHandoff("forge", "gen3d")).toBe("gen3d");
		expect(focusAgentIdFromHandoff("forge", "forge/sino")).toBe("sino");
	});

	test("ignores self-handoff and empty refs", () => {
		expect(focusAgentIdFromHandoff("gen3d", "gen3d")).toBeNull();
		expect(focusAgentIdFromHandoff("forge/gen3d", "gen3d#1")).toBeNull();
		expect(focusAgentIdFromHandoff("", "gen3d")).toBeNull();
		expect(focusAgentIdFromHandoff("forge", "")).toBeNull();
	});
});

describe("inter-agent dispatch navigation", () => {
	const forgeToGen3d = {
		emitterId: "forge",
		event: {
			source: "agent",
			type: "user_input",
			payload: {},
			to: "forge/gen3d",
			ts: 1,
		},
	};

	test("parks the dispatched teammate instead of selecting its thread", () => {
		// The event resolves only to a parked target. There is deliberately no
		// "activate" result: the visible Forge tab changes only through the
		// explicit return/open controls.
		expect(parkedAgentIdFromInterAgentHandoff(forgeToGen3d)).toBe("gen3d");
	});

	test("does not treat user traffic or narrative nudges as a dispatch", () => {
		expect(
			parkedAgentIdFromInterAgentHandoff({
				...forgeToGen3d,
				event: { ...forgeToGen3d.event, source: "user" },
			}),
		).toBeNull();
		expect(
			parkedAgentIdFromInterAgentHandoff({
				...forgeToGen3d,
				event: { ...forgeToGen3d.event, payload: { narrativeAutoNudge: true } },
			}),
		).toBeNull();
	});

	test("registers the real session key and parks only the dispatched teammate", () => {
		const parked: string[] = [];
		let key = "";
		let handler: ((message: SessionEvent) => void) | undefined;
		const unsubscribe = subscribeToParkedHandoff(
			(registeredKey, registeredHandler) => {
				key = registeredKey;
				handler = registeredHandler;
				return () => {
					parked.push("unsubscribed");
				};
			},
			"s1",
			(agentId) => parked.push(agentId),
		);

		expect(key).toBe("chat-agent-thread-park");
		handler?.({ type: "session-event", sid: "s1", ...forgeToGen3d });
		handler?.({ type: "session-event", sid: "other-session", ...forgeToGen3d });
		expect(parked).toEqual(["gen3d"]);
		unsubscribe();
		expect(parked).toEqual(["gen3d", "unsubscribed"]);
	});
});

describe("parked sub-agent return", () => {
	test("parks gen3d from a handoff even if the visible tab stays on forge", () => {
		const afterHandoff = rememberLastSubAgent({}, "s1", "gen3d", "forge");
		expect(afterHandoff).toEqual({ s1: "gen3d" });
		expect(rememberLastSubAgent(afterHandoff, "s1", "forge", "forge")).toEqual(
			afterHandoff,
		);
		expect(parkedSubAgentId("s1", "forge", "forge", afterHandoff)).toBe(
			"gen3d",
		);
	});

	test("hides the return shortcut while already on the sub-agent", () => {
		const parked = { s1: "gen3d" };
		expect(parkedSubAgentId("s1", "gen3d", "forge", parked)).toBeNull();
	});

	test("updates when the user visits a different sub-agent", () => {
		const afterSino = rememberLastSubAgent(
			{ s1: "gen3d" },
			"s1",
			"sino",
			"forge",
		);
		expect(afterSino).toEqual({ s1: "sino" });
	});
});

describe("ask_user focus", () => {
	test("reads nested hook:toolCall name and id", () => {
		expect(
			askUserToolNameFromPayload({
				toolCall: { id: "ask-1", name: "ask_user" },
			}),
		).toBe("ask_user");
		expect(
			askUserCallIdFromPayload({ toolCall: { id: "ask-1", name: "ask_user" } }),
		).toBe("ask-1");
		expect(askUserCallIdFromPayload({ toolUseId: "cli-1" })).toBe("cli-1");
	});

	test("pulls focus for a teammate native ask_user", () => {
		expect(
			focusAgentIdFromAskUser({
				emitterId: "forge/gen3d",
				rootAgentId: "forge",
				eventType: "hook:toolCall",
				toolName: "ask_user",
			}),
		).toBe("gen3d");
		expect(
			focusAgentIdFromAskUser({
				emitterId: "gen3d#1",
				rootAgentId: "forge",
				eventType: "stream:tool_use",
				toolName: "AskUserQuestion",
			}),
		).toBe("gen3d");
	});

	test("stays put on dispatch, root asks, and CLI permission overlays", () => {
		expect(
			focusAgentIdFromAskUser({
				emitterId: "forge",
				rootAgentId: "forge",
				eventType: "user_input",
				toolName: "ask_user",
			}),
		).toBeNull();
		expect(
			focusAgentIdFromAskUser({
				emitterId: "forge",
				rootAgentId: "forge",
				eventType: "hook:toolCall",
				toolName: "ask_user",
			}),
		).toBeNull();
		expect(
			focusAgentIdFromAskUser({
				emitterId: "gen3d",
				rootAgentId: "forge",
				eventType: "hook:toolCall",
				toolName: "ask_user",
				permissionPrompt: true,
			}),
		).toBeNull();
		expect(
			focusAgentIdFromAskUser({
				emitterId: "gen3d",
				rootAgentId: "forge",
				eventType: "hook:toolCall",
				toolName: "todo_write",
			}),
		).toBeNull();
	});
});
