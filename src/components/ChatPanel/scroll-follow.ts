type ScrollFollowOptions = {
  onUnpin: () => void;
  onBottom: () => void;
  onReadingScroll: () => void;
};

// Scroll events also come from anchoring, layout and our own writes. Only input
// intent may release the live tail or return a reader to it.
export function createScrollFollow(viewport: HTMLElement, options: ScrollFollowOptions) {
  let pinned = true;
  let lastTop = viewport.scrollTop;
  let height = viewport.scrollHeight;
  let viewportHeight = viewport.clientHeight;
  let towardBottom = false;
  let dragging = false;
  let touchY: number | null = null;

  const recordPosition = () => {
    lastTop = viewport.scrollTop;
    height = viewport.scrollHeight;
    viewportHeight = viewport.clientHeight;
  };
  const pause = () => {
    towardBottom = false;
    if (pinned) {
      pinned = false;
      options.onUnpin();
    }
  };
  const follow = () => {
    pinned = true;
    towardBottom = false;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
    recordPosition();
    options.onBottom();
  };
  const consumedByChild = (target: EventTarget | null, direction: number) => {
    let element = target as HTMLElement | null;
    while (element && element !== viewport) {
      const style = viewport.ownerDocument.defaultView?.getComputedStyle(element);
      if (style?.overflowY === 'auto' || style?.overflowY === 'scroll') {
        // Execution lists block scroll chaining even at their boundaries.
        if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') return true;
        if (direction < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1) return true;
      }
      element = element.parentElement;
    }
    return false;
  };
  const intent = (direction: number, target: EventTarget | null) => {
    if (consumedByChild(target, direction)) return;
    if (direction < 0 && viewport.scrollTop > 0 && viewport.scrollHeight > viewport.clientHeight) pause();
    else if (direction > 0) towardBottom = true;
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) intent(event.deltaY, event.target);
  };
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY ?? null;
    if (touchY !== null && nextY !== null) intent(touchY - nextY, event.target);
    touchY = nextY;
  };
  const onTouchEnd = () => { touchY = null; };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    if (event.defaultPrevented || event.altKey || event.metaKey ||
      target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    if (event.key === ' ' && target?.closest?.('button, a, [role="button"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) intent(-1, event.target);
    else if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || event.key === ' ') intent(1, event.target);
  };
  const onPointerDown = (event: PointerEvent) => {
    // Padding also targets the viewport. Only a real gutter can release the
    // tail immediately; overlay scrollbars must first produce a scroll.
    if (event.button === 0 && event.target === viewport && viewport.scrollHeight > viewport.clientHeight) {
      dragging = true;
      const rect = viewport.getBoundingClientRect();
      const left = rect.left + viewport.clientLeft;
      if (event.clientX >= rect.left && event.clientX <= rect.right &&
        (event.clientX < left || event.clientX >= left + viewport.clientWidth)) pause();
    }
  };
  const onPointerUp = () => { if (dragging) onScroll(); dragging = false; };
  const onScrollEnd = () => { towardBottom = false; };
  const onScroll = () => {
    const top = viewport.scrollTop;
    const layoutChanged = height !== viewport.scrollHeight || viewportHeight !== viewport.clientHeight;
    const movedDown = top > lastTop;
    const atBottom = viewport.scrollHeight - top - viewport.clientHeight <= 1;
    if (layoutChanged) towardBottom = false;
    if (dragging && !layoutChanged && top !== lastTop && !atBottom) pause();
    if (!pinned && !layoutChanged && movedDown && atBottom &&
      (dragging || towardBottom)) {
      follow();
    } else {
      recordPosition();
      if (!pinned) options.onReadingScroll();
    }
  };
  const onResize = () => {
    towardBottom = false;
    if (pinned) follow();
    else recordPosition();
  };
  const observer = new ResizeObserver(onResize);
  observer.observe(viewport);
  // Preserve the direct-message DOM contract used by shared motion styles.
  // Child resizing covers asynchronous descendants; only direct additions and
  // removals need mutation observation, bounded by the rendered history window.
  const observed = new Set<Element>();
  const observeChildren = () => {
    const children = new Set(viewport.children);
    for (const child of observed) {
      if (!children.has(child)) { observer.unobserve(child); observed.delete(child); }
    }
    for (const child of children) {
      if (!observed.has(child)) { observer.observe(child); observed.add(child); }
    }
  };
  observeChildren();
  const mutations = new MutationObserver(() => { observeChildren(); onResize(); });
  mutations.observe(viewport, { childList: true });
  viewport.addEventListener('scroll', onScroll);
  viewport.addEventListener('scrollend', onScrollEnd);
  viewport.addEventListener('wheel', onWheel, { passive: true });
  viewport.addEventListener('touchstart', onTouchStart, { passive: true });
  viewport.addEventListener('touchmove', onTouchMove, { passive: true });
  viewport.addEventListener('touchend', onTouchEnd);
  viewport.addEventListener('touchcancel', onTouchEnd);
  viewport.addEventListener('keydown', onKeyDown);
  viewport.addEventListener('pointerdown', onPointerDown);
  const document = viewport.ownerDocument;
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);

  return {
    isPinned: () => pinned,
    follow,
    pause,
    recordPosition,
    dispose: () => {
      observer.disconnect();
      mutations.disconnect();
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('scrollend', onScrollEnd);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('touchend', onTouchEnd);
      viewport.removeEventListener('touchcancel', onTouchEnd);
      viewport.removeEventListener('keydown', onKeyDown);
      viewport.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
