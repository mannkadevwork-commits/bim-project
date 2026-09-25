import { useEffect, useState } from 'react';
import {
  Ruler,
  X,
  Trash2,
  MapPin,
  Magnet,
  Wand2,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Move3d,
  CheckCircle2,
  MousePointer2,
  MoveHorizontal,
  MoveVertical,
} from 'lucide-react';

const UNIT_OPTIONS = [
  { value: 'mm', label: 'mm' },
  { value: 'cm', label: 'cm' },
  { value: 'm', label: 'm' },
  { value: 'ft', label: 'ft' },
];

const toMeters = (value, unit) => {
  if (!Number.isFinite(value)) return NaN;
  if (unit === 'mm') return value / 1000;
  if (unit === 'cm') return value / 100;
  if (unit === 'ft') return value / 3.28084;
  return value;
};

const MeasurementRow = ({
  m,
  idx,
  formatLength,
  deleteMeasurement,
  flyToMeasurement,
  showComponents,
  isCalibrationSource,
  onUseForCalibration,
}) => {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className={`border-b border-slate-100 dark:border-slate-800/60 transition-colors ${isCalibrationSource ? 'bg-amber-50/50 dark:bg-amber-950/10' : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/30'}`}>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-5 h-5 rounded-full bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400 text-[10px] font-bold flex items-center justify-center shrink-0">
              {idx + 1}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-800 dark:text-white tabular-nums">
                {formatLength(m.lengthMeters)}
              </div>
              <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                {m.measurementKind === 'orthogonal' ? `${m.orthogonalConstraint === 'vertical' ? 'Vertical' : 'Horizontal'} distance` : m.measurementKind === 'point' ? 'Free point-to-point' : 'Reference-to-reference'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onUseForCalibration(m.id)}
              className={`p-1.5 rounded-lg transition-colors ${isCalibrationSource ? 'text-[var(--hci-orange)] bg-[var(--hci-orange-soft)] dark:text-[var(--hci-orange)] dark:bg-orange-950/20' : 'text-slate-400 hover:text-[var(--hci-orange)] hover:bg-[var(--hci-orange-soft)] dark:hover:bg-slate-800'}`}
              title={isCalibrationSource ? 'Using this measurement for scene calibration' : 'Use this measurement as calibration reference'}
            >
              <Wand2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-600 hover:bg-cyan-50 dark:hover:bg-slate-800"
              title={showDetails ? 'Hide measurement details' : 'Show measurement details'}
            >
              {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => flyToMeasurement(m.midpoint)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-slate-800"
              title="Focus this measurement"
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

        {isCalibrationSource && (
          <div className="mt-2 ml-7 inline-flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
            <CheckCircle2 className="w-3 h-3" />
            Calibration reference selected
          </div>
        )}

        {showDetails && (
          <div className="mt-3 ml-7 space-y-1.5 text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md bg-slate-100/80 dark:bg-slate-800/70 px-2 py-1.5">
                <span className="block uppercase tracking-wider text-[9px] text-slate-400">Plan XZ</span>
                <span className="font-semibold">{formatLength(m.planDistanceMeters)}</span>
              </div>
              <div className="rounded-md bg-slate-100/80 dark:bg-slate-800/70 px-2 py-1.5">
                <span className="block uppercase tracking-wider text-[9px] text-slate-400">Vertical Y</span>
                <span className="font-semibold">{formatLength(m.verticalDistanceMeters)}</span>
              </div>
            </div>
            <div className="rounded-md bg-slate-100/80 dark:bg-slate-800/70 px-2 py-1.5">
              <span className="block uppercase tracking-wider text-[9px] text-slate-400">Elevation Δ</span>
              <span className="font-semibold">
                {m.elevationDeltaMeters >= 0 ? '+' : '-'}{formatLength(Math.abs(m.elevationDeltaMeters))}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md bg-slate-100/80 dark:bg-slate-800/70 px-2 py-1.5">
                <span className="block uppercase tracking-wider text-[9px] text-slate-400">Origin</span>
                <span className="font-mono text-[9px]">{m.origin.map((v) => v.toFixed(3)).join(', ')}</span>
              </div>
              <div className="rounded-md bg-slate-100/80 dark:bg-slate-800/70 px-2 py-1.5">
                <span className="block uppercase tracking-wider text-[9px] text-slate-400">Target</span>
                <span className="font-mono text-[9px]">{m.target.map((v) => v.toFixed(3)).join(', ')}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const MeasurementPanel = ({
  measurementsList,
  measurementUnit,
  setMeasurementUnit,
  snappingEnabled,
  toggleSnapping,
  axisBreakdownVisible,
  toggleAxisBreakdown,
  formatLength,
  deleteMeasurement,
  flyToMeasurement,
  clearMeasurements,
  scaleModelByMeasurement,
  sceneScaleFactor,
  measurementPhase,
  measurementMode,
  setMeasurementMode,
  orthogonalConstraint,
  setOrthogonalConstraint,
  onClose,
}) => {
  const [showCalibration, setShowCalibration] = useState(false);
  const [calibrationMeasurementId, setCalibrationMeasurementId] = useState(null);
  const [desiredLength, setDesiredLength] = useState('');
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationError, setCalibrationError] = useState('');
  const [calibrationSuccess, setCalibrationSuccess] = useState('');

  const incomplete = measurementPhase === 'selecting-target';
  const calibrationMeasurement = measurementsList.find((m) => m.id === calibrationMeasurementId) || null;

  useEffect(() => {
    if (calibrationMeasurementId && !calibrationMeasurement) {
      setCalibrationMeasurementId(null);
      setDesiredLength('');
      setShowCalibration(false);
      return;
    }

    // Selecting a calibration reference should immediately expose the action area.
    // This prevents the reference from being selected while the actual calibration
    // controls remain hidden below the fold.
    if (calibrationMeasurementId && calibrationMeasurement) {
      setShowCalibration(true);
    }
  }, [calibrationMeasurementId, calibrationMeasurement]);

  const handleUseForCalibration = (id) => {
    setCalibrationError('');
    setCalibrationSuccess('');

    // The wand is a true toggle: clicking the active reference again clears it.
    if (calibrationMeasurementId === id) {
      setCalibrationMeasurementId(null);
      setDesiredLength('');
      return;
    }

    setCalibrationMeasurementId(id);
    setDesiredLength('');
    setShowCalibration(true);
  };

  const clearCalibrationReference = () => {
    if (calibrationBusy) return;
    setCalibrationMeasurementId(null);
    setDesiredLength('');
    setCalibrationError('');
    setCalibrationSuccess('');
  };

  const handleRescale = async () => {
    if (!calibrationMeasurement || calibrationBusy) return;

    const value = Number.parseFloat(desiredLength);
    if (!Number.isFinite(value) || value <= 0) {
      setCalibrationError('Enter a valid real-world length greater than 0.');
      setCalibrationSuccess('');
      return;
    }

    const meters = toMeters(value, measurementUnit);
    if (!Number.isFinite(meters) || meters <= 0) {
      setCalibrationError('The calibration length could not be converted to meters.');
      setCalibrationSuccess('');
      return;
    }

    const ratio = meters / calibrationMeasurement.lengthMeters;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      setCalibrationError('Calibration factor is invalid.');
      setCalibrationSuccess('');
      return;
    }

    setCalibrationBusy(true);
    setCalibrationError('');
    setCalibrationSuccess('');

    try {
      const result = await scaleModelByMeasurement(calibrationMeasurement.id, meters);

      if (!result?.success) {
        throw new Error(result?.error || 'Calibration request failed.');
      }

      setCalibrationSuccess(`Scene calibrated ×${ratio.toFixed(4)}.`);
      setCalibrationMeasurementId(null);
      setDesiredLength('');
      // Keep the panel open so the success state is visible.
    } catch (error) {
      console.error('[Measurement UI] Calibration failed:', error);
      setCalibrationError(error?.message || 'Calibration failed. No scene changes were confirmed.');
    } finally {
      setCalibrationBusy(false);
    }
  };

  return (
    <div className="measurement-panel absolute top-0 right-0 bottom-0 z-[60] w-[390px] h-full max-h-full bg-white/98 dark:bg-slate-950/98 backdrop-blur-2xl border-l border-slate-200/90 dark:border-slate-800 shadow-[-18px_0_50px_rgba(2,6,23,0.18)] overflow-hidden flex flex-col animate-in slide-in-from-right-4 fade-in duration-300">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-200/80 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-900/80 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#ff914d]/10 dark:bg-[#ff914d]/[0.12] flex items-center justify-center">
            <Ruler className="w-4 h-4 text-[#ff914d]" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-800 dark:text-white">Measurements</h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500">
              {measurementMode === 'point' ? (incomplete ? 'Select the target point' : 'Pick two points on the model') : measurementMode === 'orthogonal' ? (incomplete ? 'Select the target for the constrained distance' : 'Pick two points for an orthogonal distance') : (incomplete ? 'Select the second reference' : 'Select two references')}
            </p>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" title="Close measurement tool">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
            <Crosshair className={`w-3.5 h-3.5 ${incomplete ? 'text-cyan-500 animate-pulse' : 'text-emerald-500'}`} />
            {incomplete ? 'Measurement in progress' : 'Ready for next measurement'}
          </div>
          <span className="text-[9px] uppercase tracking-wider font-bold text-slate-400">Esc cancels</span>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-3 shrink-0">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-1.5">Measure mode</div>
          <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
            <button
              onClick={() => setMeasurementMode('point')}
              className={`flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-[10px] font-bold transition-colors ${measurementMode === 'point' ? 'bg-white dark:bg-slate-700 text-[#ff914d] dark:text-[#ffb27e] shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
            >
              <MousePointer2 className="w-3.5 h-3.5" />
              Point
            </button>
            <button
              onClick={() => setMeasurementMode('reference')}
              className={`flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-[10px] font-bold transition-colors ${measurementMode === 'reference' ? 'bg-white dark:bg-slate-700 text-[#ff914d] dark:text-[#ffb27e] shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
            >
              <Crosshair className="w-3.5 h-3.5" />
              Reference
            </button>
            <button
              onClick={() => setMeasurementMode('orthogonal')}
              className={`flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[10px] font-bold transition-colors ${measurementMode === 'orthogonal' ? 'bg-white dark:bg-slate-700 text-[#ff914d] dark:text-[#ffb27e] shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
              title="Measure a plan or vertical distance"
            >
              <Move3d className="w-3.5 h-3.5" />
              Ortho
            </button>
          </div>
          <div className="mt-1.5 text-[9px] leading-4 text-slate-400">
            {measurementMode === 'point' ? 'Snap directly to vertices, edges, or any visible surface point.' : measurementMode === 'orthogonal' ? 'Constrain the result to plan (XZ) or vertical (Y) distance.' : 'Use Xeokit reference picking for model-to-model measurements.'}
          </div>

          {measurementMode === 'orthogonal' && (
            <div className="mt-2 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setOrthogonalConstraint('horizontal')}
                  className={`flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[10px] font-bold transition-colors ${orthogonalConstraint === 'horizontal' ? 'bg-white dark:bg-slate-700 text-[#ff914d] dark:text-[#ffb27e] shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
                >
                  <MoveHorizontal className="w-3.5 h-3.5" />
                  Horizontal
                </button>
                <button
                  type="button"
                  onClick={() => setOrthogonalConstraint('vertical')}
                  className={`flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[10px] font-bold transition-colors ${orthogonalConstraint === 'vertical' ? 'bg-white dark:bg-slate-700 text-[#ff914d] dark:text-[#ffb27e] shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
                >
                  <MoveVertical className="w-3.5 h-3.5" />
                  Vertical
                </button>
              </div>
              <div className="px-1 pt-1.5 text-[9px] leading-4 text-slate-400">
                {orthogonalConstraint === 'horizontal' ? 'Measures plan distance on XZ while keeping the first point elevation.' : 'Measures elevation difference on Y while keeping the first point position in plan.'}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Display units</div>
            <div className="text-[10px] text-slate-400 mt-0.5">Updates 3D labels and measurements</div>
          </div>
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 shrink-0">
            {UNIT_OPTIONS.map((unit) => (
              <button
                key={unit.value}
                onClick={() => setMeasurementUnit(unit.value)}
                className={`px-2 py-1 rounded-md text-[10px] font-bold transition-colors ${
                  measurementUnit === unit.value
                    ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                }`}
              >
                {unit.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleSnapping}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors ${
              snappingEnabled
                ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400'
                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
            }`}
            title="Toggle vertex/edge reference snapping"
          >
            <Magnet className="w-3.5 h-3.5" />
            Snap {snappingEnabled ? 'On' : 'Off'}
          </button>

          <button
            onClick={toggleAxisBreakdown}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors ${
              axisBreakdownVisible
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
            }`}
            title="Show X/Y/Z components"
          >
            <Move3d className="w-3.5 h-3.5" />
            XYZ {axisBreakdownVisible ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      <div className="measurement-panel-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="measurement-list">
        {measurementsList.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Ruler className="w-7 h-7 mx-auto text-slate-300 dark:text-slate-700 mb-2" />
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">No measurements yet</div>
            <div className="text-[10px] leading-4 text-slate-400 dark:text-slate-500 mt-1">
              {measurementMode === 'point' ? 'Click any visible model point, then click the target point.' : measurementMode === 'orthogonal' ? `Choose ${orthogonalConstraint === 'horizontal' ? 'Horizontal' : 'Vertical'}, then click the two references.` : 'Select a first reference and a second reference in the model.'}
            </div>
          </div>
        ) : (
          measurementsList.map((m, idx) => (
            <MeasurementRow
              key={m.id}
              m={m}
              idx={idx}
              formatLength={formatLength}
              deleteMeasurement={deleteMeasurement}
              flyToMeasurement={flyToMeasurement}
              showComponents={axisBreakdownVisible}
              isCalibrationSource={m.id === calibrationMeasurementId}
              onUseForCalibration={handleUseForCalibration}
            />
          ))
        )}
      </div>

        </div>

      {measurementsList.length > 0 && (
        <div className="px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-900/90 flex items-center justify-between gap-3">
          <div>
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold block">Measurements</span>
            <span className="text-sm font-bold text-slate-800 dark:text-white tabular-nums">{measurementsList.length}</span>
          </div>
          <button
            onClick={clearMeasurements}
            className="text-xs font-bold text-rose-500 hover:text-rose-600 uppercase tracking-wider transition-colors"
          >
            Clear All
          </button>
        </div>
      )}

      <div className="measurement-calibration border-t border-slate-200 dark:border-slate-800">
        <button
          onClick={() => setShowCalibration((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#ff914d]/[0.05] dark:hover:bg-[#ff914d]/[0.06] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Wand2 className="w-3.5 h-3.5 text-amber-500" />
            <div>
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 dark:text-slate-300">Scene calibration</div>
              <div className="text-[9px] text-slate-400 mt-0.5">Separate from ordinary measurement</div>
            </div>
          </div>
          {showCalibration ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
        </button>

        {showCalibration && (
          <div className="measurement-calibration-body px-4 pb-4">
            <div className="p-3 rounded-xl bg-[linear-gradient(135deg,rgba(255,145,77,0.08),rgba(245,158,11,0.08))] dark:bg-[linear-gradient(135deg,rgba(255,145,77,0.10),rgba(245,158,11,0.08))] border border-[rgba(255,145,77,0.22)] dark:border-[rgba(255,145,77,0.18)]">
              {!calibrationMeasurement ? (
                <div className="text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                  Select the wand icon on a measurement first. Calibration is only for a segment whose real-world size is known; it changes project scale.
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div>
                      <div className="text-[10px] font-semibold text-slate-600 dark:text-slate-300">Reference segment</div>
                      <div className="text-[9px] text-slate-400 mt-0.5">Known physical dimension used to rescale the scene</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-xs font-bold text-amber-700 dark:text-amber-400 tabular-nums">{formatLength(calibrationMeasurement.lengthMeters)}</div>
                      <button
                        type="button"
                        onClick={clearCalibrationReference}
                        disabled={calibrationBusy}
                        className="p-1 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-slate-800 disabled:opacity-40"
                        title="Clear calibration reference"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="text-[10px] leading-4 text-slate-500 dark:text-slate-400 mb-2.5">
                    Enter the known real-world length in the selected unit.
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={desiredLength}
                      onChange={(e) => {
                        setDesiredLength(e.target.value);
                        setCalibrationError('');
                        setCalibrationSuccess('');
                      }}
                      placeholder={`Known length (${measurementUnit})`}
                      disabled={calibrationBusy}
                      className="min-w-0 flex-1 text-xs px-2.5 py-2 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-[#ff914d] disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={handleRescale}
                      disabled={!desiredLength || calibrationBusy}
                      className="hci-calibrate-button inline-flex items-center justify-center gap-1 text-[10px] font-bold px-3 py-2 rounded-md bg-[var(--hci-orange)] hover:bg-[var(--hci-orange-hover)] text-white shadow-[0_8px_18px_rgba(255,145,77,0.18)] transition-all disabled:cursor-not-allowed"
                    >
                      {calibrationBusy ? 'Applying…' : 'Calibrate'}
                    </button>
                  </div>

                  {desiredLength && Number.isFinite(Number.parseFloat(desiredLength)) && Number.parseFloat(desiredLength) > 0 && (
                    <div className="mt-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-amber-100 dark:border-amber-900/30 px-2.5 py-2 text-[10px] text-slate-500 dark:text-slate-400">
                      <div className="flex items-center justify-between">
                        <span>Current</span>
                        <span className="font-semibold tabular-nums">{formatLength(calibrationMeasurement.lengthMeters)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span>Target</span>
                        <span className="font-semibold tabular-nums">{desiredLength} {measurementUnit}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1 pt-1 border-t border-slate-100 dark:border-slate-800">
                        <span>Scale factor</span>
                        <span className="font-bold text-amber-700 dark:text-amber-400 tabular-nums">{(() => { const targetM = toMeters(Number.parseFloat(desiredLength), measurementUnit); const factor = targetM / calibrationMeasurement.lengthMeters; return Number.isFinite(factor) ? `×${factor.toFixed(4)}` : '—'; })()}</span>
                      </div>
                    </div>
                  )}

                  {calibrationError && (
                    <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-[10px] leading-4 text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
                      {calibrationError}
                    </div>
                  )}
                  {calibrationSuccess && (
                    <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[10px] leading-4 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
                      {calibrationSuccess}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {sceneScaleFactor && Math.abs(sceneScaleFactor.x - sceneScaleFactor.y) < 0.001 && Math.abs(sceneScaleFactor.y - sceneScaleFactor.z) < 0.001 && Math.abs(sceneScaleFactor.x - 1) > 0.001 && (
        <div className="px-4 py-2 text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-50/70 dark:bg-indigo-900/20 border-t border-indigo-100 dark:border-indigo-900/30">
          Scene calibrated · cumulative scale ×{sceneScaleFactor.x.toFixed(3)}
        </div>
      )}
        </div>
  );
};
