import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
const key = 'commonroom:sidebar-width:v1';
export function useSidebarWidth() {
  const [width, setWidth] = useState(() => { try { const value = Number(localStorage.getItem(key)); if (Number.isFinite(value) && value >= 260 && value <= 520) return value; } catch { /* Optional appearance preference. */ } return 360; });
  const [viewport, setViewport] = useState(() => innerWidth), [dragging, setDragging] = useState(false);
  useEffect(() => { const resize = () => setViewport(innerWidth); addEventListener('resize', resize); return () => removeEventListener('resize', resize); }, []);
  const maximum = Math.max(260, Math.min(520, viewport - 380)), actual = Math.min(width, maximum);
  const update = (value: number, save: boolean) => { const next = Math.round(Math.max(260, Math.min(maximum, value))); setWidth(next); if (save) try { localStorage.setItem(key, String(next)); } catch { /* Resizing still works without storage. */ } };
  const splitter = <div className="sidebar-splitter" role="separator" aria-label="Resize conversations" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={maximum} aria-valuenow={actual} aria-controls="chat-sidebar" tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event.clientX - (event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0), false); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); update(event.clientX - (event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0), true); } setDragging(false); }}
    onLostPointerCapture={() => setDragging(false)} onPointerCancel={() => setDragging(false)} onDoubleClick={() => update(360, true)}
    onKeyDown={event => { const next = event.key === 'ArrowLeft' ? actual - 20 : event.key === 'ArrowRight' ? actual + 20 : event.key === 'Home' ? 260 : event.key === 'End' ? maximum : null; if (next !== null) { event.preventDefault(); update(next, true); } }} />;
  return { style: { '--sidebar-width': `${actual}px` } as CSSProperties, splitter, dragging };
}
