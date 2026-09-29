import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useScrollAnchor } from "./use-scroll-anchor";

const globalKeys = [
	"window",
	"document",
	"HTMLElement",
	"Event",
	"MouseEvent",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let dom: Window;

function ScrollPagingHarness() {
	const threadRef = useRef<HTMLDivElement>(null);
	const lastTopRef = useRef(0);
	const sizeRef = useRef({ height: 500 });
	const [olderPages, setOlderPages] = useState(0);
	const { capture, pendingRef } = useScrollAnchor(threadRef, lastTopRef);
	sizeRef.current.height = 500 + olderPages * 200;

	useLayoutEffect(() => {
		const el = threadRef.current;
		if (!el) return;
		Object.defineProperties(el, {
			scrollHeight: {
				configurable: true,
				get: () => sizeRef.current.height,
			},
			clientHeight: { configurable: true, get: () => 100 },
		});
	}, []);

	const loadPreviousPage = () => {
		const el = threadRef.current;
		if (!el) return;
		capture(el);
		setOlderPages((count) => count + 1);
	};

	return (
		<>
			<div
				data-testid="thread"
				ref={threadRef}
				onScroll={() => {
					if (
						threadRef.current &&
						threadRef.current.scrollTop < 80 &&
						!pendingRef.current
					)
						loadPreviousPage();
				}}
			/>
			<button data-testid="load" onClick={loadPreviousPage} type="button">
				Load earlier
			</button>
			<button
				data-testid="collapse"
				onClick={() => setOlderPages(0)}
				type="button"
			>
				Collapse
			</button>
		</>
	);
}

describe("useScrollAnchor", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeAll(async () => {
		dom = new Window({ url: "http://localhost" });
		for (const key of globalKeys)
			savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.assign(globalThis as object, {
			window: dom,
			document: dom.document,
			HTMLElement: dom.HTMLElement,
			Event: dom.Event,
			MouseEvent: dom.MouseEvent,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => root.render(<ScrollPagingHarness />));
	});

	afterAll(async () => {
		await act(async () => root.unmount());
		container.remove();
		dom.close();
		for (const key of globalKeys) {
			const descriptor = savedGlobals.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});

	test("keeps the viewport anchored across click paging and allows later pages", async () => {
		const thread = container.querySelector<HTMLDivElement>(
			"[data-testid=thread]",
		);
		const load =
			container.querySelector<HTMLButtonElement>("[data-testid=load]");
		expect(thread).not.toBeNull();
		expect(load).not.toBeNull();
		if (!thread || !load)
			throw new Error("scroll paging harness did not mount");

		thread.scrollTop = 50;
		await act(async () => load.click());
		expect(thread.scrollTop).toBe(250);

		await act(async () => load.click());
		expect(thread.scrollTop).toBe(450);

		await act(async () => load.click());
		expect(thread.scrollTop).toBe(650);
	});

	test("guards repeated scroll paging and handles collapse without a stale anchor", async () => {
		const thread = container.querySelector<HTMLDivElement>(
			"[data-testid=thread]",
		);
		const collapse = container.querySelector<HTMLButtonElement>(
			"[data-testid=collapse]",
		);
		expect(thread).not.toBeNull();
		expect(collapse).not.toBeNull();
		if (!thread || !collapse)
			throw new Error("scroll paging harness did not mount");

		thread.scrollTop = 0;
		await act(async () => {
			thread.dispatchEvent(new Event("scroll", { bubbles: true }));
			thread.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		expect(thread.scrollTop).toBe(200);

		thread.scrollTop = 37;
		await act(async () => collapse.click());
		expect(thread.scrollTop).toBe(37);
	});
});
