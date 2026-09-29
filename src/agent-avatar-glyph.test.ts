import { describe, expect, test } from "bun:test";
import { resolveAvatarGlyphId } from "./agent-avatar-glyph";

describe("Chat-owned agent avatar glyph policy", () => {
	test("keeps the exact agent and role precedence used by the agent switcher", () => {
		expect(resolveAvatarGlyphId("agents/cc-coder.json", "design")).toBe(
			"claude-code",
		);
		expect(resolveAvatarGlyphId("custom-agent", "coding")).toBe("claude-code");
		expect(resolveAvatarGlyphId("custom-agent", "coder")).toBe("claude-code");
		expect(resolveAvatarGlyphId("art", "design")).toBe("design");
		expect(resolveAvatarGlyphId("narrative", "unknown")).toBe("narrative");
		expect(resolveAvatarGlyphId("custom-agent", "unknown")).toBe(
			"custom-agent",
		);
	});

	test("does not normalize inputs inside the resolver", () => {
		expect(resolveAvatarGlyphId("CC-CODER", "Coding")).toBe("CC-CODER");
		expect(resolveAvatarGlyphId("custom-agent", " coding ")).toBe(
			"custom-agent",
		);
	});
});
