import type { PointerEvent } from 'react';
export function SplitHandle({ layout, ratio, onChange, grid = false }: { layout: 'horizontal' | 'vertical'; ratio: number; onChange: (ratio: number) => void; grid?: boolean }) {
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const parent = event.currentTarget.parentElement!;
    const box = parent.getBoundingClientRect();
    const vertical = grid ? layout === 'vertical' : getComputedStyle(parent).flexDirection === 'column';
    const value = vertical ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width;
    onChange(Math.max(20, Math.min(80, Math.round(value * 100))));
  }
  return <div className={`split-handle ${grid ? `grid-handle grid-handle-${layout}` : ''}`} role="separator" tabIndex={0} aria-label={grid ? layout === 'horizontal' ? '调整四宫格左右比例' : '调整四宫格上下比例' : '调整终端分屏比例'} aria-orientation={layout === 'horizontal' ? 'vertical' : 'horizontal'} aria-valuemin={20} aria-valuemax={80} aria-valuenow={ratio}
    onPointerDown={e => { if (e.button === 0) { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); } }} onPointerMove={move}
    onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onDoubleClick={() => onChange(50)}
    onKeyDown={e => {
      const lower = layout === 'horizontal' ? 'ArrowLeft' : 'ArrowUp', higher = layout === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
      if ([lower, higher, 'Home', 'End'].includes(e.key)) { e.preventDefault(); onChange(e.key === 'Home' ? 20 : e.key === 'End' ? 80 : Math.max(20, Math.min(80, ratio + (e.key === higher ? 5 : -5)))); }
    }} />;
}
