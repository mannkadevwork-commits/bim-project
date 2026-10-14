import React from 'react';
import { Move, RotateCw, Scaling } from 'lucide-react';

const parseStretchLabel = (label) => {
  const valueMatch = String(label).match(/^(.+?):\s*(.+)$/);
  if (valueMatch && !String(label).startsWith('Drag')) {
    const [, dimensions, value] = valueMatch;
    return {
      kind: 'resize',
      title: `Resizing ${dimensions}`,
      subtitle: 'Pull in or push out',
      value,
    };
  }

  if (/^Drag to resize/i.test(label)) {
    const dimensions = String(label).replace(/^Drag to resize\s*/i, '').trim() || 'size';
    return {
      kind: 'resize',
      title: `Resize ${dimensions}`,
      subtitle: 'Drag either end in or out',
      value: null,
    };
  }

  if (/^Rotate/i.test(label) || /rotate/i.test(label)) {
    return {
      kind: 'rotate',
      title: 'Rotate',
      subtitle: 'Drag around the arc',
      value: label.replace(/^Rotate\s*[•:]?\s*/i, '') || null,
    };
  }

  if (/move/i.test(label)) {
    return {
      kind: 'move',
      title: 'Move',
      subtitle: 'Drag to reposition',
      value: null,
    };
  }

  return {
    kind: 'resize',
    title: 'Resize',
    subtitle: 'Drag the handle',
    value: label,
  };
};

const CONFIG = {
  resize: {
    icon: Scaling,
    tone: 'text-amber-300 bg-amber-400/10 border-amber-300/20',
    accent: 'text-amber-200',
    chip: 'IN / OUT',
  },
  move: {
    icon: Move,
    tone: 'text-emerald-300 bg-emerald-400/10 border-emerald-300/20',
    accent: 'text-emerald-200',
    chip: 'X / Z plane',
  },
  rotate: {
    icon: RotateCw,
    tone: 'text-sky-300 bg-sky-400/10 border-sky-300/20',
    accent: 'text-sky-200',
    chip: 'drag arc',
  },
};

export const StretchTooltipOverlay = ({ visible, x, y, label }) => {
  if (!visible || !label) return null;

  const parsed = parseStretchLabel(label);
  const config = CONFIG[parsed.kind] || CONFIG.resize;
  const Icon = config.icon;

  return (
    <div
      className="fixed pointer-events-none z-[9999] min-w-[190px] max-w-[280px] rounded-2xl border border-white/10 bg-slate-950/95 px-3 py-2.5 text-white shadow-[0_14px_40px_rgba(0,0,0,0.48)] backdrop-blur-xl transition-all duration-75 animate-in fade-in zoom-in-95"
      style={{
        left: `${x + 20}px`,
        top: `${y - 18}px`,
      }}
    >
      <div className="flex items-start gap-2.5">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${config.tone}`}>
          <Icon className="h-4 w-4" strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[11px] font-semibold tracking-wide text-slate-100">{parsed.title}</span>
            <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-slate-500">
              {config.chip}
            </span>
          </div>
          <div className="mt-0.5 text-[9px] text-slate-400">{parsed.subtitle}</div>
          {parsed.value && (
            <div className={`mt-1.5 font-mono text-[10px] font-semibold ${config.accent}`}>
              {parsed.value}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
