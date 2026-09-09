import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_HANDOFF_HEIGHT, MIN_HANDOFF_HEIGHT, handoffBounds, readHandoffHeight, handoffStorageKey } from './handoff-size';

/** Session-scoped split size. The parent keys this pane by session/agent. */
export function HandoffPane({ sid, label, children }: { sid: string; label: string; children: ReactNode }) {
  const paneRef = useRef<HTMLElement>(null);
  const preferred = useRef(readHandoffHeight(sid));
  const [height, setHeight] = useState(preferred.current);
  const [bounds, setBounds] = useState({ min: MIN_HANDOFF_HEIGHT, max: preferred.current });
  const boundsRef = useRef(bounds);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.min(boundsRef.current.max, Math.max(boundsRef.current.min, value));
  const update = (value: number) => {
    const next = clamp(value);
    preferred.current = next;
    setHeight(next);
    try { localStorage.setItem(handoffStorageKey(sid), String(next)); } catch { /* Storage is optional. */ }
  };
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const parent = pane?.parentElement;
    const chat = parent?.querySelector<HTMLElement>('.cp-body');
    if (!pane || !parent || !chat) return;
    const measure = () => {
      const next = handoffBounds(chat.getBoundingClientRect().height + pane.getBoundingClientRect().height);
      boundsRef.current = next;
      setBounds(old => old.min === next.min && old.max === next.max ? old : next);
      setHeight(Math.min(next.max, Math.max(next.min, preferred.current)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(chat);
    return () => observer.disconnect();
  }, []);
  return <section ref={paneRef} className="cp-handoffs cp-handoffs-resizable" aria-label={label} style={{ height }}>
    <div className={`cp-handoffs-divider${dragging ? ' is-dragging' : ''}`}
      role="separator" tabIndex={0} aria-label={label} aria-orientation="horizontal"
      aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(height)}
      onDoubleClick={() => update(DEFAULT_HANDOFF_HEIGHT)}
      onKeyDown={event => {
        const delta = event.shiftKey ? 40 : 10;
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        update(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : height + (event.key === 'ArrowUp' ? delta : -delta));
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, y: event.clientY, height };
        setDragging(true);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.pointer === event.pointerId) update(start.height + start.y - event.clientY);
      }}
      onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
    ><span aria-hidden="true">↕</span></div>
    {children}
  </section>;
}
