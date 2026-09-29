import {
	createElement,
	type KeyboardEvent,
	type MouseEvent,
	type ReactElement,
	useEffect,
	useState,
} from "react";
import { listExtensions, t } from "./runtime";

export interface ProviderBadge {
	label: string;
	color: string;
	title: string;
}

const PROVIDER_BADGES: Record<string, ProviderBadge> = {
	forgeax: {
		label: "forgeax",
		color: "#9ec5d4",
		title: "ForgeaX CLI provider",
	},
	"claude-code": {
		label: "claude-code",
		color: "#cfa3ff",
		title: "Anthropic claude-code CLI provider",
	},
	codex: {
		label: "codex",
		color: "#7be7c4",
		title: "OpenAI Codex CLI provider",
	},
	"kimi-code": {
		label: "kimi-code",
		color: "#58d8b5",
		title: "Kimi Code CLI provider",
	},
	"deepseek-harness": {
		label: "DeepSeek Harness",
		color: "#4fb6a6",
		title: "DeepSeek Harness CLI provider",
	},
};

export function providerBadgeFor(id: string): ProviderBadge {
	return (
		PROVIDER_BADGES[id] ?? {
			label: id,
			color: "#888",
			title: `CLI provider: ${id} (no UI badge style registered yet)`,
		}
	);
}

const CLI_PLUGIN_PREFIX = "@forgeax-plugin/cli-";
let cliProviderMap: Map<string, string> | null = null;
let cliProviderLoad: Promise<Map<string, string>> | null = null;

function shortIdFromExtensionId(extensionId: string): string | null {
	if (!extensionId.startsWith(CLI_PLUGIN_PREFIX)) return null;
	const shortId = extensionId.slice(CLI_PLUGIN_PREFIX.length);
	return shortId.length > 0 ? shortId : null;
}

/** Loads the session-immutable provider registry once for this module. */
export function loadCliProviderExtensionMap(): Promise<Map<string, string>> {
	if (cliProviderMap) return Promise.resolve(cliProviderMap);
	if (cliProviderLoad) return cliProviderLoad;
	cliProviderLoad = Promise.resolve()
		.then(() => listExtensions("cli-provider"))
		.then(({ items }) => {
			const next = new Map<string, string>();
			for (const item of items ?? []) {
				const shortId = shortIdFromExtensionId(item.id);
				if (shortId) next.set(shortId, item.id);
			}
			cliProviderMap = next;
			return next;
		})
		.catch(() => {
			const empty = new Map<string, string>();
			cliProviderMap = empty;
			return empty;
		});
	return cliProviderLoad;
}

/** @internal Runs one hook instance's stale-fenced registry update. */
export function installCliProviderExtensionMapUpdate(
	setMap: (map: Map<string, string>) => void,
): () => void {
	let cancelled = false;
	void loadCliProviderExtensionMap().then((map) => {
		if (!cancelled) setMap(map);
	});
	return () => {
		cancelled = true;
	};
}

export function useCliProviderExtensionMap(): Map<string, string> | null {
	const [map, setMap] = useState<Map<string, string> | null>(cliProviderMap);
	useEffect(() => installCliProviderExtensionMapUpdate(setMap), []);
	return map;
}

export interface ProviderBadgePillProps {
	providerId: string;
	className: string;
	onBusDeepLink?: (extensionId: string) => void;
}

interface RenderProviderBadgePillProps extends ProviderBadgePillProps {
	extensionId: string | null;
}

/** @internal Pure renderer shared with the interaction contract. */
export function renderProviderBadgePill({
	providerId,
	className,
	extensionId,
	onBusDeepLink,
}: RenderProviderBadgePillProps): ReactElement {
	const badge = providerBadgeFor(providerId);
	if (!onBusDeepLink || !extensionId) {
		return createElement(
			"span",
			{
				className,
				title: badge.title,
				style: { borderColor: badge.color, color: badge.color },
			},
			badge.label,
		);
	}

	const fire = () => onBusDeepLink(extensionId);
	return createElement(
		"span",
		{
			className: `${className} is-link`,
			role: "button",
			tabIndex: 0,
			title: t("providerBadge.clickToBusDetail", { title: badge.title }),
			style: { borderColor: badge.color, color: badge.color },
			onClick: (event: MouseEvent) => {
				event.stopPropagation();
				event.preventDefault();
				fire();
			},
			onKeyDown: (event: KeyboardEvent) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.stopPropagation();
				event.preventDefault();
				fire();
			},
		},
		badge.label,
		createElement(
			"span",
			{ className: "provider-badge-arrow", "aria-hidden": true, key: "arrow" },
			"→",
		),
	);
}

export function ProviderBadgePill(props: ProviderBadgePillProps): ReactElement {
	const map = useCliProviderExtensionMap();
	return renderProviderBadgePill({
		...props,
		extensionId: map?.get(props.providerId) ?? null,
	});
}
