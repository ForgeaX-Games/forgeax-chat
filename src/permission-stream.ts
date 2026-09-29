/** Chat-owned command-permission request and resolution stream. */

import { useSyncExternalStore } from "react";
import { onSessionEvent, type SessionEvent } from "./session-bridge";

export interface PendingPermission {
	reqId: string;
	toolName: string;
	command: string;
	agent: string;
	input?: unknown;
	capability?: string;
	canRemember?: boolean;
	reason?: string;
}

export interface ResolvedPermission {
	sid: string;
	reqId: string;
	toolName: string;
	questions: Array<{ question: string; values: string[] }>;
}

const pendingBySid = new Map<string, Map<string, PendingPermission>>();
const settledBySid = new Map<string, Set<string>>();
const resolvedBySid = new Map<string, ResolvedPermission>();
const listeners = new Set<() => void>();

export function isAskUserToolName(toolName: string): boolean {
	const bare = toolName.replace(/^(mcp__fxt__|fxt__)/, "");
	return bare === "AskUserQuestion" || bare === "ask_user";
}

function notify(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch (error) {
			console.warn("[permission-stream] listener threw", error);
		}
	}
}

function questionList(input: unknown): Array<{ question: string }> {
	if (!input || typeof input !== "object") return [];
	const questions = (input as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) return [];
	return questions.flatMap((question): Array<{ question: string }> => {
		if (!question || typeof question !== "object") return [];
		const text = (question as { question?: unknown }).question;
		return typeof text === "string" && text ? [{ question: text }] : [];
	});
}

function stringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
			typeof item === "string" ? [[key, item] as const] : [],
		),
	);
}

function valuesRecord(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
			if (!Array.isArray(item)) return [];
			const values = item.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.trim().length > 0,
			);
			return values.length ? [[key, values] as const] : [];
		}),
	);
}

function resolvedFrom(
	sid: string,
	reqId: string,
	toolName: string,
	input: unknown,
	answers: unknown,
	answerValues: unknown,
): ResolvedPermission | null {
	if (!isAskUserToolName(toolName)) return null;
	const questions = questionList(input);
	const structured = valuesRecord(answerValues);
	const legacy = stringRecord(answers);
	const rows = questions.map(({ question }) => {
		const values =
			structured[question] ??
			(legacy[question]
				? legacy[question]
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean)
				: []);
		return { question, values };
	});
	return rows.some((row) => row.values.length > 0)
		? { sid, reqId, toolName, questions: rows }
		: null;
}

function dispatchPermission(evt: SessionEvent): void {
	const type = evt.event.type;
	if (type !== "permission:request" && type !== "permission:resolved") return;
	const sid = evt.sid;
	const payload = (evt.event.payload ?? {}) as Partial<PendingPermission> & {
		reqId?: string;
		answers?: unknown;
		answerValues?: unknown;
	};
	if (typeof payload.reqId !== "string") return;

	if (type === "permission:request") {
		if (settledBySid.get(sid)?.has(payload.reqId)) return;
		const queue = pendingBySid.get(sid) ?? new Map<string, PendingPermission>();
		resolvedBySid.delete(sid);
		queue.set(payload.reqId, {
			reqId: payload.reqId,
			toolName:
				typeof payload.toolName === "string" ? payload.toolName : "tool",
			command: typeof payload.command === "string" ? payload.command : "",
			agent: typeof payload.agent === "string" ? payload.agent : "forge",
			input: payload.input,
			...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
			...(typeof payload.capability === "string"
				? { capability: payload.capability }
				: {}),
			...(payload.canRemember === true ? { canRemember: true } : {}),
		});
		pendingBySid.set(sid, queue);
	} else {
		const current = pendingBySid.get(sid)?.get(payload.reqId);
		const resolved = resolvedFrom(
			sid,
			payload.reqId,
			typeof payload.toolName === "string"
				? payload.toolName
				: (current?.toolName ?? ""),
			payload.input ?? current?.input,
			payload.answers,
			payload.answerValues,
		);
		if (resolved) resolvedBySid.set(sid, resolved);
		settlePermission(sid, payload.reqId);
	}
	notify();
}

/** Attach the reducer before connecting the session socket. Registration is
 * keyed and therefore idempotent across product boot and HMR. */
export function subscribePermissionStream(): void {
	onSessionEvent("permission", dispatchPermission);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Narrow test seam for lifecycle failure-isolation contracts. Product code
 * uses the hooks and stream subscription above. */
export const _permissionStreamInternals = { subscribe };

export function usePendingPermission(
	sid: string | null,
): PendingPermission | null {
	return useSyncExternalStore(
		subscribe,
		() => (sid ? getPendingPermission(sid) : null),
		() => null,
	);
}

export function useResolvedPermission(
	sid: string | null,
): ResolvedPermission | null {
	return useSyncExternalStore(
		subscribe,
		() => (sid ? (resolvedBySid.get(sid) ?? null) : null),
		() => null,
	);
}

export function getPendingPermission(sid: string): PendingPermission | null {
	return pendingBySid.get(sid)?.values().next().value ?? null;
}

export function getResolvedPermission(sid: string): ResolvedPermission | null {
	return resolvedBySid.get(sid) ?? null;
}

export function recordResolvedPermission(
	sid: string,
	resolved: Omit<ResolvedPermission, "sid">,
): void {
	resolvedBySid.set(sid, { sid, ...resolved });
	notify();
}

export function replayPermissionEvents(
	sid: string,
	events: Array<{
		type?: string;
		source?: string;
		ts?: number;
		payload?: unknown;
	}>,
): void {
	for (const event of events) {
		if (
			event.type !== "permission:request" &&
			event.type !== "permission:resolved"
		)
			continue;
		const payload =
			event.payload && typeof event.payload === "object"
				? (event.payload as Record<string, unknown>)
				: {};
		dispatchPermission({
			type: "session-event",
			sid,
			event: {
				source: event.source ?? "replay",
				type: event.type,
				payload,
				ts: event.ts ?? 0,
			},
		});
	}
}

export function usePendingPermissionCount(sid: string | null): number {
	return useSyncExternalStore(
		subscribe,
		() => (sid ? (pendingBySid.get(sid)?.size ?? 0) : 0),
		() => 0,
	);
}
function settlePermission(sid: string, reqId: string): void {
	const settled = settledBySid.get(sid) ?? new Set<string>();
	settled.add(reqId);
	settledBySid.set(sid, settled);
	const queue = pendingBySid.get(sid);
	queue?.delete(reqId);
	if (queue?.size === 0) pendingBySid.delete(sid);
}
export function clearPendingPermission(sid: string, reqId: string): void {
	settlePermission(sid, reqId);
	notify();
}

/** Evict both maps after successful durable session deletion. Delete both
 * independently: short-circuiting would retain a resolved answer whenever a
 * pending request also exists. */
export function dropPermissionSession(sid: string): void {
	settledBySid.delete(sid);
	const removedPending = pendingBySid.delete(sid);
	const removedResolved = resolvedBySid.delete(sid);
	if (removedPending || removedResolved) notify();
}
