import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { configureChatRuntime, type ModelCatalogEntry } from "../../runtime";
import {
	filterAndGroupModelCatalog,
	ModelPicker,
	nextModelPickerFocus,
} from "./ModelPicker";

describe("Chat-owned ModelPicker", () => {
	test("retains selection writes, failure closure, visibility refresh, and Radix portal ownership", async () => {
		const pickerSource = await Bun.file(
			new URL("./ModelPicker.tsx", import.meta.url),
		).text();
		const popoverSource = await Bun.file(
			new URL("./popover.tsx", import.meta.url),
		).text();

		expect(pickerSource).toMatch(
			/await setAgentModels\(\s*writeToAgent\.sid,\s*writeToAgent\.agentPath,\s*\[modelId\],\s*\)/,
		);
		expect(pickerSource).toContain(
			"(props as SingleProps).onChange(result.selected ?? modelId);",
		);
		expect(pickerSource).toContain(
			"`[model-picker] set_agent_models failed: ${message}`",
		);
		expect(pickerSource).toContain("setOpen(false);");
		expect(pickerSource).toContain(
			"await setModelHidden(model.id, !model.hidden);",
		);
		expect(pickerSource).toContain("await refresh();");
		expect(popoverSource).toContain("<PopoverPrimitive.Portal>");
		expect(popoverSource).toContain(
			'style={{ zIndex: "var(--z-menu)", ...style }}',
		);
	});

	test("keeps hidden filtering, search, grouping, and wrapped keyboard focus", () => {
		const models: ModelCatalogEntry[] = [
			{ id: "gateway-visible", contextWindow: 200_000 },
			{ id: "gateway-hidden", hidden: true },
			{ id: "driver-visible", source: "driver", driverLabel: "Codex" },
		];

		expect(filterAndGroupModelCatalog(models, "", false)).toEqual({
			gateway: [models[0]],
			driver: [models[2]],
		});
		expect(filterAndGroupModelCatalog(models, "HIDDEN", true)).toEqual({
			gateway: [models[1]],
			driver: [],
		});
		expect(nextModelPickerFocus(-1, 3, "ArrowDown")).toBe(0);
		expect(nextModelPickerFocus(2, 3, "ArrowDown")).toBe(0);
		expect(nextModelPickerFocus(0, 3, "ArrowUp")).toBe(2);
		expect(nextModelPickerFocus(1, 0, "ArrowDown")).toBe(1);
	});

	test("renders the exact loading, error, unavailable, stale, and model metadata surfaces", () => {
		const models: ModelCatalogEntry[] = [
			{
				id: "claude-opus",
				contextWindow: 1_000_000,
				reasoning: true,
				input: ["text", "image"],
				live: true,
			},
			{
				id: "codex-model",
				source: "driver",
				driverLabel: "Codex",
			},
		];

		configureChatRuntime({
			useModelCatalog: () => ({
				models,
				driver: { id: "codex", source: "last-known", ids: 1, error: "offline" },
				error: "gateway warning",
				refresh: async () => undefined,
			}),
		});
		const populated = renderToStaticMarkup(
			<ModelPicker
				mode="multi"
				variant="inline"
				value={new Set(["claude-opus"])}
				onChange={() => undefined}
			/>,
		);
		expect(populated).toContain("mp-menu-inline");
		expect(populated).toContain("gateway warning");
		expect(populated).toContain("1M");
		expect(populated).toContain("reasoning");
		expect(populated).toContain("r-image");
		expect(populated).toContain("Codex · 1 · no local cost");
		expect(populated).toContain("model-picker-stale-badge");
		expect(populated).toContain("cached");

		configureChatRuntime({
			useModelCatalog: () => ({
				models: null,
				driver: null,
				error: null,
				refresh: async () => undefined,
			}),
		});
		const loading = renderToStaticMarkup(
			<ModelPicker variant="inline" value={null} onChange={() => undefined} />,
		);
		expect(loading).toContain("mp-loading");
		expect(loading).toContain("loading…");

		configureChatRuntime({
			useModelCatalog: () => ({
				models: [],
				driver: {
					id: "cursor",
					source: "none",
					ids: 0,
					error: "catalog probe failed",
				},
				error: null,
				refresh: async () => undefined,
			}),
		});
		const unavailable = renderToStaticMarkup(
			<ModelPicker variant="inline" value={null} onChange={() => undefined} />,
		);
		expect(unavailable).toContain("model-picker-unavailable");
		expect(unavailable).toContain("catalog unavailable for cursor");
		expect(unavailable).toContain("catalog probe failed");
	});

	test("preserves the standalone no-picker fallback when no catalog hook is injected", () => {
		configureChatRuntime({ useModelCatalog: () => null });
		expect(
			renderToStaticMarkup(
				<ModelPicker value={null} onChange={() => undefined} />,
			),
		).toBe("");
	});
});
