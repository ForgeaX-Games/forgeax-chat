import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const checkedExtensions = new Set([".css", ".json", ".ts", ".tsx"]);
const ignoredFiles = new Set(["src/interface-dependency-ownership.test.ts"]);

function hasForbiddenInterfaceReference(source: string): boolean {
	const normalized = source.replaceAll("\\", "/");
	const packageReference = ["@forgeax", "interface"].join("/");
	const sourcePackagePath = ["packages", "interface"].join("/");
	const relativeSourcePath =
		/(?:^|['"`(\s])(?:\.{1,2}\/)+(?:packages\/)?interface(?:\/|['"`)\s]|$)/;
	return (
		normalized.includes(packageReference) ||
		normalized.includes(sourcePackagePath) ||
		relativeSourcePath.test(normalized)
	);
}

function collectCheckedFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolutePath = join(directory, entry.name);
		const packageRelativePath = relative(packageRoot, absolutePath);

		if (entry.isDirectory()) {
			if (entry.name === "dist" || entry.name === "node_modules") return [];
			return collectCheckedFiles(absolutePath);
		}

		if (ignoredFiles.has(packageRelativePath)) return [];
		if (!checkedExtensions.has(extname(entry.name))) return [];
		return [absolutePath];
	});
}

describe("Interface retirement ownership boundary", () => {
	test("Chat has no direct Interface package or source dependency", () => {
		const violations = collectCheckedFiles(packageRoot)
			.filter((file) =>
				hasForbiddenInterfaceReference(readFileSync(file, "utf8")),
			)
			.map((file) => relative(packageRoot, file))
			.sort();

		expect(violations).toEqual([]);
	});

	test("the boundary recognizes package, workspace and relative source reach-ins", () => {
		expect(
			hasForbiddenInterfaceReference(
				`import x from '${["@forgeax", "interface"].join("/")}/store';`,
			),
		).toBeTrue();
		expect(
			hasForbiddenInterfaceReference(
				`resolve(root, '${["packages", "interface"].join("/")}/src')`,
			),
		).toBeTrue();
		expect(
			hasForbiddenInterfaceReference(
				`"@/*": ["${["..", "interface", "src", "*"].join("/")}"]`,
			),
		).toBeTrue();
		expect(
			hasForbiddenInterfaceReference(
				`"@/*": ["${["..", "..", "packages", "interface", "src", "*"].join("/")}"]`,
			),
		).toBeTrue();
		expect(
			hasForbiddenInterfaceReference(
				`import { t } from '@forgeax/chat/runtime';`,
			),
		).toBeFalse();
	});
});
