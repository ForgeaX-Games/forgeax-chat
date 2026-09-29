import { afterEach, describe, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
let importGeneration = 0;

function importFreshModelLabel() {
	importGeneration += 1;
	return import(`./model-label.ts?test=${importGeneration}`);
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Chat-owned model label", () => {
	test("uses the established fallback and shares one exact nonempty health label", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async (input: string | URL | Request) => {
			fetchCalls += 1;
			expect(input).toBe("/api/health");
			return {
				ok: true,
				json: async () => ({ model: "  server label  " }),
			} as Response;
		}) as typeof fetch;
		const { CURRENT_MODEL, installModelLabelUpdate, loadModelLabel } =
			await importFreshModelLabel();

		expect(CURRENT_MODEL).toEqual({ label: "Claude Opus 4.7" });
		await expect(
			Promise.all([loadModelLabel(), loadModelLabel()]),
		).resolves.toEqual(["  server label  ", "  server label  "]);
		expect(fetchCalls).toBe(1);

		const labels: string[] = [];
		const dispose = installModelLabelUpdate((label) => labels.push(label));
		await Promise.resolve();
		expect(labels).toEqual(["  server label  "]);
		dispose();
	});

	test("fails silently and never polls after a failed once-load", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			throw new Error("offline");
		}) as typeof fetch;
		const { loadModelLabel } = await importFreshModelLabel();

		await expect(loadModelLabel()).resolves.toBeNull();
		await expect(loadModelLabel()).resolves.toBeNull();
		expect(fetchCalls).toBe(1);
	});

	test("ignores unsuccessful, empty, and non-string health responses", async () => {
		const cases = [
			{ ok: false, model: "ignored" },
			{ ok: true, model: "" },
			{ ok: true, model: 47 },
		];

		for (const item of cases) {
			globalThis.fetch = (async () => ({
				ok: item.ok,
				json: async () => ({ model: item.model }),
			})) as typeof fetch;
			const { loadModelLabel } = await importFreshModelLabel();
			await expect(loadModelLabel()).resolves.toBeNull();
		}
	});

	test("fences a retained once-load after that hook instance is disposed", async () => {
		let resolveResponse!: (response: Response) => void;
		globalThis.fetch = (() =>
			new Promise<Response>((resolve) => {
				resolveResponse = resolve;
			})) as typeof fetch;
		const { installModelLabelUpdate, loadModelLabel } =
			await importFreshModelLabel();
		const labels: string[] = [];

		const dispose = installModelLabelUpdate((label) => labels.push(label));
		dispose();
		resolveResponse({
			ok: true,
			json: async () => ({ model: "late model" }),
		} as Response);
		await loadModelLabel();
		await Promise.resolve();

		expect(labels).toEqual([]);
	});
});
