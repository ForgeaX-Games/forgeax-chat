import { afterEach, describe, expect, test } from "bun:test";
import {
	_permissionStreamInternals,
	clearPendingPermission,
	dropPermissionSession,
	getPendingPermission,
	getResolvedPermission,
	isAskUserToolName,
	recordResolvedPermission,
	replayPermissionEvents,
} from "./permission-stream";
import { deleteSession } from "./session-store";

const originalFetch = globalThis.fetch;
const touchedSids = new Set<string>();

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const sid of touchedSids) dropPermissionSession(sid);
	touchedSids.clear();
});

function request(sid: string, reqId: string): void {
	touchedSids.add(sid);
	replayPermissionEvents(sid, [
		{
			type: "permission:request",
			payload: {
				reqId,
				toolName: "AskUserQuestion",
				command: "",
				agent: "forge",
				input: { questions: [{ question: "Focus" }, { question: "Mode" }] },
			},
		},
	]);
}

describe("Chat permission stream", () => {
	test("recognizes canonical and namespaced AskUserQuestion tool names", () => {
		expect(isAskUserToolName("AskUserQuestion")).toBe(true);
		expect(isAskUserToolName("mcp__fxt__AskUserQuestion")).toBe(true);
		expect(isAskUserToolName("ask_user")).toBe(true);
		expect(isAskUserToolName("write_file")).toBe(false);
	});

	test("replays structured and legacy resolved answers through the same reducer", () => {
		const structuredSid = "permission-structured";
		const legacySid = "permission-legacy";
		request(structuredSid, "req-1");
		request(legacySid, "req-2");

		replayPermissionEvents(structuredSid, [
			{
				type: "permission:resolved",
				payload: {
					reqId: "req-1",
					toolName: "AskUserQuestion",
					answerValues: { Focus: ["Combat", "Puzzle"], Mode: ["Story"] },
				},
			},
		]);
		replayPermissionEvents(legacySid, [
			{
				type: "permission:resolved",
				payload: {
					reqId: "req-2",
					toolName: "ask_user",
					answers: { Focus: "Combat, Puzzle", Mode: "Story" },
				},
			},
		]);

		expect(getResolvedPermission(structuredSid)?.questions).toEqual([
			{ question: "Focus", values: ["Combat", "Puzzle"] },
			{ question: "Mode", values: ["Story"] },
		]);
		expect(getResolvedPermission(legacySid)?.questions).toEqual([
			{ question: "Focus", values: ["Combat", "Puzzle"] },
			{ question: "Mode", values: ["Story"] },
		]);
		expect(getPendingPermission(structuredSid)).toBeNull();
		expect(getPendingPermission(legacySid)).toBeNull();
	});

	test("a new request clears the previous resolved summary", () => {
		const sid = "permission-new-request";
		touchedSids.add(sid);
		recordResolvedPermission(sid, {
			reqId: "old",
			toolName: "AskUserQuestion",
			questions: [{ question: "Focus", values: ["Combat"] }],
		});

		request(sid, "new");

		expect(getResolvedPermission(sid)).toBeNull();
		expect(getPendingPermission(sid)?.reqId).toBe("new");
	});

	test("optimistic clear removes only the matching request and preserves a newer card", () => {
		const sid = "permission-optimistic-clear";
		request(sid, "current");

		clearPendingPermission(sid, "stale");
		expect(getPendingPermission(sid)?.reqId).toBe("current");

		clearPendingPermission(sid, "current");
		expect(getPendingPermission(sid)).toBeNull();
	});

	test("successful deletion clears pending and resolved state together", async () => {
		const sid = "permission-delete-success";
		request(sid, "req-delete");
		recordResolvedPermission(sid, {
			reqId: "resolved-too",
			toolName: "AskUserQuestion",
			questions: [{ question: "Focus", values: ["Combat"] }],
		});
		globalThis.fetch = (async () =>
			new Response(null, { status: 204 })) as typeof fetch;

		await deleteSession(sid);

		expect(getPendingPermission(sid)).toBeNull();
		expect(getResolvedPermission(sid)).toBeNull();
	});

	test("subscriber failures cannot reclassify a successful durable deletion", async () => {
		const sid = "permission-delete-listener-failure";
		request(sid, "req-delete");
		const originalWarn = console.warn;
		console.warn = () => undefined;
		const unsubscribe = _permissionStreamInternals.subscribe(() => {
			throw new Error("render listener failed");
		});
		globalThis.fetch = (async () =>
			new Response(null, { status: 204 })) as typeof fetch;

		try {
			await expect(deleteSession(sid)).resolves.toBeUndefined();
			expect(getPendingPermission(sid)).toBeNull();
		} finally {
			unsubscribe();
			console.warn = originalWarn;
		}
	});

	test("failed deletion preserves pending and resolved state", async () => {
		const sid = "permission-delete-failure";
		request(sid, "req-delete");
		recordResolvedPermission(sid, {
			reqId: "resolved-too",
			toolName: "AskUserQuestion",
			questions: [{ question: "Focus", values: ["Combat"] }],
		});
		globalThis.fetch = (async () =>
			new Response("still present", { status: 500 })) as typeof fetch;

		await expect(deleteSession(sid)).rejects.toThrow("still present");

		expect(getPendingPermission(sid)?.reqId).toBe("req-delete");
		expect(getResolvedPermission(sid)?.reqId).toBe("resolved-too");
	});
});

test("queues simultaneous approvals and prevents settled requests from replaying", () => {
	const sid = "queue-release-port";
	request(sid, "first");
	request(sid, "second");
	expect(getPendingPermission(sid)?.reqId).toBe("first");
	clearPendingPermission(sid, "first");
	expect(getPendingPermission(sid)?.reqId).toBe("second");
	request(sid, "first");
	clearPendingPermission(sid, "second");
	expect(getPendingPermission(sid)).toBeNull();
	dropPermissionSession(sid);
	request(sid, "first");
	expect(getPendingPermission(sid)?.reqId).toBe("first");
});
