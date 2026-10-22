import React, { useState } from 'react';
import {
  CircleHelp,
  X,
  Sparkles,
  PackagePlus,
  MousePointerClick,
  Palette,
  Save,
  Undo2,
  ArrowRight,
  Layers,
} from 'lucide-react';

export const TransformModesHelp = ({
  isDarkMode = true,
  onOpenModel,
  onOpenItems,
  onOpenDesigns,
}) => {
  const [open, setOpen] = useState(false);

  const shell = isDarkMode
    ? 'border-slate-700/80 bg-[#0b1322]/95 text-slate-100 shadow-black/30'
    : 'border-slate-200 bg-white/96 text-slate-800 shadow-slate-900/15';
  const secondary = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const stepCard = isDarkMode
    ? 'border-slate-700/80 bg-white/[0.035] hover:bg-white/[0.06]'
    : 'border-slate-200 bg-slate-50 hover:bg-orange-50/70';
  const actionButton = isDarkMode
    ? 'border-slate-700 bg-slate-800 text-slate-200 hover:border-orange-400/60 hover:bg-orange-500/10'
    : 'border-slate-200 bg-white text-slate-700 hover:border-orange-300 hover:bg-orange-50';

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open getting started guide"
        title="Getting started"
        className={`group flex h-10 items-center gap-2 rounded-xl border px-3 backdrop-blur-xl shadow-lg transition hover:-translate-y-0.5 ${shell}`}
      >
        <CircleHelp className="h-[18px] w-[18px] text-[#ff914d] transition-transform group-hover:rotate-12" strokeWidth={2} />
        <span className="text-[11px] font-semibold">Help</span>
      </button>
    );
  }

  const runStepAction = (action) => {
    if (typeof action === 'function') action();
    setOpen(false);
  };

  const steps = [
    {
      Icon: Layers,
      title: 'Explore your building',
      text: 'Choose a wall, door or room in the model list, or select it in the 3D view.',
      action: 'Open Model',
      onClick: onOpenModel,
    },
    {
      Icon: PackagePlus,
      title: 'Add furniture or doors',
      text: 'Choose an item, then click in the model or drag it into the room.',
      action: 'Browse items',
      onClick: onOpenItems,
    },
    {
      Icon: Palette,
      title: 'Make it yours',
      text: 'Select something to change its position, size, color or surface finish.',
      action: null,
    },
    {
      Icon: Save,
      title: 'Save your progress',
      text: 'Use Save design in the right panel. Undo and Redo are available in the top toolbar.',
      action: 'Open Designs',
      onClick: onOpenDesigns,
    },
  ];

  return (
    <aside className={`w-[min(292px,calc(100vw-2rem))] overflow-hidden rounded-2xl border backdrop-blur-2xl shadow-2xl ${shell}`} aria-label="Getting started guide">
      <div className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${isDarkMode ? 'border-slate-700/80' : 'border-slate-200'}`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#ff914d]/15 text-[#ff914d]"><Sparkles className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold">Getting started</h2>
            <p className={`mt-0.5 text-[10px] ${secondary}`}>Your design, one easy step at a time</p>
          </div>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close getting started guide" title="Close guide" className={`rounded-lg p-1.5 transition ${isDarkMode ? 'text-slate-400 hover:bg-white/10 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-2.5 p-3">
        {steps.map(({ Icon, title, text, action, onClick }, index) => (
          <section key={title} className={`rounded-xl border p-3 transition-colors ${stepCard}`}>
            <div className="flex items-start gap-2.5">
              <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${isDarkMode ? 'bg-slate-700/80 text-orange-300' : 'bg-orange-100 text-[#c85b1f]'}`}>
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[11px] font-bold">{index + 1}. {title}</h3>
                <p className={`mt-1 text-[10px] leading-4 ${secondary}`}>{text}</p>
                {action && onClick && (
                  <button type="button" onClick={() => runStepAction(onClick)} className={`mt-2 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-bold transition ${actionButton}`}>
                    {action} <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          </section>
        ))}
      </div>
      <div className={`flex items-center gap-2 border-t px-4 py-2.5 ${isDarkMode ? 'border-slate-700/80' : 'border-slate-200'}`}>
        <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-[#ff914d]" />
        <p className={`text-[10px] leading-4 ${secondary}`}>Tip: hover over a button to see what it does.</p>
      </div>
    </aside>
  );
};
