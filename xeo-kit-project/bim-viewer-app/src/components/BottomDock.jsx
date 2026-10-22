import {
  Plus,
  Orbit,
  Expand,
  Shrink,
  Minimize,
  Maximize,
  Trash2,
  Ruler,
} from 'lucide-react';

export const BottomDock = ({
  onAdd,
  onDelete,
  onRenderClick,
  toggleMaxView,
  isMaxView,
  isFullscreen,
  toggleBrowserFullscreen,
  isMeasuring,
  toggleMeasurementMode,
  isDarkMode = true,
}) => {
  const shell = isDarkMode
    ? 'border-slate-700/80 bg-[#0b1322]/92 text-slate-100 shadow-[0_14px_40px_rgba(0,0,0,0.32)]'
    : 'border-white/80 bg-white/92 text-slate-700 shadow-[0_12px_36px_rgba(15,23,42,0.16)]';
  const divider = isDarkMode ? 'bg-slate-700/80' : 'bg-slate-200';
  const idle = isDarkMode
    ? 'text-slate-300 hover:bg-white/[0.08] hover:text-white'
    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950';
  const button = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 text-[11px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d]';
  const label = 'hidden xl:inline';
  const separator = <span aria-hidden="true" className={`mx-0.5 h-6 w-px shrink-0 ${divider}`} />;

  return (
    <div className={`pointer-events-auto flex max-w-[calc(100vw-1.5rem)] flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain rounded-2xl border px-2 py-2 backdrop-blur-2xl ${shell}`} aria-label="Model actions">
      <button type="button" onClick={onAdd} className={`${button} ${idle}`} title="Import or open a building model" aria-label="Import model">
        <Plus className="h-4.5 w-4.5 shrink-0" />
        <span className={label}>Import model</span>
      </button>

      {separator}

      <button
        type="button"
        onClick={toggleMeasurementMode}
        aria-pressed={!!isMeasuring}
        className={`${button} ${isMeasuring ? 'bg-[#ff914d] text-white shadow-md shadow-orange-500/20' : idle}`}
        title="Measure distances in the model"
        aria-label="Measure distances"
      >
        <Ruler className="h-4.5 w-4.5 shrink-0" />
        <span className={label}>Measure</span>
      </button>

      {separator}

      <button type="button" onClick={onRenderClick} className={`${button} ${isDarkMode ? 'text-orange-300 hover:bg-orange-400/10 hover:text-orange-200' : 'text-[#c85b1f] hover:bg-orange-50 hover:text-[#a94312]'}`} title="Create a still render or interactive 360° walkthrough" aria-label="Render and walkthrough">
        <Orbit className="h-4.5 w-4.5 shrink-0" />
        <span className={label}>Render & walkthrough</span>
      </button>

      {separator}

      <button type="button" onClick={toggleMaxView} aria-pressed={!!isMaxView} className={`${button} ${isMaxView ? 'bg-[#ff914d] text-white shadow-md shadow-orange-500/20' : idle}`} title={isMaxView ? 'Show the side panels again' : 'Give the model more space'} aria-label={isMaxView ? 'Show side panels' : 'Focus on model'}>
        {isMaxView ? <Shrink className="h-4.5 w-4.5 shrink-0" /> : <Expand className="h-4.5 w-4.5 shrink-0" />}
        <span className={label}>{isMaxView ? 'Show panels' : 'Focus view'}</span>
      </button>

      <button type="button" onClick={toggleBrowserFullscreen} className={`${button} ${idle}`} title={isFullscreen ? 'Exit full screen' : 'Expand the editor to full screen'} aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}>
        {isFullscreen ? <Minimize className="h-4.5 w-4.5 shrink-0" /> : <Maximize className="h-4.5 w-4.5 shrink-0" />}
        <span className={label}>{isFullscreen ? 'Exit full screen' : 'Full screen'}</span>
      </button>

      {separator}

      <button type="button" onClick={onDelete} className={`${button} ${isDarkMode ? 'text-rose-300 hover:bg-rose-500/10 hover:text-rose-200' : 'text-rose-600 hover:bg-rose-50 hover:text-rose-700'}`} title="Remove the current project and start fresh" aria-label="Delete current project">
        <Trash2 className="h-4.5 w-4.5 shrink-0" />
        <span className={label}>Delete project</span>
      </button>
    </div>
  );
};
