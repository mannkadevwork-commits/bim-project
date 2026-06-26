import { Ruler, X, Trash2, MapPin, Magnet, ArrowLeftRight, Axis3d } from 'lucide-react';

// ── Coohom-style Measurement Panel ──────────────────────────────
// Floats in the top area of the canvas while measurement mode is on.
// Shows every segment created so far (not just the last one), with:
//   - per-segment length, a "fly to" button, and a delete button
//   - a running total across all segments
//   - a unit toggle (m / ft)
//   - a snap-to-vertex/edge toggle (xeokit's built-in snapping)
export const MeasurementPanel = ({
  measurementsList,
  measurementUnit,
  setMeasurementUnit,
  snappingEnabled,
  toggleSnapping,
  axisBreakdownVisible,
  toggleAxisBreakdown,
  formatLength,
  totalMeasuredLength,
  deleteMeasurement,
  flyToMeasurement,
  clearMeasurements,
  onClose,
}) => {
  return (
    <div className="absolute top-20 right-4 z-40 w-72 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-right-4 fade-in duration-300">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-center gap-2">
          <Ruler className="w-4 h-4 text-cyan-500" />
          <h3 className="text-sm font-bold text-slate-800 dark:text-white">Measurements</h3>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Controls row: unit toggle + snap toggle */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 gap-2">
        <button
          onClick={() => setMeasurementUnit(measurementUnit === 'm' ? 'ft' : 'm')}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          title="Toggle units"
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
          {measurementUnit === 'm' ? 'Meters' : 'Feet'}
        </button>

        <button
          onClick={toggleSnapping}
          className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${
            snappingEnabled
              ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400'
              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
          }`}
          title="Toggle snap-to-vertex/edge"
        >
          <Magnet className="w-3.5 h-3.5" />
          Snap {snappingEnabled ? 'On' : 'Off'}
        </button>
      </div>

      {/* Axis breakdown toggle — off by default for the clean Coohom-style
          single line; turn on to see the X/Y/Z component wires xeokit
          draws natively for every measurement. */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-800">
        <span className="text-xs text-slate-500 dark:text-slate-400">Show X/Y/Z breakdown</span>
        <button
          onClick={toggleAxisBreakdown}
          className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${
            axisBreakdownVisible
              ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
          }`}
        >
          <Axis3d className="w-3.5 h-3.5" />
          {axisBreakdownVisible ? 'On' : 'Off'}
        </button>
      </div>

      {/* Measurement list */}
      <div className="max-h-64 overflow-y-auto">
        {measurementsList.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
            Click two points on the model to start measuring.
          </div>
        ) : (
          measurementsList.map((m, idx) => (
            <div
              key={m.id}
              className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors group"
            >
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                  {idx + 1}
                </span>
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  {formatLength(m.lengthMeters)}
                </span>
              </div>

              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => flyToMeasurement(m.midpoint)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-slate-800"
                  title="Fly to this measurement"
                >
                  <MapPin className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => deleteMeasurement(m.id)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-slate-800"
                  title="Delete this measurement"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer: total + clear all */}
      {measurementsList.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div>
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold block">Total</span>
            <span className="text-sm font-bold text-slate-800 dark:text-white">
              {formatLength(totalMeasuredLength)}
            </span>
          </div>
          <button
            onClick={clearMeasurements}
            className="text-xs font-bold text-rose-500 hover:text-rose-600 uppercase tracking-wider transition-colors"
          >
            Clear All
          </button>
        </div>
      )}
    </div>
  );
};
