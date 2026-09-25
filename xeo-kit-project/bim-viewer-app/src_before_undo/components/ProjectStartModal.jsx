import { ArrowRight, FolderOpen, Plus, RotateCcw, X } from 'lucide-react';

const ProjectStartModal = ({
  isOpen,
  previousProject,
  onContinue,
  onStartNew,
  onClose,
  isContinuing,
}) => {
  if (!isOpen) return null;

  const previousName = previousProject?.fileName || 'Previous BIM project';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 backdrop-blur-md p-4">
      <div className="relative w-full max-w-3xl overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl">
        <div className="absolute -right-32 -top-32 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-32 h-72 w-72 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

        <div className="relative p-8 sm:p-10">
          <div className="flex items-start justify-between gap-6">
            <div className="flex items-center gap-3">
              <img src="/hci-logo.svg" alt="High Creation Interiors" className="hci-logo-badge hci-logo-badge--modal" />
              <div>
              <p className="text-xs font-bold tracking-[0.24em] uppercase text-[#ff914d]">HIGH CREATION INTERIORS</p>
              <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold text-white">How would you like to start?</h2>
              <p className="mt-3 max-w-2xl text-sm sm:text-base leading-relaxed text-slate-400">
                Continue your previous workspace or start a completely fresh project.
              </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              disabled={isContinuing}
              className="shrink-0 rounded-full border border-slate-700 bg-slate-900/80 p-2 text-slate-400 hover:text-white hover:border-slate-600 transition-colors disabled:opacity-50"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={onContinue}
              disabled={isContinuing}
              className="group rounded-2xl border border-cyan-400/30 bg-cyan-400/5 p-6 text-left transition-all hover:-translate-y-0.5 hover:border-cyan-300/60 hover:bg-cyan-400/10 disabled:cursor-wait disabled:opacity-70"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300">
                  {isContinuing ? <RotateCcw className="h-6 w-6 animate-spin" /> : <FolderOpen className="h-6 w-6" />}
                </div>
                <ArrowRight className="h-5 w-5 text-slate-500 transition-transform group-hover:translate-x-1 group-hover:text-cyan-300" />
              </div>

              <h3 className="mt-6 text-xl font-bold text-white">Continue previous work</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                Reopen your last saved workspace exactly where you left it.
              </p>

              <div className="mt-5 rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">Last project</p>
                <p className="mt-1 truncate text-sm font-semibold text-cyan-300">{previousName}</p>
              </div>
            </button>

            <button
              type="button"
              onClick={onStartNew}
              disabled={isContinuing}
              className="group rounded-2xl border border-slate-700 bg-slate-900/70 p-6 text-left transition-all hover:-translate-y-0.5 hover:border-[#ff914d]/50 hover:bg-[#ff914d]/5 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#ff914d]/10 text-[#ff914d]">
                  <Plus className="h-6 w-6" />
                </div>
                <ArrowRight className="h-5 w-5 text-slate-500 transition-transform group-hover:translate-x-1 group-hover:text-[#ff914d]" />
              </div>

              <h3 className="mt-6 text-xl font-bold text-white">Start a new project</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                Choose a 1 BHK or 3 BHK template, or upload your own floor plan / IFC model.
              </p>

              <div className="mt-5 flex items-center gap-2 text-xs font-semibold text-slate-300">
                <span className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1">1 BHK</span>
                <span className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1">3 BHK</span>
                <span className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1">Upload</span>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectStartModal;
