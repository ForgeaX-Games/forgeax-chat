import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import {
	appendComposerText,
	appendComposerTextOnce,
	type ChatHostState,
	checkModelReady,
	configureChatRuntime,
	resetActiveAgentModelToProviderDefault,
	useShellStore,
} from "./runtime";

function createHostStore(sid: string | null) {
	return createStore<ChatHostState>((set) => ({
		activeSid: sid,
		currentSessionId: sid,
		tabs: sid ? [{ sid }] : [],
		providerOverride: null,
		busyByAgentBySid: {},
		liveAgents: {},
		setTabAgent: (tabSid, agentId) =>
			set((state) => ({
				tabs: state.tabs.map((tab) =>
					tab.sid === tabSid ? { ...tab, agentId } : tab,
				),
			})),
		setProviderOverride: (providerOverride) => set({ providerOverride }),
		setAgentBusy: (tabSid, agentId, busy) =>
			set((state) => {
				const row = { ...(state.busyByAgentBySid[tabSid] ?? {}) };
				if (busy) row[agentId] = true;
				else delete row[agentId];
				return {
					busyByAgentBySid: { ...state.busyByAgentBySid, [tabSid]: row },
				};
			}),
		setLiveAgents: (tabSid, agents) =>
			set((state) => ({
				liveAgents: { ...state.liveAgents, [tabSid]: agents },
			})),
		renameTab: (tabSid, displayName) =>
			set((state) => ({
				tabs: state.tabs.map((tab) =>
					tab.sid === tabSid ? { ...tab, displayName } : tab,
				),
			})),
		setActiveEmitter: () => undefined,
		openOverlay: () => undefined,
		pushFileTouch: () => undefined,
		updateFileTouchStatus: () => undefined,
		initSessions: async () => undefined,
	}));
}

describe("Chat runtime public contract", () => {
	test("keeps repeated fallback busy writes referentially stable", () => {
		const before = useShellStore.getState();

		before.setAgentBusy("runtime-idempotent", "forge", false);
		expect(useShellStore.getState()).toBe(before);
		before.setAgentBusy("runtime-idempotent", "forge", true);
		const busy = useShellStore.getState();
		expect(busy).not.toBe(before);
		busy.setAgentBusy("runtime-idempotent", "forge", true);
		expect(useShellStore.getState()).toBe(busy);
		busy.setAgentBusy("runtime-idempotent", "forge", false);
	});

	test("publishes a product-injected runtime without an Interface dependency", async () => {
		const packageJson = await Bun.file(
			new URL("../package.json", import.meta.url),
		).json();
		const source = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();
		const forbiddenPackage = ["@forgeax", "interface"].join("/");

		expect(packageJson.exports["./runtime"]).toBe("./src/runtime.tsx");
		expect(source).toContain("export interface ChatRuntimeServices");
		expect(source).toContain("export function configureChatRuntime");
		expect(source).not.toContain(forbiddenPackage);
	});

	test("owns the pure composer text transitions instead of making the product inject them", async () => {
		const source = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();

		expect(source).not.toContain("appendComposerText: AnyFunction");
		expect(source).not.toContain("appendComposerTextOnce: AnyFunction");
		expect(source).not.toContain("appendComposerText: (current: string");
		expect(source).not.toContain("appendComposerTextOnce: (current: string");
		expect(source).not.toContain("useComposerPendingText: AnyFunction");
		expect(source).not.toContain("clearComposerPendingText: AnyFunction");
		expect(source).not.toContain("requestComposerText: AnyFunction");
		expect(source).not.toContain("advanceComposerTextRevision: AnyFunction");
		expect(source).toContain('from "./composer-text-bridge"');

		expect(appendComposerText("Existing draft", "  Try the next step  ")).toBe(
			"Existing draft\nTry the next step",
		);
		expect(appendComposerText("Existing draft", "  ")).toBe("Existing draft");
		expect(appendComposerTextOnce("Existing draft", "Try the next step")).toBe(
			"Existing draft\nTry the next step",
		);
		expect(
			appendComposerTextOnce(
				"Existing draft\nTry the next step",
				" Try the next step ",
			),
		).toBe("Existing draft\nTry the next step");
		expect(
			appendComposerTextOnce(
				"Existing\r\nTry the next step\n",
				"  Try the next step  ",
			),
		).toBe("Existing\r\nTry the next step\n");
		expect(
			appendComposerText(
				appendComposerText("Try the next step", "Run the test suite"),
				"Try the next step",
			),
		).toBe("Try the next step\nRun the test suite\nTry the next step");
	});

	test("owns the Chat turn trace lifecycle instead of making the product inject it", async () => {
		const source = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();

		expect(source).not.toContain("beginChatTurn: AnyFunction");
		expect(source).not.toContain("chatFirstToken: AnyFunction");
		expect(source).not.toContain("chatToolResult: AnyFunction");
		expect(source).not.toContain("chatTurnEnd: AnyFunction");
		expect(source).toContain("reportPassiveFeedbackRecovery: AnyFunction");
		expect(source).toContain('from "./chat-turn-trace"');
	});

	test("owns the permission stream instead of making the product inject it", async () => {
		const runtimeSource = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();
		const storeSource = await Bun.file(
			new URL("./session-store/store.ts", import.meta.url),
		).text();
		const sessionStoreSource = await Bun.file(
			new URL("./session-store/index.ts", import.meta.url),
		).text();
		const mainSource = await Bun.file(
			new URL("./main.tsx", import.meta.url),
		).text();

		for (const service of [
			"usePendingPermission",
			"useResolvedPermission",
			"recordResolvedPermission",
			"clearPendingPermission",
			"replayPermissionEvents",
			"subscribePermissionStream",
		]) {
			expect(runtimeSource).not.toContain(`${service}:`);
			expect(runtimeSource).not.toContain(`${service}: AnyFunction`);
			expect(runtimeSource).not.toContain(`${service}: () =>`);
			expect(runtimeSource).not.toContain(`runtime.${service}`);
		}
		expect(runtimeSource).toContain('from "./permission-stream"');
		expect(storeSource).toContain('from "../permission-stream"');
		expect(storeSource).not.toContain(
			"import { replayPermissionEvents } from '@forgeax/chat/runtime'",
		);
		expect(sessionStoreSource).toContain("dropPermissionSession(sid)");
		expect(mainSource).toContain("subscribePermissionStream();");
	});

	test("owns the model-label hook instead of making the product inject it", async () => {
		const runtimeSource = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();
		const composerSource = await Bun.file(
			new URL("./components/ChatPanel/Composer.tsx", import.meta.url),
		).text();
		const modelLabelSource = await Bun.file(
			new URL("./model-label.ts", import.meta.url),
		).text();

		expect(runtimeSource).not.toContain("useModelLabel: AnyFunction");
		expect(runtimeSource).not.toContain("useModelLabel: () => 'Model'");
		expect(runtimeSource).not.toContain("runtime.useModelLabel");
		expect(runtimeSource).toContain(
			'export { CURRENT_MODEL, useModelLabel } from "./model-label";',
		);
		expect(composerSource).toContain(
			'import { useModelLabel } from "../../model-label";',
		);
		expect(composerSource).not.toContain(
			"import { useModelLabel } from '@forgeax/chat/runtime';",
		);
		expect(modelLabelSource).toContain('label: "Claude Opus 4.7"');
		expect(modelLabelSource).toContain('fetch("/api/health")');
		expect(modelLabelSource).toContain("let cancelled = false;");
	});

	test("owns provider badges directly instead of making the product inject a component", async () => {
		const runtimeSource = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();
		const forgeCardSource = await Bun.file(
			new URL("./components/ChatPanel/ForgeCard.tsx", import.meta.url),
		).text();
		const subAgentCardSource = await Bun.file(
			new URL("./components/ChatPanel/SubAgentCard.tsx", import.meta.url),
		).text();
		const badgeSource = await Bun.file(
			new URL("./provider-badge.ts", import.meta.url),
		).text();

		expect(runtimeSource).not.toContain(
			"ProviderBadgePill: ComponentType<any>",
		);
		expect(runtimeSource).not.toContain("ProviderBadgePill:");
		expect(runtimeSource).not.toContain("runtime.ProviderBadgePill");
		expect(forgeCardSource).toContain('from "../../provider-badge"');
		expect(subAgentCardSource).toContain('from "../../provider-badge"');
		expect(badgeSource).toContain('listExtensions("cli-provider")');
		expect(badgeSource).toContain('t("providerBadge.clickToBusDetail"');
	});

	test("owns agent avatar glyph selection instead of making the product inject it", async () => {
		const runtimeSource = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();
		const switcherSource = await Bun.file(
			new URL("./components/ChatPanel/AgentSwitcher.tsx", import.meta.url),
		).text();

		expect(runtimeSource).not.toContain("resolveAvatarGlyphId: AnyFunction");
		expect(runtimeSource).not.toContain(
			"resolveAvatarGlyphId: (value: string) => value",
		);
		expect(runtimeSource).not.toContain("runtime.resolveAvatarGlyphId");
		expect(switcherSource).toContain('from "../../agent-avatar-glyph"');
		expect(switcherSource).not.toContain(
			"resolveAvatarGlyphId,\n} from '@forgeax/chat/runtime'",
		);
	});

	test("owns static agent avatar presentation and role accents instead of product injection", async () => {
		const runtimeSource = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();
		const avatarFile = Bun.file(
			new URL("./components/AgentAvatar/AgentAvatar.tsx", import.meta.url),
		);
		const avatarCssFile = Bun.file(
			new URL("./components/AgentAvatar/AgentAvatar.css", import.meta.url),
		);
		const switcherSource = await Bun.file(
			new URL("./components/ChatPanel/AgentSwitcher.tsx", import.meta.url),
		).text();
		const identitySource = await Bun.file(
			new URL("./components/ChatPanel/agent-identity.ts", import.meta.url),
		).text();

		expect(runtimeSource).not.toContain("AgentAvatar: ComponentType<any>");
		expect(runtimeSource).not.toContain("accentForRoleTribe: AnyFunction");
		expect(runtimeSource).not.toContain("runtime.AgentAvatar");
		expect(runtimeSource).not.toContain("runtime.accentForRoleTribe");
		expect(runtimeSource).not.toContain(
			'from "./components/AgentAvatar/AgentAvatar"',
		);
		expect(switcherSource).toContain('from "../AgentAvatar/AgentAvatar"');
		expect(identitySource).toContain('from "../AgentAvatar/AgentAvatar"');
		expect(switcherSource).not.toContain(
			"AgentAvatar,\n  accentForRoleTribe,\n} from '@forgeax/chat/runtime'",
		);
		expect(identitySource).not.toContain(
			"import { accentForRoleTribe } from '@forgeax/chat/runtime'",
		);
		expect(await avatarFile.exists()).toBeTrue();
		expect(await avatarCssFile.exists()).toBeTrue();

		const avatarSource = await avatarFile.text();
		const avatarCss = await avatarCssFile.text();
		const forbiddenPackage = ["@forgeax", "interface"].join("/");
		expect(avatarSource).not.toContain(forbiddenPackage);
		expect(avatarSource).toContain('import "./AgentAvatar.css"');
		expect(avatarCss).toContain(".agent-avatar.agent-avatar--art");
		expect(avatarCss).toContain(".as-avatar-btn.active .agent-avatar__frame");

		const { AgentAvatar, accentForRoleTribe } = await import(
			"./components/AgentAvatar/AgentAvatar"
		);
		const markup = renderToStaticMarkup(
			createElement(AgentAvatar, {
				agentId: "coding",
				accent: "var(--color-role-coding)",
				fallback: "CC",
				size: 26,
				glass: true,
			}),
		);
		expect(markup).toContain(
			'class="agent-avatar agent-avatar--art agent-avatar--glass"',
		);
		expect(markup).toContain('class="agent-avatar__frame"');
		expect(markup).toContain('class="agent-avatar__glyph"');
		expect(markup).toContain('width="23"');
		expect(markup).toContain('height="23"');
		expect(accentForRoleTribe("coding")).toBe("var(--color-role-coding)");
		expect(accentForRoleTribe("coder")).toBe("var(--color-role-coding)");
		expect(accentForRoleTribe("claude-code")).toBe("var(--color-role-coding)");
		expect(accentForRoleTribe("unknown")).toBe("var(--primary)");
	});

	test("owns ModelPicker presentation while the product injects only its catalog hook", async () => {
		const runtimeSource = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();
		const composerSource = await Bun.file(
			new URL("./components/ChatPanel/Composer.tsx", import.meta.url),
		).text();
		const pickerFile = Bun.file(
			new URL("./components/ModelPicker/ModelPicker.tsx", import.meta.url),
		);
		const pickerSource = (await pickerFile.exists())
			? await pickerFile.text()
			: "";
		const forbiddenPackage = ["@forgeax", "interface"].join("/");

		expect(runtimeSource).not.toContain(
			"ModelPicker: ComponentType<ModelPickerProps>",
		);
		expect(runtimeSource).not.toContain("ModelPicker: () => null");
		expect(runtimeSource).not.toContain("createElement(runtime.ModelPicker");
		expect(runtimeSource).toContain("useModelCatalog: UseModelCatalog;");
		expect(runtimeSource).toContain("useModelCatalog: () => null,");
		expect(runtimeSource).not.toContain("setModelHidden: (id: string");
		expect(composerSource).toContain('from "../ModelPicker/ModelPicker"');
		expect(composerSource).not.toContain(
			"import { ModelPicker } from '@forgeax/chat/runtime';",
		);
		expect(pickerSource).toContain('from "../../runtime"');
		expect(pickerSource).not.toContain(forbiddenPackage);
	});

	test("keeps model readiness as a boolean product-injection seam with a fail-open default", async () => {
		const source = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();

		expect(source).toContain("checkModelReady: () => Promise<boolean>;");
		expect(source).toContain("checkModelReady: async () => true,");
		expect(source).toMatch(
			/export const checkModelReady = \(\): Promise<boolean> =>\s*runtime\.checkModelReady\(\);/,
		);
		expect(source).not.toContain(
			"checkModelReady: async () => ({ ready: true })",
		);

		expect(await checkModelReady()).toBe(true);
		configureChatRuntime({ checkModelReady: async () => false });
		expect(await checkModelReady()).toBe(false);
		configureChatRuntime({ checkModelReady: async () => true });
		expect(await checkModelReady()).toBe(true);
	});

	test("owns active-agent provider-default resets instead of making the product inject them", async () => {
		const source = await Bun.file(
			new URL("./runtime.tsx", import.meta.url),
		).text();

		expect(source).not.toContain(
			"resetActiveAgentModelToProviderDefault: AnyFunction",
		);
		expect(source).not.toContain(
			"resetActiveAgentModelToProviderDefault: async () => undefined",
		);
		expect(source).not.toContain(
			"runtime.resetActiveAgentModelToProviderDefault",
		);
		expect(source).toContain(
			"export async function resetActiveAgentModelToProviderDefault(",
		);
	});

	test("migrates subscriptions created before the product store is configured", () => {
		const observedSids: string[][] = [];
		const unsubscribe = useShellStore.subscribe((state) => {
			observedSids.push(state.tabs.map((tab) => tab.sid));
		});
		const injectedStore = createHostStore("session-a");

		configureChatRuntime({ hostStore: injectedStore });
		injectedStore.setState({
			activeSid: "session-b",
			currentSessionId: "session-b",
			tabs: [{ sid: "session-b" }],
		});
		unsubscribe();
		configureChatRuntime({ hostStore: createHostStore(null) });

		expect(observedSids).toEqual([["session-a"], ["session-b"]]);
	});
});

describe("active-agent provider-default reset", () => {
	test("does not touch the catalog or model without an active session or selected agent", async () => {
		const calls: string[] = [];
		const services = {
			listModels: async () => {
				calls.push("list");
				return [{ id: "model-a" }];
			},
			setAgentModels: async () => {
				calls.push("set");
				return {};
			},
		};

		configureChatRuntime({ hostStore: createHostStore(null), ...services });
		expect(await resetActiveAgentModelToProviderDefault("codex")).toBeNull();
		configureChatRuntime({
			hostStore: createHostStore("session-a"),
			...services,
		});
		expect(await resetActiveAgentModelToProviderDefault("codex")).toBeNull();
		expect(calls).toEqual([]);
	});

	test("forwards the provider and selects the first visible catalog model", async () => {
		const store = createHostStore("session-a");
		store.getState().setTabAgent("session-a", "agents/forge.json");
		const calls: unknown[][] = [];
		configureChatRuntime({
			hostStore: store,
			listModels: async (providerId) => {
				calls.push(["list", providerId]);
				return [{ id: "hidden", hidden: true }, { id: "visible" }];
			},
			setAgentModels: async (...args) => {
				calls.push(["set", ...args]);
				return { selected: "service-selected" };
			},
		});

		expect(await resetActiveAgentModelToProviderDefault(null)).toEqual({
			sid: "session-a",
			agentPath: "agents/forge.json",
			selected: "service-selected",
		});
		expect(calls).toEqual([
			["list", null],
			["set", "session-a", "agents/forge.json", ["visible"]],
		]);
	});

	test("falls back to the first entry when all models are hidden and to the local id when set returns none", async () => {
		const store = createHostStore("session-a");
		store.getState().setTabAgent("session-a", "agents/forge.json");
		configureChatRuntime({
			hostStore: store,
			listModels: async () => [
				{ id: "first-hidden", hidden: true },
				{ id: "second-hidden", hidden: true },
			],
			setAgentModels: async () => ({}),
		});

		expect(await resetActiveAgentModelToProviderDefault("claude-code")).toEqual(
			{
				sid: "session-a",
				agentPath: "agents/forge.json",
				selected: "first-hidden",
			},
		);
	});

	test("does not write when the catalog is empty", async () => {
		const store = createHostStore("session-a");
		store.getState().setTabAgent("session-a", "agents/forge.json");
		let writes = 0;
		configureChatRuntime({
			hostStore: store,
			listModels: async () => [],
			setAgentModels: async () => {
				writes += 1;
				return {};
			},
		});

		expect(await resetActiveAgentModelToProviderDefault("codex")).toBeNull();
		expect(writes).toBe(0);
	});

	test("does not rewrite a previously active agent after the selected thread changes", async () => {
		const store = createHostStore("session-a");
		store.getState().setTabAgent("session-a", "agents/a.json");
		let resolveCatalog!: (catalog: Array<{ id: string }>) => void;
		const catalog = new Promise<Array<{ id: string }>>((resolve) => {
			resolveCatalog = resolve;
		});
		const writes: unknown[][] = [];
		configureChatRuntime({
			hostStore: store,
			listModels: async () => catalog,
			setAgentModels: async (...args) => {
				writes.push(args);
				return {};
			},
		});

		const reset = resetActiveAgentModelToProviderDefault("codex");
		store.setState({
			activeSid: "session-b",
			currentSessionId: "session-b",
			tabs: [
				{
					sid: "session-b",
					displayName: undefined,
					agentId: "agents/b.json",
					providerOverride: null,
				},
			],
		});
		resolveCatalog([{ id: "model-a" }]);

		expect(await reset).toBeNull();
		expect(writes).toEqual([]);
	});

	test("propagates catalog and model-write failures to the Composer catch boundary", async () => {
		const store = createHostStore("session-a");
		store.getState().setTabAgent("session-a", "agents/forge.json");
		configureChatRuntime({
			hostStore: store,
			listModels: async () => {
				throw new Error("catalog failed");
			},
		});
		await expect(
			resetActiveAgentModelToProviderDefault("codex"),
		).rejects.toThrow("catalog failed");

		configureChatRuntime({
			listModels: async () => [{ id: "model-a" }],
			setAgentModels: async () => {
				throw new Error("write failed");
			},
		});
		await expect(
			resetActiveAgentModelToProviderDefault("codex"),
		).rejects.toThrow("write failed");
	});
});
