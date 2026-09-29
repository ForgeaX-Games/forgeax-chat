import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { getLocale, initI18n, setLocale } from "./runtime";
import {
	standaloneMessages,
	translateStandaloneMessage,
} from "./standalone-messages";
import { initializeStandaloneSessions } from "./standalone-session-bootstrap";

function collectProductionSources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) return collectProductionSources(absolutePath);
		if (
			![".ts", ".tsx"].includes(extname(entry.name)) ||
			entry.name.includes(".test.")
		)
			return [];
		return [absolutePath];
	});
}

function literalTranslationKeys(): string[] {
	const keys = new Set<string>();
	for (const file of collectProductionSources(import.meta.dir)) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g))
			keys.add(match[1]!);
	}
	return [...keys].sort();
}

describe("standalone Chat runtime", () => {
	test("renders before fail-soft session initialization", async () => {
		const source = await Bun.file(
			new URL("./main.tsx", import.meta.url),
		).text();
		expect(source.indexOf("createRoot(rootEl).render(")).toBeLessThan(
			source.indexOf("void initializeStandaloneSessions("),
		);

		let setStateCalls = 0;
		await expect(
			initializeStandaloneSessions({
				fetchSessionList: async () => {
					throw new Error("server unavailable");
				},
				ensureSession: async () => ({ sid: "unused" }),
				connect: () => undefined,
				setState: () => {
					setStateCalls += 1;
				},
			}),
		).resolves.toBeUndefined();
		expect(setStateCalls).toBe(0);
	});

	test("owns complete English and Chinese copy for every literal Chat key", () => {
		const keys = literalTranslationKeys();
		for (const locale of ["en", "zh"] as const) {
			const missing = keys.filter((key) => !standaloneMessages[locale][key]);
			expect(missing).toEqual([]);
		}

		expect(translateStandaloneMessage("en", "chat.empty.title")).not.toBe(
			"chat.empty.title",
		);
		expect(translateStandaloneMessage("en", "composer.send")).not.toBe(
			"composer.send",
		);
		expect(translateStandaloneMessage("zh", "composer.send")).not.toBe(
			"composer.send",
		);
	});

	test("owns the dynamic Chat translation namespaces", () => {
		for (const prefix of [
			"agentStatus.",
			"composer.cliDesc",
			"subAgent.role.",
			"taskFlow.role.",
			"taskFlow.tool.",
		]) {
			expect(
				Object.keys(standaloneMessages.en).some((key) =>
					key.startsWith(prefix),
				),
			).toBeTrue();
			expect(
				Object.keys(standaloneMessages.zh).some((key) =>
					key.startsWith(prefix),
				),
			).toBeTrue();
		}
	});

	test("restores the standalone locale from the established persisted key", () => {
		const descriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			"localStorage",
		);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => (key === "forgeax.locale" ? "zh" : null),
			},
		});
		try {
			setLocale("en");
			initI18n();
			expect(getLocale()).toBe("zh");
		} finally {
			setLocale("en");
			if (descriptor)
				Object.defineProperty(globalThis, "localStorage", descriptor);
			else delete (globalThis as { localStorage?: Storage }).localStorage;
		}
	});
});
