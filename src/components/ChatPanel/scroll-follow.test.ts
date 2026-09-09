import { afterEach, describe, expect, test } from 'bun:test';
import { createScrollFollow } from './scroll-follow';

// Geometry and observer delivery are explicit so tests exercise both browser
// orderings: a layout-generated scroll before, and after, ResizeObserver.
class Box extends EventTarget {
  scrollTop = 600;
  scrollHeight = 1000;
  clientHeight = 400;
  clientWidth = 300;
  clientLeft = 0;
  children: Box[] = [];
  parentElement: Box | null = null;
  overflowY = 'visible';
  overscrollBehaviorY = 'auto';
  editable = false;
  button = false;
  writes: ScrollToOptions[] = [];
  ownerDocument = Object.assign(new EventTarget(), {
    defaultView: { getComputedStyle: (box: Box) => ({ overflowY: box.overflowY, overscrollBehaviorY: box.overscrollBehaviorY }) },
  });
  closest(selector: string) {
    return (this.editable && selector.includes('textarea')) || (this.button && selector.includes('button')) ? this : null;
  }
  getBoundingClientRect() { return { left: 0, right: 315 }; }
  scrollTo(options: ScrollToOptions) {
    this.writes.push(options);
    this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight));
  }
}

const originalResize = globalThis.ResizeObserver;
const originalMutation = globalThis.MutationObserver;
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  globalThis.ResizeObserver = originalResize;
  globalThis.MutationObserver = originalMutation;
});

function fixture() {
  let resize!: () => void;
  let mutate!: () => void;
  let disconnected = 0;
  const observed = new Set<unknown>();
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { resize = callback; }
    observe(element: unknown) { observed.add(element); }
    unobserve(element: unknown) { observed.delete(element); }
    disconnect() { disconnected++; observed.clear(); }
  } as unknown as typeof ResizeObserver;
  globalThis.MutationObserver = class {
    constructor(callback: () => void) { mutate = callback; }
    observe(_element: unknown, options: MutationObserverInit) {
      expect(options).toEqual({ childList: true });
    }
    disconnect() { disconnected++; }
  } as unknown as typeof MutationObserver;
  const viewport = new Box();
  const child = new Box();
  child.parentElement = viewport;
  viewport.children = [child];
  let unread = 0;
  let unpins = 0;
  let readingScrolls = 0;
  const follower = createScrollFollow(viewport as unknown as HTMLElement, {
    onUnpin: () => { unpins++; },
    onBottom: () => { unread = 0; },
    onReadingScroll: () => { readingScrolls++; },
  });
  cleanups.push(follower.dispose);
  const emit = (type: string, properties: Record<string, unknown> = {}, target = viewport) => {
    const event = new Event(type);
    Object.assign(event, properties);
    Object.defineProperty(event, 'target', { value: target });
    viewport.dispatchEvent(event);
  };
  const scroll = (top: number) => { viewport.scrollTop = top; emit('scroll'); };
  const append = () => {
    viewport.scrollHeight += 60;
    if (follower.isPinned()) follower.follow(); else unread++;
  };
  return { viewport, child, follower, emit, scroll, append, resize, mutate, observed,
    unread: () => unread, unpins: () => unpins, readingScrolls: () => readingScrolls,
    disconnected: () => disconnected };
}

describe('chat live-tail input and layout', () => {
  test('untouched viewport resize and task collapse never produce unread output', () => {
    const f = fixture();
    f.viewport.clientHeight = 500;
    f.scroll(500); // browser clamps before observer delivery
    f.resize();
    f.viewport.scrollHeight = 800;
    f.resize(); // observer before the queued scroll event
    f.emit('scroll');
    f.append();
    expect(f.follower.isPinned()).toBe(true);
    expect(f.unread()).toBe(0);
    expect(f.unpins()).toBe(0);
    expect(f.viewport.scrollTop).toBe(360);
    expect(f.viewport.writes.every(write => write.behavior === 'instant')).toBe(true);
  });

  test('asynchronous descendant growth follows without a new message render', () => {
    const f = fixture();
    f.viewport.scrollHeight += 200;
    f.resize();
    expect(f.viewport.scrollTop).toBe(800);
  });

  test('one-pixel upward wheel releases before scrolling and survives growth', () => {
    const f = fixture();
    f.emit('wheel', { deltaY: -1 });
    expect(f.follower.isPinned()).toBe(false);
    f.scroll(599);
    f.append();
    f.resize();
    expect(f.viewport.scrollTop).toBe(599);
    expect(f.unread()).toBe(1);
  });

  test('upward input at the top of short content cannot release following', () => {
    const f = fixture();
    f.viewport.scrollHeight = 200;
    f.viewport.scrollTop = 0;
    f.emit('wheel', { deltaY: -10 });
    f.emit('keydown', { key: 'Home' });
    f.emit('touchstart', { touches: [{ clientY: 100 }] });
    f.emit('touchmove', { touches: [{ clientY: 110 }] });
    f.viewport.scrollHeight = 1000;
    f.resize();
    f.append();
    expect(f.follower.isPinned()).toBe(true);
    expect(f.unread()).toBe(0);
    expect(f.viewport.scrollTop).toBe(660);
  });

  test('Space and Shift+Space on a button do not change follow intent', () => {
    const f = fixture();
    f.child.button = true;
    f.emit('keydown', { key: ' ', shiftKey: true }, f.child);
    expect(f.follower.isPinned()).toBe(true);
    f.follower.pause();
    f.scroll(580);
    f.emit('keydown', { key: ' ', shiftKey: false }, f.child);
    f.scroll(600);
    expect(f.follower.isPinned()).toBe(false);
  });

  test('layout bringing a reader to the bottom cannot repin, in either delivery order', () => {
    for (const observerFirst of [true, false]) {
      const f = fixture();
      f.emit('wheel', { deltaY: -20 });
      f.scroll(580);
      f.viewport.scrollHeight = 980;
      if (observerFirst) f.resize();
      f.emit('scroll');
      if (!observerFirst) f.resize();
      f.append();
      expect(f.follower.isPinned()).toBe(false);
      expect(f.unread()).toBe(1);
    }
  });

  test('downward movement must reach the actual bottom to resume following', () => {
    const f = fixture();
    f.emit('wheel', { deltaY: -20 });
    f.scroll(580);
    f.emit('wheel', { deltaY: 5 });
    f.scroll(585);
    expect(f.follower.isPinned()).toBe(false);
    f.scroll(600);
    expect(f.follower.isPinned()).toBe(true);
  });

  test('touch downward releases; opposite touch inertia can return after touchend', () => {
    const f = fixture();
    f.emit('touchstart', { touches: [{ clientY: 100 }] });
    f.emit('touchmove', { touches: [{ clientY: 110 }] });
    f.scroll(590);
    expect(f.follower.isPinned()).toBe(false);
    f.emit('touchmove', { touches: [{ clientY: 105 }] });
    f.emit('touchend');
    f.scroll(595);
    f.scroll(600);
    expect(f.follower.isPinned()).toBe(true);
  });

  test('nested execution list consumes wheel, touch and keys until its boundary', () => {
    const f = fixture();
    f.child.overflowY = 'auto';
    f.child.scrollTop = 100;
    f.emit('wheel', { deltaY: -4 }, f.child);
    f.emit('keydown', { key: 'ArrowUp' }, f.child);
    f.emit('touchstart', { touches: [{ clientY: 100 }] }, f.child);
    f.emit('touchmove', { touches: [{ clientY: 110 }] }, f.child);
    expect(f.follower.isPinned()).toBe(true);
    f.child.scrollTop = 0;
    f.emit('wheel', { deltaY: -4 }, f.child);
    expect(f.follower.isPinned()).toBe(false);
  });

  test('contained nested lists cannot change outer intent at either scroll boundary', () => {
    for (const behavior of ['contain', 'none']) {
      const f = fixture();
      f.child.overflowY = 'auto';
      f.child.overscrollBehaviorY = behavior;
      f.child.scrollTop = 0;
      f.emit('wheel', { deltaY: -10 }, f.child);
      f.emit('touchstart', { touches: [{ clientY: 100 }] }, f.child);
      f.emit('touchmove', { touches: [{ clientY: 110 }] }, f.child);
      f.append();
      expect(f.follower.isPinned()).toBe(true);
      expect(f.unread()).toBe(0);

      f.follower.pause();
      f.scroll(580);
      f.child.scrollTop = f.child.scrollHeight - f.child.clientHeight;
      f.emit('wheel', { deltaY: 10 }, f.child);
      f.scroll(660);
      expect(f.follower.isPinned()).toBe(false);
    }
  });

  test('overscroll containment on a non-scroll container does not block outer intent', () => {
    const f = fixture();
    f.child.overscrollBehaviorY = 'contain';
    f.emit('wheel', { deltaY: -10 }, f.child);
    expect(f.follower.isPinned()).toBe(false);
  });

  test('scroll keys work on viewport but ignore editable descendants', () => {
    const f = fixture();
    f.child.editable = true;
    f.emit('keydown', { key: 'ArrowUp' }, f.child);
    expect(f.follower.isPinned()).toBe(true);
    f.emit('keydown', { key: 'PageUp' });
    f.scroll(200);
    expect(f.follower.isPinned()).toBe(false);
    f.emit('keydown', { key: 'End' });
    f.scroll(600);
    expect(f.follower.isPinned()).toBe(true);
  });

  test('padding click keeps following; overlay scrollbar movement releases and returns', () => {
    const f = fixture();
    f.emit('pointerdown', { button: 0, clientX: 10 });
    f.viewport.ownerDocument.dispatchEvent(new Event('pointerup'));
    expect(f.follower.isPinned()).toBe(true);
    f.emit('pointerdown', { button: 0, clientX: 299 });
    f.scroll(300);
    expect(f.follower.isPinned()).toBe(false);
    f.scroll(600);
    expect(f.follower.isPinned()).toBe(true);
  });

  test('classic scrollbar gutter releases immediately', () => {
    const f = fixture();
    f.emit('pointerdown', { button: 0, clientX: 310 });
    expect(f.follower.isPinned()).toBe(false);
  });

  test('pagination anchor writes cannot repin a reader', () => {
    const f = fixture();
    f.follower.pause();
    f.scroll(10);
    expect(f.readingScrolls()).toBe(1);
    f.viewport.scrollHeight += 500;
    f.viewport.scrollTop += 500;
    f.follower.recordPosition();
    f.emit('scroll');
    f.resize();
    expect(f.viewport.scrollTop).toBe(510);
    expect(f.follower.isPinned()).toBe(false);
  });

  test('explicit follow for send, jump and thread switch resets reader state', () => {
    const f = fixture();
    f.follower.pause();
    f.scroll(100);
    f.append();
    expect(f.unread()).toBe(1);
    f.follower.follow();
    expect(f.follower.isPinned()).toBe(true);
    expect(f.unread()).toBe(0);
    expect(f.viewport.scrollTop).toBe(660);
  });

  test('direct additions/removals update observers and follow; cleanup detaches inputs', () => {
    const f = fixture();
    expect(f.observed.has(f.child)).toBe(true);
    const replacement = new Box();
    f.viewport.children = [replacement];
    f.viewport.scrollHeight = 700;
    f.mutate();
    expect(f.observed.has(f.child)).toBe(false);
    expect(f.observed.has(replacement)).toBe(true);
    expect(f.viewport.scrollTop).toBe(300);
    f.follower.dispose();
    cleanups.pop();
    expect(f.disconnected()).toBe(2);
    f.emit('wheel', { deltaY: -10 });
    expect(f.follower.isPinned()).toBe(true);
  });
});
