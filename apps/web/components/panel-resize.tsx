"use client";
import { useRef } from "react";
/** A pointer and keyboard equivalent for a read-only workspace panel divider. */
export function PanelResize({ label, width, onWidth, reverse = false, min = 180, max = 380 }: { label: string; width: number; onWidth: (width: number) => void; reverse?: boolean; min?: number; max?: number }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const update = (value: number) => onWidth(Math.max(min, Math.min(max, value)));
  return <div className="panel-resize" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
    onPointerDown={event => { start.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
    onPointerMove={event => { if (start.current) update(start.current.width + (event.clientX - start.current.x) * (reverse ? -1 : 1)); }}
    onPointerUp={event => { start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { start.current = null; }}
    onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); update(width + (event.key === "ArrowRight" ? 16 : -16) * (reverse ? -1 : 1)); } if (event.key === "Home") { event.preventDefault(); update(min); } if (event.key === "End") { event.preventDefault(); update(max); } }} />;
}
