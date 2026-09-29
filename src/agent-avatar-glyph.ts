/** Map a ForgeaX agent id / role tribe to the vector avatar glyph id. */
export function resolveAvatarGlyphId(
	agentId: string,
	roleTribe: string,
): string {
	if (
		agentId.includes("cc-coder") ||
		roleTribe === "coding" ||
		roleTribe === "coder"
	) {
		return "claude-code";
	}
	const known = [
		"orchestrator",
		"pillar",
		"design",
		"narrative",
		"art",
		"coding",
	] as const;
	if ((known as readonly string[]).includes(roleTribe)) return roleTribe;
	if ((known as readonly string[]).includes(agentId)) return agentId;
	return agentId;
}
