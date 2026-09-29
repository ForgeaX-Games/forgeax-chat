import "./AgentAvatar.css";

export interface AgentAvatarProps {
	agentId: string;
	accent: string;
	fallback: string;
	size?: number;
	glass?: boolean;
}

function AvatarArt({ agentId }: { agentId: string }) {
	const stroke = {
		stroke: "currentColor",
		strokeWidth: 1.35,
		fill: "none" as const,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};

	switch (agentId) {
		case "orchestrator":
			return (
				<>
					<path {...stroke} d="M10 21h12" />
					<path
						{...stroke}
						d="M10 21V19l2.2-6.5 3.8 3.2L16 11l3 4.7L23.8 12.5 26 19v2"
					/>
					<circle cx="16" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
				</>
			);
		case "pillar":
			return (
				<>
					<rect {...stroke} x="11" y="11" width="10" height="10" rx="2" />
					<circle cx="16" cy="16" r="2" fill="currentColor" stroke="none" />
				</>
			);
		case "design":
			return (
				<>
					<rect {...stroke} x="10" y="10" width="12" height="5" rx="1" />
					<rect {...stroke} x="10" y="16" width="7" height="6" rx="1" />
					<rect {...stroke} x="18" y="16" width="4" height="6" rx="1" />
				</>
			);
		case "narrative":
			return (
				<>
					<path {...stroke} d="M16 10.5v10" />
					<path {...stroke} d="M16 10.5 9.5 14 10 21 16 19" />
					<path {...stroke} d="M16 10.5 22.5 14 22 21 16 19" />
					<path {...stroke} d="M12 16h8" />
				</>
			);
		case "art":
			return (
				<>
					<path
						{...stroke}
						d="M12.5 20.5c-0.5-3.5 2-8.5 4.5-9s4 5.5 4 9.5c0 2.2-1.8 3.8-4 3.8s-4.5-1.5-4.5-3.8"
					/>
					<path {...stroke} d="M19.5 9.5 24 13 12.5 23.5" />
					<circle cx="14" cy="17" r="1" fill="currentColor" stroke="none" />
					<circle cx="18" cy="16.5" r="1" fill="currentColor" stroke="none" />
				</>
			);
		case "coding":
			return <path {...stroke} d="M12 12 9 16l3 4M20 12l3 4-3 4" />;
		case "claude-code":
			return (
				<>
					<rect {...stroke} x="9" y="10" width="14" height="12" rx="2" />
					<path {...stroke} d="M11.5 15.5 13.5 17.5 11.5 19.5" />
					<path {...stroke} d="M15 17.5h5.5M15 20h4" />
				</>
			);
		default:
			return null;
	}
}

const TRIBE_ACCENT: Record<string, string> = {
	orchestrator: "var(--color-role-orchestrator)",
	pillar: "var(--color-role-pillar)",
	design: "var(--color-role-design)",
	narrative: "var(--color-role-narrative)",
	art: "var(--color-role-art)",
	coding: "var(--color-role-coding)",
	coder: "var(--color-role-coding)",
	"claude-code": "var(--color-role-coding)",
};

export function accentForRoleTribe(tribe: string): string {
	return TRIBE_ACCENT[tribe] ?? "var(--primary)";
}

export function AgentAvatar({
	agentId,
	accent,
	fallback,
	size = 28,
	glass = false,
}: AgentAvatarProps) {
	const art = AvatarArt({ agentId });
	const gradientId = `ag-glass-${agentId.replace(/[^a-z0-9-]/gi, "-")}`;

	return (
		<span
			className={`agent-avatar agent-avatar--art${glass ? " agent-avatar--glass" : ""}`}
			style={
				{
					color: accent,
					"--agent-accent": accent,
					"--agent-size": `${size}px`,
				} as React.CSSProperties
			}
			title={fallback}
		>
			<span className="agent-avatar__frame">
				<svg
					className="agent-avatar__glyph"
					viewBox="0 0 32 32"
					width={size - 3}
					height={size - 3}
					aria-hidden
				>
					{glass && (
						<defs>
							<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
								<stop offset="100%" stopColor="currentColor" stopOpacity="0" />
							</linearGradient>
						</defs>
					)}
					{glass && (
						<rect
							width="32"
							height="32"
							fill={`url(#${gradientId})`}
							stroke="none"
						/>
					)}
					{art ?? (
						<text
							x="16"
							y="19"
							textAnchor="middle"
							fill="currentColor"
							fontSize="10"
							fontWeight="600"
						>
							{fallback.slice(0, 2)}
						</text>
					)}
				</svg>
			</span>
		</span>
	);
}
