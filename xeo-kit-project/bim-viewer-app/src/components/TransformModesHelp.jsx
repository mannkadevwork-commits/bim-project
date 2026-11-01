import React, { useState } from 'react';
import {
  CircleHelp,
  X,
  Sparkles,
  PackagePlus,
  MousePointerClick,
  Palette,
  Save,
  ArrowRight,
  Camera,
  Orbit,
} from 'lucide-react';

const GUIDE_SEEN_KEY = 'hci_editor_workspace_guide_seen_v1';

function shouldShowGuideInitially() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GUIDE_SEEN_KEY) !== '1';
  } catch {
    return true;
  }
}

export const TransformModesHelp = ({
  isDarkMode = true,
  onOpenModel,
  onOpenItems,
  onOpenDesigns,
  onShowOverview,
  onOpenRender,
  hasSelection = false,
  selectedName = '',
  onShowAppearance,
  onFocusSelection,
}) => {
  const [open, setOpen] = useState(shouldShowGuideInitially);

  const markGuideSeen = () => {
    try { window.localStorage.setItem(GUIDE_SEEN_KEY, '1'); }
    catch { /* The guide still works when browser storage is disabled. */ }
  };

  const closeGuide = () => {
    setOpen(false);
    markGuideSeen();
  };

  const runStepAction = (action) => {
    if (typeof action === 'function') action();
    closeGuide();
  };

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
        <span className="text-[11px] font-semibold">Start here</span>
      </button>
    );
  }

  const steps = [
    {
      Icon: Camera,
      title: 'See the whole home',
      text: 'Start with an angled overview of the complete loaded building and its placed furniture.',
      action: 'Frame whole home',
      onClick: onShowOverview,
    },
    {
      Icon: PackagePlus,
      title: 'Explore and furnish',
      text: 'Browse the building tree or add furniture from the catalogue. Select an item to edit its size, position and finish in Properties.',
      actions: [
        { label: 'Open model', onClick: onOpenModel },
        { label: 'Browse items', onClick: onOpenItems },
      ],
    },
    {
      Icon: Palette,
      title: 'Make it yours',
      text: 'Apply a color, fabric or texture; use the top-bar Undo and Redo controls to compare changes.',
      action: null,
    },
    {
      Icon: Orbit,
      title: 'Preview and present',
      text: 'Review the finished design in an interactive walkthrough, then save a reusable layout when it is ready.',
      action: 'Open walkthrough',
      onClick: onOpenRender || onOpenDesigns,
    },
  ];

  return (
    <aside className={`w-[min(326px,calc(100vw-2rem))] overflow-hidden rounded-2xl border backdrop-blur-2xl shadow-2xl ${shell}`} aria-label="Getting started guide">
      <div className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${isDarkMode ? 'border-slate-700/80' : 'border-slate-200'}`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#ff914d]/15 text-[#ff914d]"><Sparkles className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold">Your design workspace</h2>
            <p className={`mt-0.5 text-[10px] ${secondary}`}>Three minutes to get comfortable</p>
          </div>
        </div>
        <button type="button" onClick={closeGuide} aria-label="Close getting started guide" title="Close guide" className={`rounded-lg p-1.5 transition ${isDarkMode ? 'text-slate-400 hover:bg-white/10 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {hasSelection && (
        <div className={`mx-3 mt-3 rounded-xl border p-3 ${isDarkMode ? 'border-orange-400/25 bg-orange-500/[0.07]' : 'border-orange-200 bg-orange-50/80'}`}>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#ff914d]/15 text-[#ff914d]"><Palette className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className={`text-[9px] font-bold uppercase tracking-[0.14em] ${isDarkMode ? 'text-orange-200' : 'text-[#a94312]'}`}>Currently selected</p>
              <p className={`mt-0.5 truncate text-xs font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`} title={selectedName}>{selectedName || 'Selected element'}</p>
              <p className={`mt-1 text-[10px] leading-4 ${secondary}`}>Next: adjust the object, customize its finish, then preview the design.</p>
            </div>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            {onShowAppearance && <button type="button" onClick={() => runStepAction(onShowAppearance)} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#ff914d] px-2 py-2 text-[10px] font-bold text-white transition hover:bg-[#ff7a28]"><Palette className="h-3 w-3" /> Customize finish</button>}
            {onOpenRender && <button type="button" onClick={() => runStepAction(onOpenRender)} className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[10px] font-bold transition ${actionButton}`}><Camera className="h-3 w-3" /> Preview design</button>}
          </div>
          {onFocusSelection && <button type="button" onClick={onFocusSelection} className={`mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-semibold transition ${isDarkMode ? 'text-slate-300 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-white hover:text-slate-900'}`}><Orbit className="h-3 w-3" /> Focus selected object</button>}
        </div>
      )}

      <div className="max-h-[min(64vh,520px)] space-y-2 overflow-y-auto p-3">
        {steps.map(({ Icon, title, text, action, onClick, actions }, index) => (
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
                {actions && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {actions.filter((item) => typeof item.onClick === 'function').map((item) => (
                      <button key={item.label} type="button" onClick={() => runStepAction(item.onClick)} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-bold transition ${actionButton}`}>
                        {item.label} <ArrowRight className="h-3 w-3" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        ))}
      </div>

      <div className={`flex items-start gap-2 border-t px-4 py-3 ${isDarkMode ? 'border-slate-700/80' : 'border-slate-200'}`}>
        <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#ff914d]" />
        <div className="min-w-0">
          <p className="text-[10px] font-semibold">Quick tip</p>
          <p className={`mt-0.5 text-[10px] leading-4 ${secondary}`}>Select an element to open its Properties. Use Undo/Redo in the top bar; Save design is in the right panel.</p>
          <button type="button" onClick={() => { closeGuide(); onOpenDesigns?.(); }} className={`mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold ${isDarkMode ? 'text-orange-300 hover:text-orange-200' : 'text-[#c85b1f] hover:text-[#a94312]'}`}>
            Open saved designs <ArrowRight className="h-3 w-3" />
          </button>
        </div>
        <Save className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${secondary}`} />
      </div>
    </aside>
  );
};
