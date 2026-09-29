import type { ArtifactSummary } from "@forgeax/types/artifact-summary";
import {
	Component,
	createElement,
	type ErrorInfo,
	Fragment,
	type ReactNode,
	useSyncExternalStore,
} from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
	type ChatTelemetryRecord,
	createChatTurnTraceLifecycle,
} from "./chat-turn-trace";
import {
	advanceComposerTextRevision,
	clearComposerPendingText,
	requestComposerText,
	useComposerPendingText,
} from "./composer-text-bridge";
import { translateStandaloneMessage } from "./standalone-messages";

export { CURRENT_MODEL, useModelLabel } from "./model-label";
export type {
	PendingPermission,
	ResolvedPermission,
} from "./permission-stream";
export {
	clearPendingPermission,
	isAskUserToolName,
	recordResolvedPermission,
	replayPermissionEvents,
	subscribePermissionStream,
	usePendingPermission,
	usePendingPermissionCount,
	useResolvedPermission,
} from "./permission-stream";

export interface ToolCall {
	callId: string;
	name: string;
	args: unknown;
	status: "running" | "done" | "error";
	permissionPrompt?: boolean;
	result?: string;
	resultData?: unknown;
	fullResultContent?: string;
	error?: string;
	at?: number;
	subagentId?: string;
}

export interface SubAgentRun {
	emitterId: string;
	text: string;
	thinking?: string;
	toolCalls: ToolCall[];
	status: "streaming" | "done" | "error";
	startedAt: number;
	providerId?: string;
}

export type ChatSegment =
	| { kind: "text"; ts: number; text: string }
	| {
			kind: "thinking";
			ts: number;
			text: string;
			visibility?: "public_summary" | "private_reasoning";
	  }
	| { kind: "tool"; ts: number; tool: ToolCall };

export type SystemLevel = "info" | "warning" | "error";
export type SystemDirection = "incoming" | "outgoing";

export interface ChatAttachment {
	kind: "image" | "document" | "file" | string;
	name?: string;
	mediaType?: string;
	data?: string;
	path?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	msgId?: string;
	turnId?: string;
	text: string;
	attachments?: ChatAttachment[];
	thinking?: string;
	toolCalls: ToolCall[];
	level?: SystemLevel;
	direction?: SystemDirection;
	source?: string;
	from?: string;
	to?: string;
	segments?: ChatSegment[];
	subAgents?: Record<string, SubAgentRun>;
	status: "streaming" | "done" | "error";
	ts: number;
	errorMessage?: string;
	providerId?: string;
	cost?: number;
	durationMs?: number;
	turnAborted?: boolean;
	artifact?: ArtifactSummary;
	artifactAnchorSeq?: number;
}

export interface ChatTab {
	sid: string;
	displayName: string | undefined;
	agentId: string | null;
	providerOverride: string | null;
	initialModelSeedAgentId?: string;
	lastActivityAt?: number;
}

export interface LiveAgent {
	path: string;
	display: string;
	parent: string | null;
	running: boolean;
	depth: number;
}

export interface AgentFileTouch {
	callId: string;
	path: string;
	name: string;
	op: string;
	ts: number;
	status: "running" | "done" | "error";
}

export interface ChatHostState {
	activeSid: string | null;
	currentSessionId?: string | null;
	tabs: ChatTab[];
	providerOverride: string | null;
	busyByAgentBySid: Record<string, Record<string, boolean>>;
	liveAgents: Record<string, LiveAgent[]>;
	setTabAgent(sid: string, agentId: string | null): void;
	setProviderOverride(providerId: string | null): void;
	setAgentBusy(sid: string, agentId: string, busy: boolean): void;
	setLiveAgents(sid: string, agents: LiveAgent[]): void;
	renameTab(sid: string, displayName: string): void;
	setActiveEmitter(agentId: string | null): void;
	openOverlay(name: string, section?: string): void;
	pushFileTouch(sid: string, agentId: string, touch: AgentFileTouch): void;
	updateFileTouchStatus(
		sid: string,
		agentId: string,
		callId: string,
		status: AgentFileTouch["status"],
	): void;
	initSessions(): Promise<void>;
	[key: string]: unknown;
}

type HostStore = Pick<
	StoreApi<ChatHostState>,
	"getState" | "setState" | "subscribe"
>;

const fallbackHostStore = createStore<ChatHostState>((set) => ({
	activeSid: null,
	currentSessionId: null,
	tabs: [],
	providerOverride: null,
	busyByAgentBySid: {},
	liveAgents: {},
	setTabAgent: (sid, agentId) =>
		set((state) => ({
			tabs: state.tabs.map((tab) =>
				tab.sid === sid ? { ...tab, agentId } : tab,
			),
		})),
	setProviderOverride: (providerOverride) => set({ providerOverride }),
	setAgentBusy: (sid, agentId, busy) =>
		set((state) => {
			const current = Boolean(state.busyByAgentBySid[sid]?.[agentId]);
			if (current === busy) return state;
			const row = { ...(state.busyByAgentBySid[sid] ?? {}) };
			if (busy) row[agentId] = true;
			else delete row[agentId];
			return { busyByAgentBySid: { ...state.busyByAgentBySid, [sid]: row } };
		}),
	setLiveAgents: (sid, agents) =>
		set((state) => ({ liveAgents: { ...state.liveAgents, [sid]: agents } })),
	renameTab: (sid, displayName) =>
		set((state) => ({
			tabs: state.tabs.map((tab) =>
				tab.sid === sid ? { ...tab, displayName } : tab,
			),
		})),
	setActiveEmitter: () => undefined,
	openOverlay: () => undefined,
	pushFileTouch: () => undefined,
	updateFileTouchStatus: () => undefined,
	initSessions: async () => undefined,
}));

let hostStoreDelegate: HostStore = fallbackHostStore;
let detachHostStore: (() => void) | null = null;
const hostStoreListeners = new Set<() => void>();
type HostStoreListener = Parameters<HostStore["subscribe"]>[0];
interface HostStoreSubscription {
	active: boolean;
	generation: number;
	listener: HostStoreListener;
	detach: (() => void) | null;
}
const hostStoreSubscriptions = new Set<HostStoreSubscription>();

function notifyHostStore(): void {
	for (const listener of hostStoreListeners) listener();
}

function detachSubscription(subscription: HostStoreSubscription): void {
	subscription.generation += 1;
	const detach = subscription.detach;
	subscription.detach = null;
	try {
		detach?.();
	} catch {
		// A broken host cleanup must not prevent the replacement store from attaching.
	}
}

function attachSubscription(subscription: HostStoreSubscription): void {
	const store = hostStoreDelegate;
	const generation = subscription.generation;
	try {
		subscription.detach = store.subscribe((state, previousState) => {
			if (
				!subscription.active ||
				subscription.generation !== generation ||
				hostStoreDelegate !== store
			)
				return;
			subscription.listener(state, previousState);
		});
	} catch {
		subscription.detach = null;
	}
}

function subscribeHostStore(listener: HostStoreListener): () => void {
	const subscription: HostStoreSubscription = {
		active: true,
		generation: 0,
		listener,
		detach: null,
	};
	hostStoreSubscriptions.add(subscription);
	attachSubscription(subscription);
	return () => {
		if (!subscription.active) return;
		subscription.active = false;
		detachSubscription(subscription);
		hostStoreSubscriptions.delete(subscription);
	};
}

function installHostStore(store: HostStore): void {
	const previousState = hostStoreDelegate.getState();
	try {
		detachHostStore?.();
	} catch {
		// React-hook listeners are reattached below even if the old host cleanup fails.
	}
	hostStoreDelegate = store;
	try {
		detachHostStore = store.subscribe(notifyHostStore);
	} catch {
		detachHostStore = null;
	}
	const nextState = store.getState();
	for (const subscription of hostStoreSubscriptions) {
		detachSubscription(subscription);
		attachSubscription(subscription);
		try {
			subscription.listener(nextState, previousState);
		} catch {
			// One module-scope subscriber must not prevent the remaining subscribers from migrating.
		}
	}
	notifyHostStore();
}

export interface ChatHostStoreHook {
	<T>(selector: (state: ChatHostState) => T): T;
	getState(): ChatHostState;
	setState: HostStore["setState"];
	subscribe: HostStore["subscribe"];
}

export const useShellStore: ChatHostStoreHook = Object.assign(
	function useChatHostStore<T>(selector: (state: ChatHostState) => T): T {
		return useSyncExternalStore(
			(listener) => {
				hostStoreListeners.add(listener);
				return () => {
					hostStoreListeners.delete(listener);
				};
			},
			() => selector(hostStoreDelegate.getState()),
			() => selector(hostStoreDelegate.getState()),
		);
	},
	{
		getState: () => hostStoreDelegate.getState(),
		setState: ((...args: Parameters<HostStore["setState"]>) =>
			hostStoreDelegate.setState(...args)) as HostStore["setState"],
		subscribe: subscribeHostStore,
	},
);

export interface ChatHostSnapshot<T> {
	subscribe(listener: () => void): () => void;
	getSnapshot(): T;
}

export interface ChatAppHost {
	commands: { execute<R = unknown>(id: string, args?: unknown): Promise<R> };
	activities: ChatHostSnapshot<{ generation: number; [key: string]: unknown }>;
	pages: ChatHostSnapshot<{
		activeKey?: string | null;
		instances: Array<{ encodedKey: string; typeId: string }>;
		[key: string]: unknown;
	}>;
	pageRegistry: { ownerOf(typeId: string): string | undefined };
	[key: string]: unknown;
}

const noSubscribe = () => () => undefined;
const defaultActivitiesSnapshot = { generation: 0 };
const defaultPagesSnapshot = {
	activeKey: null as string | null,
	instances: [] as Array<{ encodedKey: string; typeId: string }>,
};
const defaultHost: ChatAppHost = {
	commands: { execute: async () => undefined as never },
	activities: {
		subscribe: noSubscribe,
		getSnapshot: () => defaultActivitiesSnapshot,
	},
	pages: { subscribe: noSubscribe, getSnapshot: () => defaultPagesSnapshot },
	pageRegistry: { ownerOf: () => undefined },
};

export type Locale = "en" | "zh";

export interface FileDiffStat {
	path: string;
	status: "added" | "deleted" | "modified";
	insertions: number;
	deletions: number;
	binary: boolean;
}

export interface RewindPreview {
	filesChanged: string[];
	insertions: number;
	deletions: number;
	binaryOrLarge: number;
	files?: FileDiffStat[];
}

export interface AgentModelState {
	sid: string;
	agentPath: string;
	selected: string | null;
	chain: string[];
	raw: string | string[] | null;
}

export interface ModelCatalogEntry {
	id: string;
	input?: string[];
	reasoning?: boolean;
	contextWindow?: number;
	maxOutput?: number;
	defaultTemperature?: number;
	spec?: unknown;
	source?: "disk" | "live" | "driver";
	live?: boolean;
	driverId?: string;
	driverLabel?: string;
	costMetering?: "none" | "gateway";
	hidden?: boolean;
	[key: string]: unknown;
}

export interface CatalogDriverMeta {
	id: string;
	source: "env" | "kernel" | "last-known" | "static" | "none" | string;
	error?: string;
	ids: number;
	cached?: boolean;
}

export interface ModelCatalogState {
	models: ModelCatalogEntry[] | null;
	driver: CatalogDriverMeta | null;
	error: string | null;
	refresh: () => Promise<void>;
}

export type UseModelCatalog = (
	providerId?: string | null,
) => ModelCatalogState | null;

export interface CliProviderInfo {
	id: string;
	displayName: string;
	health: { ok: boolean; detail?: string };
}

export interface ExtensionInfo {
	id: string;
	name?: string;
	description?: unknown;
	preferredAgent?: string;
	[key: string]: unknown;
}

export type PillKind =
	| "file"
	| "dir"
	| "agent"
	| "tool"
	| "game"
	| "log"
	| "entity"
	| "paste"
	| "skill"
	| "command";
export interface PillPayload {
	kind: PillKind;
	display: string;
	icon?: string;
	detail: string;
	tooltip: { title: string; lines: string[] };
}
export type TextSegment =
	| { kind: "text"; text: string }
	| { kind: "pill"; token: string; payload: PillPayload };

type AnyFunction = (...args: any[]) => any;

export interface ChatRuntimeServices {
	hostStore: HostStore;
	useHost: () => ChatAppHost;
	t: (key: string, vars?: Record<string, unknown>) => string;
	useTranslation: () => {
		t: ChatRuntimeServices["t"];
		i18n: { language: string };
	};
	getLocale: () => Locale;
	setLocale: (locale: Locale) => void;
	subscribeLocale: (listener: () => void) => () => void;
	listExtensions: (...args: any[]) => Promise<{ items: ExtensionInfo[] }>;
	openExtensionPage: AnyFunction;
	emitDeepLink: AnyFunction;
	useBusSnapshot: AnyFunction;
	publish: AnyFunction;
	reportPassiveFeedbackSignal: AnyFunction;
	reportPassiveFeedbackRecovery: AnyFunction;
	subscribeBroadcast: AnyFunction;
	pushTelemetry: (records: ChatTelemetryRecord[]) => void;
	fetchCheckpoints: AnyFunction;
	rewindPreview: (sid: string, msgId: string) => Promise<RewindPreview>;
	rewindTo: AnyFunction;
	rewindCancel: AnyFunction;
	rewindOverwriteDirty: AnyFunction;
	rewindUndoOverwrite: AnyFunction;
	getAgentModel: (sid: string, agentPath: string) => Promise<AgentModelState>;
	listModels: (...args: any[]) => Promise<ModelCatalogEntry[]>;
	setAgentModels: AnyFunction;
	checkModelReady: () => Promise<boolean>;
	initialSessionCatalogModel: AnyFunction;
	preferredCatalogModel: AnyFunction;
	fetchCliProviders: (
		...args: any[]
	) => Promise<{ providers: CliProviderInfo[] }>;
	useModelCatalog: UseModelCatalog;
	agentIcon: string;
	alertDialog: AnyFunction;
	loadOnboarding: AnyFunction;
	saveOnboarding: AnyFunction;
	appEvents: {
		openConnectPrompt: string;
		resumeSend: string;
		onboardingChanged: string;
	};
	useComposerPendingInsert: AnyFunction;
	clearComposerPendingInsert: AnyFunction;
	requestComposerInsert: AnyFunction;
}

let currentLocale: Locale = "en";
const localeListeners = new Set<() => void>();
const storageKey = "forgeax.lastModel.byProvider.v1";

function standaloneTranslate(
	key: string,
	vars?: Record<string, unknown>,
): string {
	return translateStandaloneMessage(currentLocale, key, vars);
}

interface CommandResponse<T> {
	result?: { ok: boolean; data?: T; error?: string };
}

async function callCommand<T>(
	name: string,
	mode: "query" | "execute",
	args: string[],
): Promise<T> {
	const response = await fetch(`/api/commands/${name}/${mode}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ args }),
	});
	const payload = (await response.json()) as CommandResponse<T>;
	if (!payload.result?.ok) {
		throw new Error(
			payload.result?.error ?? `${name} failed (HTTP ${response.status})`,
		);
	}
	return payload.result.data as T;
}

function defaultGetAgentModel(
	sid: string,
	agentPath: string,
): Promise<AgentModelState> {
	return callCommand("get_agent_model", "query", [sid, agentPath]);
}

async function defaultListModels(
	providerId?: string | null,
): Promise<ModelCatalogEntry[]> {
	const data = await callCommand<{ models?: ModelCatalogEntry[] }>(
		"list_models",
		"query",
		providerId ? [providerId] : [],
	);
	return data.models ?? [];
}

function defaultSetAgentModels(
	sid: string,
	agentPath: string,
	models: string[],
): Promise<{ selected: string; chain: string[]; restarted: boolean }> {
	if (models.length === 0)
		throw new Error("setAgentModels: at least one model required");
	return callCommand("set_agent_models", "execute", [
		sid,
		agentPath,
		...models,
	]);
}

function providerKey(providerId: string | null): string {
	return providerId && providerId !== "forgeax" ? providerId : "forgeax";
}

function readModelPrefs(): Record<string, string> {
	try {
		const raw = localStorage.getItem(storageKey);
		const parsed = raw ? (JSON.parse(raw) as unknown) : null;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, string>)
			: {};
	} catch {
		return {};
	}
}

const runtime: ChatRuntimeServices = {
	hostStore: fallbackHostStore,
	useHost: () => defaultHost,
	t: standaloneTranslate,
	useTranslation: () => ({
		t: runtime.t,
		i18n: { language: runtime.getLocale() },
	}),
	getLocale: () => currentLocale,
	setLocale: (locale) => {
		currentLocale = locale;
		for (const listener of localeListeners) listener();
	},
	subscribeLocale: (listener) => {
		localeListeners.add(listener);
		return () => {
			localeListeners.delete(listener);
		};
	},
	listExtensions: async () => ({ items: [] }),
	openExtensionPage: async () => undefined,
	emitDeepLink: () => undefined,
	useBusSnapshot: () => null,
	publish: () => undefined,
	reportPassiveFeedbackSignal: () => undefined,
	reportPassiveFeedbackRecovery: () => undefined,
	subscribeBroadcast: () => () => undefined,
	pushTelemetry: () => undefined,
	fetchCheckpoints: async () => ({ checkpoints: [], pending: null }),
	rewindPreview: async () => ({
		filesChanged: [],
		insertions: 0,
		deletions: 0,
		binaryOrLarge: 0,
	}),
	rewindTo: async () => ({ boundaryId: "", filesChanged: [], keptDirty: [] }),
	rewindCancel: async () => ({ keptDirty: [] }),
	rewindOverwriteDirty: async () => ({ files: [] }),
	rewindUndoOverwrite: async () => ({ files: [] }),
	getAgentModel: defaultGetAgentModel,
	listModels: defaultListModels,
	setAgentModels: defaultSetAgentModels,
	checkModelReady: async () => true,
	initialSessionCatalogModel: () => undefined,
	preferredCatalogModel: () => undefined,
	fetchCliProviders: async () => ({ providers: [] }),
	useModelCatalog: () => null,
	agentIcon:
		"data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Ccircle cx=%2232%22 cy=%2232%22 r=%2230%22 fill=%22%238b5cf6%22/%3E%3Cpath d=%22M18 40c6-16 22-16 28 0%22 fill=%22none%22 stroke=%22white%22 stroke-width=%226%22 stroke-linecap=%22round%22/%3E%3Ccircle cx=%2224%22 cy=%2226%22 r=%224%22 fill=%22white%22/%3E%3Ccircle cx=%2240%22 cy=%2226%22 r=%224%22 fill=%22white%22/%3E%3C/svg%3E",
	alertDialog: async (message: string) => globalThis.confirm?.(message) ?? true,
	loadOnboarding: () => ({
		v: 2,
		phase: "done",
		done: { tour: true, firstChat: true },
	}),
	saveOnboarding: () => undefined,
	appEvents: {
		openConnectPrompt: "forgeax:open-connect-prompt",
		resumeSend: "forgeax:resume-send",
		onboardingChanged: "forgeax:onboarding-changed",
	},
	useComposerPendingInsert: () => null,
	clearComposerPendingInsert: () => undefined,
	requestComposerInsert: () => undefined,
};

const chatTurnTrace = createChatTurnTraceLifecycle({
	pushTelemetry: (records) => runtime.pushTelemetry(records),
	reportPassiveFeedbackSignal: (signal) =>
		runtime.reportPassiveFeedbackSignal(signal),
	reportPassiveFeedbackRecovery: (resolution) =>
		runtime.reportPassiveFeedbackRecovery(resolution),
});

export function configureChatRuntime(
	services: Partial<ChatRuntimeServices>,
): void {
	Object.assign(runtime, services);
	if (services.hostStore) installHostStore(services.hostStore);
}

export function useHost(): ChatAppHost {
	return runtime.useHost();
}
export function t(key: string, vars?: Record<string, unknown>): string {
	return runtime.t(key, vars);
}
export function useTranslation(): ReturnType<
	ChatRuntimeServices["useTranslation"]
> {
	return runtime.useTranslation();
}
export function getLocale(): Locale {
	return runtime.getLocale();
}
export function setLocale(locale: Locale): void {
	runtime.setLocale(locale);
}
export function subscribe(listener: () => void): () => void {
	return runtime.subscribeLocale(listener);
}
export function initI18n(): void {
	try {
		const stored = globalThis.localStorage?.getItem("forgeax.locale");
		if (stored === "en" || stored === "zh") runtime.setLocale(stored);
	} catch {
		// Storage is optional in private or non-browser environments.
	}
}

export const listExtensions = (...args: any[]) =>
	runtime.listExtensions(...args);
export const openExtensionPage = (...args: any[]) =>
	runtime.openExtensionPage(...args);
export const emitDeepLink = (...args: any[]) => runtime.emitDeepLink(...args);
export const useBusSnapshot = (...args: any[]) =>
	runtime.useBusSnapshot(...args);
export const publish = (...args: any[]) => runtime.publish(...args);
export const reportPassiveFeedbackSignal = (...args: any[]) =>
	runtime.reportPassiveFeedbackSignal(...args);
export const reportPassiveFeedbackRecovery = (...args: any[]) =>
	runtime.reportPassiveFeedbackRecovery(...args);
export const subscribeBroadcast = (...args: any[]) =>
	runtime.subscribeBroadcast(...args);
export const beginChatTurn = chatTurnTrace.beginChatTurn;
export const chatFirstToken = chatTurnTrace.chatFirstToken;
export const chatToolResult = chatTurnTrace.chatToolResult;
export const chatTurnEnd = chatTurnTrace.chatTurnEnd;
export const fetchCheckpoints = (...args: any[]) =>
	runtime.fetchCheckpoints(...args);
export const rewindPreview = (sid: string, msgId: string) =>
	runtime.rewindPreview(sid, msgId);
export const rewindTo = (...args: any[]) => runtime.rewindTo(...args);
export const rewindCancel = (...args: any[]) => runtime.rewindCancel(...args);
export const rewindOverwriteDirty = (...args: any[]) =>
	runtime.rewindOverwriteDirty(...args);
export const rewindUndoOverwrite = (...args: any[]) =>
	runtime.rewindUndoOverwrite(...args);
export const getAgentModel = (sid: string, agentPath: string) =>
	runtime.getAgentModel(sid, agentPath);
export const listModels = (...args: any[]) => runtime.listModels(...args);
export const setAgentModels = (...args: any[]) =>
	runtime.setAgentModels(...args);
export const useModelCatalog = (
	providerId?: string | null,
): ModelCatalogState | null => runtime.useModelCatalog(providerId);
export const setModelHidden = (
	id: string,
	hidden: boolean,
): Promise<{ id: string; hidden: boolean; totalHidden: number }> =>
	callCommand("set_model_hidden", "execute", [id, hidden ? "1" : "0"]);
export const checkModelReady = (): Promise<boolean> =>
	runtime.checkModelReady();
export const initialSessionCatalogModel = (...args: any[]) =>
	runtime.initialSessionCatalogModel(...args);
export const preferredCatalogModel = (...args: any[]) =>
	runtime.preferredCatalogModel(...args);
export async function resetActiveAgentModelToProviderDefault(
	catalogProviderId: string | null,
): Promise<{ sid: string; agentPath: string; selected: string } | null> {
	const state = useShellStore.getState();
	const sid = state.activeSid;
	const agentPath = sid
		? (state.tabs.find((tab) => tab.sid === sid)?.agentId ?? null)
		: null;
	if (!sid || !agentPath) return null;

	const catalog = await listModels(catalogProviderId);
	const remembered = getLastModel(catalogProviderId);
	const nextModel =
		catalog.find((model) => model.id === remembered && !model.hidden)?.id ??
		catalog.find((model) => !model.hidden)?.id ??
		catalog[0]?.id;
	if (!nextModel) return null;

	const current = useShellStore.getState();
	if (
		current.activeSid !== sid ||
		current.tabs.find((tab) => tab.sid === sid)?.agentId !== agentPath ||
		current.providerOverride !== state.providerOverride
	)
		return null;
	const result = await setAgentModels(sid, agentPath, [nextModel]);
	return { sid, agentPath, selected: result.selected ?? nextModel };
}
export const fetchCliProviders = (...args: any[]) =>
	runtime.fetchCliProviders(...args);
export const alertDialog = (...args: any[]) => runtime.alertDialog(...args);
export const loadOnboarding = (...args: any[]) =>
	runtime.loadOnboarding(...args);
export const saveOnboarding = (...args: any[]) =>
	runtime.saveOnboarding(...args);
export const useComposerPendingInsert = (...args: any[]) =>
	runtime.useComposerPendingInsert(...args);
export const clearComposerPendingInsert = (...args: any[]) =>
	runtime.clearComposerPendingInsert(...args);
export const requestComposerInsert = (...args: any[]) =>
	runtime.requestComposerInsert(...args);
export {
	advanceComposerTextRevision,
	clearComposerPendingText,
	requestComposerText,
	useComposerPendingText,
};

/** Append one normalized recommendation line without inspecting old draft text.
 * The shared pending-text bridge owns recommendation idempotency; this pure
 * Chat transition owns how accepted text is composed into the current draft.
 */
export function appendComposerText(current: string, addition: string): string {
	const normalized = addition.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return current;
	return `${current}${current ? "\n" : ""}${normalized}`;
}

/** Append a suggestion only when the current draft does not already contain
 * the same normalized line or block.
 */
export function appendComposerTextOnce(
	current: string,
	addition: string,
): string {
	const normalizedAddition = addition.replace(/\r\n?/g, "\n").trim();
	if (!normalizedAddition) return current;

	const normalizedCurrent = current.replace(/\r\n?/g, "\n");
	const comparableCurrent = normalizedCurrent.trim();
	const hasSameLine = normalizedCurrent
		.split("\n")
		.some((line) => line.trim() === normalizedAddition);
	const hasSameBlock =
		comparableCurrent === normalizedAddition ||
		comparableCurrent.startsWith(`${normalizedAddition}\n`) ||
		comparableCurrent.endsWith(`\n${normalizedAddition}`) ||
		comparableCurrent.includes(`\n${normalizedAddition}\n`);

	if (hasSameLine || hasSameBlock) return current;
	return `${current}${current ? "\n" : ""}${addition}`;
}

export const APP_EVENTS = {
	get openConnectPrompt(): string {
		return runtime.appEvents.openConnectPrompt;
	},
	get resumeSend(): string {
		return runtime.appEvents.resumeSend;
	},
	get onboardingChanged(): string {
		return runtime.appEvents.onboardingChanged;
	},
};

export function getAgentIcon(): string {
	return runtime.agentIcon;
}

export function pickLang(
	value: unknown,
	locale: "zh" | "en" = "zh",
	fallback = "",
): string {
	if (!value) return fallback;
	if (typeof value === "string") return value;
	if (typeof value !== "object" || Array.isArray(value)) return fallback;
	const record = value as Record<string, unknown>;
	const candidate = record[locale] ?? record.zh ?? record.en;
	return typeof candidate === "string" ? candidate : fallback;
}

export function getLastModel(providerId: string | null): string | null {
	const value = readModelPrefs()[providerKey(providerId)];
	return typeof value === "string" && value ? value : null;
}

export function recordLastModel(
	providerId: string | null,
	modelId: string,
): void {
	if (!modelId) return;
	try {
		const prefs = readModelPrefs();
		prefs[providerKey(providerId)] = modelId;
		localStorage.setItem(storageKey, JSON.stringify(prefs));
	} catch {
		// Storage is optional in private or non-browser environments.
	}
}

export function resolveReplyLanguage(_text: string): Locale {
	return getLocale();
}

export interface SseFrame {
	event: string;
	data: string;
}
export async function* parseSse(
	stream: ReadableStream<Uint8Array>,
): AsyncIterable<SseFrame> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "";
	let data = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line === "") {
					if (event || data) yield { event, data };
					event = "";
					data = "";
				} else if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:"))
					data += `${data ? "\n" : ""}${line.slice(5).trim()}`;
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* already released */
		}
	}
}

const pillPattern = /⟦pill:([A-Za-z0-9_-]+=*)⟧/g;
function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}
export function decodePill(token: string): PillPayload | null {
	const match = token.match(/^⟦pill:([A-Za-z0-9_-]+=*)⟧$/);
	if (!match) return null;
	try {
		const normalized = match[1].replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(
			normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
		);
		const bytes = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0),
		);
		const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		if (!value || typeof value !== "object") return null;
		const payload = value as Partial<PillPayload>;
		return payload.kind && payload.detail ? (payload as PillPayload) : null;
	} catch {
		return null;
	}
}
export function encodePill(payload: PillPayload): string {
	return `⟦pill:${encodeBase64Url(JSON.stringify(payload))}⟧`;
}
export function parseSegments(text: string): TextSegment[] {
	const output: TextSegment[] = [];
	let cursor = 0;
	for (const match of text.matchAll(pillPattern)) {
		const index = match.index ?? 0;
		if (index > cursor)
			output.push({ kind: "text", text: text.slice(cursor, index) });
		const payload = decodePill(match[0]);
		output.push(
			payload
				? { kind: "pill", token: match[0], payload }
				: { kind: "text", text: match[0] },
		);
		cursor = index + match[0].length;
	}
	if (cursor < text.length)
		output.push({ kind: "text", text: text.slice(cursor) });
	return output;
}
export function expandPills(text: string): string {
	return text.replace(
		pillPattern,
		(token) => decodePill(token)?.detail ?? token,
	);
}
export function expandPillsForDisplay(text: string): string {
	return text.replace(pillPattern, (token) => {
		const payload = decodePill(token);
		return payload && payload.kind !== "skill" && payload.kind !== "command"
			? payload.detail
			: token;
	});
}
export function buildSlashPill(input: {
	trigger: string;
	source: "skill" | "command";
	displayName?: string;
	description?: string;
}): PillPayload {
	const trigger = input.trigger.startsWith("/")
		? input.trigger
		: `/${input.trigger}`;
	const kind: PillKind = input.source === "skill" ? "skill" : "command";
	const title = input.displayName?.trim() || trigger;
	const description = input.description?.trim();
	return {
		kind,
		display: trigger,
		detail: trigger,
		tooltip: {
			title: kind === "skill" ? `✦ ${title}` : trigger,
			lines: [description, kind === "skill" ? "Skill" : "Command"].filter(
				Boolean,
			) as string[],
		},
	};
}
export function buildAssetPill(input: {
	guid: string;
	name?: string;
	assetKind?: string;
	packPath?: string;
	payload?: Record<string, unknown>;
}): PillPayload {
	const name = input.name ?? input.guid.slice(0, 8);
	const isFolderSummary = input.assetKind === "folder" && input.payload;
	let detail: string;
	if (isFolderSummary) {
		const summary = input.payload as {
			totalAssets?: number;
			kinds?: Record<string, number>;
		};
		const kindList = summary.kinds
			? Object.entries(summary.kinds)
					.map(([kind, count]) => `${kind} × ${count}`)
					.join(", ")
			: "";
		detail = `[${t("reference.asset")}: folder="${name}" path=${input.packPath ?? ""} totalAssets=${summary.totalAssets ?? 0} kinds=(${kindList})]`;
	} else if (input.payload) {
		const payloadText = JSON.stringify(input.payload, null, 2);
		const truncated =
			payloadText.length > 2000
				? `${payloadText.slice(0, 2000)}\n…(truncated)`
				: payloadText;
		detail = `[${t("reference.asset")}: guid=${input.guid} kind=${input.assetKind ?? ""}${input.packPath ? ` pack=${input.packPath}` : ""}\npayload:\n${truncated}]`;
	} else {
		detail = `[${t("reference.asset")}: guid=${input.guid} kind=${input.assetKind ?? ""}${input.packPath ? ` pack=${input.packPath}` : ""}]`;
	}
	return {
		kind: "entity",
		display: name,
		icon: isFolderSummary ? "📁" : "🧱",
		detail,
		tooltip: {
			title: `${isFolderSummary ? "📁" : "🧱"} ${t("reference.asset")} · ${name}`,
			lines: [
				`guid: ${input.guid}`,
				input.assetKind ? `kind: ${input.assetKind}` : "",
				input.packPath ? `pack: ${input.packPath}` : "",
			].filter(Boolean),
		},
	};
}
export function parseDisplaySegments(text: string): TextSegment[] {
	const segments = parseSegments(text);
	if (segments.length === 0) return segments;
	const first = segments[0];
	if (first?.kind !== "text") return segments;
	const match = first.text.match(/^(\/[a-z][a-z0-9_-]*)([\s\S]*)$/i);
	if (!match) return segments;
	const output: TextSegment[] = [
		{
			kind: "pill",
			token: "",
			payload: buildSlashPill({ trigger: match[1], source: "command" }),
		},
	];
	if (match[2]) output.push({ kind: "text", text: match[2] });
	if (segments.length > 1) output.push(...segments.slice(1));
	return output;
}

const fileFamilies: Record<string, string> = {
	ts: "code",
	tsx: "code",
	js: "code",
	jsx: "code",
	mjs: "code",
	cjs: "code",
	json: "config",
	json5: "config",
	jsonc: "config",
	lock: "config",
	yaml: "config",
	yml: "config",
	toml: "config",
	ini: "config",
	env: "config",
	md: "doc",
	markdown: "doc",
	txt: "doc",
	rst: "doc",
	adoc: "doc",
	scene: "scene",
	fxscene: "scene",
	pack: "pack",
	fxpack: "pack",
	zip: "pack",
	tar: "pack",
	gz: "pack",
	meta: "meta",
	png: "image",
	jpg: "image",
	jpeg: "image",
	webp: "image",
	gif: "image",
	svg: "image",
	ico: "image",
	avif: "image",
	mp3: "audio",
	wav: "audio",
	ogg: "audio",
	flac: "audio",
	m4a: "audio",
	aac: "audio",
	glb: "model",
	gltf: "model",
	fbx: "model",
	obj: "model",
	dae: "model",
	blend: "model",
	"3ds": "model",
	csv: "data",
	tsv: "data",
	xml: "data",
	bin: "data",
	dat: "data",
	db: "data",
	sqlite: "data",
	sqlite3: "data",
};
export function familyOf(path: string): string {
	const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
	const extension = name.includes(".")
		? (name.split(".").pop()?.toLowerCase() ?? "")
		: "";
	return fileFamilies[extension] ?? "data";
}

export class ErrorBoundary extends Component<
	{ scope?: string; children: ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null };
	static getDerivedStateFromError(error: Error): { error: Error } {
		return { error };
	}
	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error(`[chat:${this.props.scope ?? "surface"}]`, error, info);
	}
	render(): ReactNode {
		return this.state.error
			? createElement("div", { role: "alert" }, this.state.error.message)
			: this.props.children;
	}
}

export function BrandProvider({
	children,
}: {
	children: ReactNode;
}): ReactNode {
	return createElement(Fragment, null, children);
}
