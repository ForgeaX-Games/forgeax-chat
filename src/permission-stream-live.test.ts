import { describe, expect, test } from "bun:test";
import {
	dropPermissionSession,
	getPendingPermission,
	getResolvedPermission,
	subscribePermissionStream,
} from "./permission-stream";
import { _sessionBridgeInternals } from "./session-bridge";

describe("live Chat permission stream", () => {
	test("registers the exact channel and reduces request/resolved socket frames", () => {
		const sid = "permission-live";
		subscribePermissionStream();

		expect(_sessionBridgeInternals.hasSessionEventHandler("permission")).toBe(
			true,
		);
		_sessionBridgeInternals.routeFrame({
			type: "session-event",
			sid,
			event: {
				source: "server",
				type: "permission:request",
				payload: {
					reqId: "live-1",
					toolName: "AskUserQuestion",
					command: "",
					agent: "forge",
					input: { questions: [{ question: "Mode" }] },
				},
				ts: 1,
			},
		});
		expect(getPendingPermission(sid)?.reqId).toBe("live-1");

		_sessionBridgeInternals.routeFrame({
			type: "session-event",
			sid,
			event: {
				source: "server",
				type: "permission:resolved",
				payload: {
					reqId: "live-1",
					toolName: "AskUserQuestion",
					answerValues: { Mode: ["Story"] },
				},
				ts: 2,
			},
		});
		expect(getPendingPermission(sid)).toBeNull();
		expect(getResolvedPermission(sid)?.questions).toEqual([
			{ question: "Mode", values: ["Story"] },
		]);
		dropPermissionSession(sid);
	});
});
