import React from 'react';
import { Move, Rotate3D, Maximize2, Trash2, LockKeyhole } from 'lucide-react';

const rows = [
  { key: 'W', label: 'Move', Icon: Move, tone: 'emerald' },
  { key: 'E', label: 'Rotate', Icon: Rotate3D, tone: 'blue' },
  { key: 'R', label: 'Scale', Icon: Maximize2, tone: 'amber' },
];

const tones = {
  emerald: 'text-emerald-400',
  blue: 'text-blue-400',
  amber: 'text-amber-400',
};

export const TransformModesHelp = ({ isDarkMode = true }) => (
  <aside
    className={[
      'w-[196px] rounded-[14px] border backdrop-blur-xl shadow-2xl transition-colors duration-200',
      isDarkMode
        ? 'bg-[#07111d]/92 border-slate-700/80 shadow-black/35'
        : 'bg-white/94 border-slate-200 shadow-slate-900/10',
    ].join(' ')}
    aria-label="Transformation shortcuts"
  >
    <div className="px-4 pt-3.5 pb-2">
      <div className={`text-[10px] font-semibold tracking-[0.08em] uppercase ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
        Transformation Modes
      </div>
    </div>

    <div className={`px-2 pb-2 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
      {rows.map(({ key, label, Icon, tone }) => (
        <div key={key} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg">
          <Icon className={`w-[18px] h-[18px] shrink-0 ${tones[tone]}`} strokeWidth={2.1} />
          <span className={`text-[12px] font-medium flex-1 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>{label}</span>
          <kbd className={`min-w-[24px] h-[22px] px-1.5 inline-flex items-center justify-center rounded-md text-[10px] font-semibold border ${isDarkMode ? 'bg-slate-900/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-600'}`}>
            {key}
          </kbd>
        </div>
      ))}
    </div>

    <div className={`mx-3 border-t ${isDarkMode ? 'border-slate-800' : 'border-slate-200'}`} />

    <div className="px-4 pt-3 pb-3">
      <div className={`text-[9px] font-semibold uppercase tracking-[0.08em] mb-2 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
        Shortcuts
      </div>
      <div className="space-y-1.5">
        <Shortcut keyName="W" label="Move" isDarkMode={isDarkMode} />
        <Shortcut keyName="E" label="Rotate" isDarkMode={isDarkMode} />
        <Shortcut keyName="R" label="Scale" isDarkMode={isDarkMode} />
        <Shortcut Icon={Trash2} label="Delete" isDarkMode={isDarkMode} />
        <Shortcut Icon={LockKeyhole} label="Unlock" isDarkMode={isDarkMode} />
      </div>
    </div>
  </aside>
);

function Shortcut({ keyName, Icon, label, isDarkMode }) {
  return (
    <div className="flex items-center gap-2.5">
      {keyName ? (
        <kbd className={`w-[27px] h-[22px] inline-flex items-center justify-center rounded-md border text-[10px] font-semibold ${isDarkMode ? 'bg-slate-900/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-600'}`}>
          {keyName}
        </kbd>
      ) : (
        <div className={`w-[27px] h-[22px] flex items-center justify-center rounded-md border ${isDarkMode ? 'bg-slate-900/80 border-slate-700 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-500'}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      )}
      <span className={`text-[11px] ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>{label}</span>
    </div>
  );
}
