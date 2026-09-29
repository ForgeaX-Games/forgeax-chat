import {
	type RefObject,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

type ScrollAnchor = { prevHeight: number; prevTop: number };

/**
 * Keeps the visible message fixed when a previous page is prepended to the thread.
 * The pending anchor is state rather than an unrelated render counter so React runs
 * the layout effect after the extra messages have mounted.
 */
export function useScrollAnchor(
	threadRef: RefObject<HTMLDivElement | null>,
	lastTopRef: RefObject<number>,
) {
	const pendingRef = useRef<ScrollAnchor | null>(null);
	const [pendingAnchor, setPendingAnchor] = useState<ScrollAnchor | null>(null);

	const capture = useCallback((el: HTMLDivElement) => {
		const anchor = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
		pendingRef.current = anchor;
		setPendingAnchor(anchor);
	}, []);

	useLayoutEffect(() => {
		const el = threadRef.current;
		if (!el || !pendingAnchor) return;
		el.scrollTop =
			el.scrollHeight - pendingAnchor.prevHeight + pendingAnchor.prevTop;
		lastTopRef.current = el.scrollTop;
		pendingRef.current = null;
		setPendingAnchor(null);
	}, [pendingAnchor, lastTopRef, threadRef]);

	return { capture, pendingRef };
}
