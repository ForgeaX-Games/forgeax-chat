import { useEffect, useState } from "react";
import { chatRequest, registerChatConnectionCleanup } from "./connection";

export interface ModelInfo {
	label: string;
	id?: string;
	contextWindow?: number;
}

export const CURRENT_MODEL: ModelInfo = { label: "Claude Opus 4.7" };

let modelLabelPromise: Promise<string | null> | null = null;
registerChatConnectionCleanup(() => {
	modelLabelPromise = null;
});

export function loadModelLabel(): Promise<string | null> {
	if (modelLabelPromise) return modelLabelPromise;
	modelLabelPromise = chatRequest("/api/health")
		.then((response) => (response.ok ? response.json() : null))
		.then((payload: { model?: unknown } | null) => {
			if (
				payload &&
				typeof payload.model === "string" &&
				payload.model.length > 0
			) {
				return payload.model;
			}
			return null;
		})
		.catch(() => null);
	return modelLabelPromise;
}

/** @internal Runs one hook instance's stale-fenced label update. */
export function installModelLabelUpdate(
	setLabel: (label: string) => void,
): () => void {
	let cancelled = false;
	void loadModelLabel().then((label) => {
		if (cancelled || !label) return;
		setLabel(label);
	});
	return () => {
		cancelled = true;
	};
}

export function useModelLabel(): string {
	const [label, setLabel] = useState<string>(CURRENT_MODEL.label);
	useEffect(() => installModelLabelUpdate(setLabel), []);
	return label;
}
