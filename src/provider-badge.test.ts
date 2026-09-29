import { afterEach, describe, expect, mock, test } from "bun:test";
import { configureChatRuntime, getLocale } from "./runtime";
import { translateStandaloneMessage } from "./standalone-messages";

let importGeneration = 0;

function importFreshProviderBadge() {
	importGeneration += 1;
	return import(`./provider-badge.ts?test=${importGeneration}`);
}

afterEach(() => {
	configureChatRuntime({
		listExtensions: async () => ({ items: [] }),
		t: (key, vars) => translateStandaloneMessage(getLocale(), key, vars),
	});
});

describe("Chat-owned provider badge", () => {
	test("keeps the provider dictionary and neutral unknown fallback", async () => {
		const { providerBadgeFor } = await importFreshProviderBadge();

		expect(providerBadgeFor("forgeax")).toEqual({
			label: "forgeax",
			color: "#9ec5d4",
			title: "ForgeaX CLI provider",
		});
		expect(providerBadgeFor("claude-code")).toEqual({
			label: "claude-code",
			color: "#cfa3ff",
			title: "Anthropic claude-code CLI provider",
		});
		expect(providerBadgeFor("codex")).toEqual({
			label: "codex",
			color: "#7be7c4",
			title: "OpenAI Codex CLI provider",
		});
		expect(providerBadgeFor("kimi-code")).toEqual({
			label: "kimi-code",
			color: "#58d8b5",
			title: "Kimi Code CLI provider",
		});
		expect(providerBadgeFor("deepseek-harness")).toEqual({
			label: "DeepSeek Harness",
			color: "#4fb6a6",
			title: "DeepSeek Harness CLI provider",
		});
		expect(providerBadgeFor("future-provider")).toEqual({
			label: "future-provider",
			color: "#888",
			title: "CLI provider: future-provider (no UI badge style registered yet)",
		});
		expect(
			translateStandaloneMessage("en", "providerBadge.clickToBusDetail", {
				title: "OpenAI Codex CLI provider",
			}),
		).toBe("OpenAI Codex CLI provider · click to view in Bus details →");
		expect(
			translateStandaloneMessage("zh", "providerBadge.clickToBusDetail", {
				title: "OpenAI Codex CLI provider",
			}),
		).toBe("OpenAI Codex CLI provider · 单击在 Bus 详情查看 →");
	});

	test("loads the cli-provider registry once per module and caches canonical ids", async () => {
		const listExtensions = mock(async () => ({
			items: [
				{ id: "@forgeax-plugin/cli-claude-code" },
				{ id: "@forgeax-plugin/cli-codex" },
				{ id: "@forgeax-plugin/cli-" },
				{ id: "@forgeax-extension/not-a-cli-provider" },
			],
		}));
		configureChatRuntime({ listExtensions });
		const { loadCliProviderExtensionMap } = await importFreshProviderBadge();

		const [first, second] = await Promise.all([
			loadCliProviderExtensionMap(),
			loadCliProviderExtensionMap(),
		]);
		const third = await loadCliProviderExtensionMap();

		expect(listExtensions).toHaveBeenCalledTimes(1);
		expect(listExtensions).toHaveBeenCalledWith("cli-provider");
		expect(first).toBe(second);
		expect(second).toBe(third);
		expect([...first]).toEqual([
			["claude-code", "@forgeax-plugin/cli-claude-code"],
			["codex", "@forgeax-plugin/cli-codex"],
		]);
	});

	test("turns one failed registry load into a cached empty noninteractive map", async () => {
		const listExtensions = mock(async () => {
			throw new Error("registry unavailable");
		});
		configureChatRuntime({ listExtensions });
		const { loadCliProviderExtensionMap } = await importFreshProviderBadge();

		expect([...(await loadCliProviderExtensionMap())]).toEqual([]);
		expect([...(await loadCliProviderExtensionMap())]).toEqual([]);
		expect(listExtensions).toHaveBeenCalledTimes(1);
	});

	test("isolates a synchronous registry seam failure", async () => {
		const listExtensions = mock(() => {
			throw new Error("registration failed");
		});
		configureChatRuntime({ listExtensions });
		const { loadCliProviderExtensionMap } = await importFreshProviderBadge();

		expect([...(await loadCliProviderExtensionMap())]).toEqual([]);
		expect(listExtensions).toHaveBeenCalledTimes(1);
	});

	test("fences a retained registry load after one hook instance is disposed", async () => {
		let resolveList!: (value: { items: Array<{ id: string }> }) => void;
		configureChatRuntime({
			listExtensions: () =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
		});
		const {
			installCliProviderExtensionMapUpdate,
			loadCliProviderExtensionMap,
		} = await importFreshProviderBadge();
		const updates: Array<Map<string, string>> = [];

		const dispose = installCliProviderExtensionMapUpdate((map) =>
			updates.push(map),
		);
		dispose();
		await Promise.resolve();
		resolveList({ items: [{ id: "@forgeax-plugin/cli-codex" }] });
		await loadCliProviderExtensionMap();
		await Promise.resolve();

		expect(updates).toEqual([]);
	});

	test("renders unavailable providers as spans and preserves interactive mouse and keyboard semantics", async () => {
		const translate = mock(
			(key: string, vars?: Record<string, unknown>) => `${key}:${vars?.title}`,
		);
		configureChatRuntime({ t: translate });
		const { renderProviderBadgePill } = await importFreshProviderBadge();
		const onBusDeepLink = mock((_extensionId: string) => undefined);

		const unavailable = renderProviderBadgePill({
			providerId: "codex",
			className: "kc-provider",
			extensionId: null,
			onBusDeepLink,
		});
		expect(unavailable.type).toBe("span");
		expect(unavailable.props.className).toBe("kc-provider");
		expect(unavailable.props.role).toBeUndefined();
		expect(unavailable.props.tabIndex).toBeUndefined();
		expect(unavailable.props.onClick).toBeUndefined();
		expect(unavailable.props.onKeyDown).toBeUndefined();
		expect(unavailable.props.title).toBe("OpenAI Codex CLI provider");
		expect(unavailable.props.children).toBe("codex");

		const available = renderProviderBadgePill({
			providerId: "codex",
			className: "kc-provider",
			extensionId: "@forgeax-plugin/cli-codex",
			onBusDeepLink,
		});
		expect(available.type).toBe("span");
		expect(available.props.className).toBe("kc-provider is-link");
		expect(available.props.role).toBe("button");
		expect(available.props.tabIndex).toBe(0);
		expect(available.props.title).toBe(
			"providerBadge.clickToBusDetail:OpenAI Codex CLI provider",
		);
		expect(translate).toHaveBeenCalledWith("providerBadge.clickToBusDetail", {
			title: "OpenAI Codex CLI provider",
		});

		const event = {
			key: "",
			stopPropagation: mock(() => undefined),
			preventDefault: mock(() => undefined),
		};
		available.props.onClick(event);
		expect(event.stopPropagation).toHaveBeenCalledTimes(1);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(onBusDeepLink).toHaveBeenLastCalledWith("@forgeax-plugin/cli-codex");

		available.props.onKeyDown({ ...event, key: "Escape" });
		expect(onBusDeepLink).toHaveBeenCalledTimes(1);
		available.props.onKeyDown({ ...event, key: "Enter" });
		available.props.onKeyDown({ ...event, key: " " });
		expect(onBusDeepLink).toHaveBeenCalledTimes(3);
		expect(event.stopPropagation).toHaveBeenCalledTimes(3);
		expect(event.preventDefault).toHaveBeenCalledTimes(3);
		expect(available.props.children[1].props.className).toBe(
			"provider-badge-arrow",
		);
		expect(available.props.children[1].props["aria-hidden"]).toBe(true);
		expect(available.props.children[1].props.children).toBe("→");
	});
});
