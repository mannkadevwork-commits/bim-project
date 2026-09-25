import React from 'react';

export const StretchTooltipOverlay = ({ visible, x, y, label }) => {
  if (!visible || !label) return null;
  return (
    <div
      className="fixed pointer-events-none z-[9999] flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-900/90 text-cyan-400 border border-cyan-500/40 shadow-[0_8px_25px_rgba(0,0,0,0.4)] backdrop-blur-md text-xs font-mono font-bold transition-all duration-75 animate-in fade-in zoom-in-95"
      style={{
        left: `${x + 18}px`,
        top: `${y - 12}px`,
      }}
    >
      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
      <span>{label}</span>
    </div>
  );
};