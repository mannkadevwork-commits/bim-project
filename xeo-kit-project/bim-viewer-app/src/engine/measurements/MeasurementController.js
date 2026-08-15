import { vec3Distance } from '../utils/helpers';


export const MEASUREMENT_MODES = {
  point: { label: 'Point', description: 'Snap to a vertex, edge, or surface point' },
  reference: { label: 'Reference', description: 'Use Xeokit model references' },
  orthogonal: { label: 'Orthogonal', description: 'Measure a plan or vertical distance between two references' },
};

export const ORTHOGONAL_CONSTRAINTS = {
  horizontal: { label: 'Horizontal', shortLabel: 'H', description: 'Plan distance on XZ; preserves the first point elevation' },
  vertical: { label: 'Vertical', shortLabel: 'V', description: 'Elevation difference on Y; preserves the first point plan position' },
};

export const pickMeasurementReference = (viewer, canvasPos, snappingEnabled = true) => {
  if (!viewer?.scene || !Array.isArray(canvasPos)) return null;

  const snapPick = viewer.scene.pick({
    canvasPos,
    pickSurface: true,
    pickSurfaceNormal: true,
    pickSurfacePrecision: true,
    snapRadius: snappingEnabled ? 30 : 0,
    snapToVertex: !!snappingEnabled,
    snapToEdge: !!snappingEnabled,
  });

  if (!snapPick?.worldPos) return null;

  let snapType = 'Surface';
  if (snapPick.snappedToVertex) snapType = 'Vertex';
  else if (snapPick.snappedToEdge) snapType = 'Edge';

  return {
    entity: snapPick.entity || null,
    worldPos: [Number(snapPick.worldPos[0]), Number(snapPick.worldPos[1]), Number(snapPick.worldPos[2])],
    worldNormal: snapPick.worldNormal ? [Number(snapPick.worldNormal[0]), Number(snapPick.worldNormal[1]), Number(snapPick.worldNormal[2])] : null,
    snapType,
    snapped: !!snapPick.snapped,
    canvasPos: snapPick.snappedCanvasPos || snapPick.canvasPos || canvasPos,
    primitive: snapPick.primitive || null,
  };
};

export const createProgrammaticDistanceMeasurement = (measurementsPluginRef, origin, target, {
  id,
  axisVisible = false,
  visible = true,
  wireVisible = true,
  kind = 'point',
  constraint = null,
} = {}) => {
  const plugin = measurementsPluginRef.current;
  if (!plugin || !origin?.entity || !target?.entity) return null;

  const measurement = plugin.createMeasurement({
    id: id || `hci_measurement_${Date.now()}`,
    origin: { entity: origin.entity, worldPos: origin.worldPos },
    target: { entity: target.entity, worldPos: target.worldPos },
    visible,
    wireVisible,
    axisVisible,
    xAxisVisible: axisVisible,
    yAxisVisible: axisVisible,
    zAxisVisible: axisVisible,
  });

  // Client-side metadata lets the React panel distinguish point, reference,
  // and orthogonal measurements without changing Xeokit's measurement model.
  measurement._hciMeasurementKind = kind;
  measurement._hciOrthogonalConstraint = constraint;
  return measurement;
};

export const MEASUREMENT_UNITS = {
  mm: { label: 'Millimeters', shortLabel: 'mm', factor: 1000, decimals: 0 },
  cm: { label: 'Centimeters', shortLabel: 'cm', factor: 100, decimals: 1 },
  m: { label: 'Meters', shortLabel: 'm', factor: 1, decimals: 2 },
  ft: { label: 'Feet', shortLabel: 'ft', factor: 3.28084, decimals: 2 },
};

export const toggleMeasurementMode = (
  isMeasuring,
  setIsMeasuring,
  setPlacementMode,
  setSelectedObject,
  setSelectedAssetId,
  viewerRef,
) => {
  const nextState = !isMeasuring;
  setIsMeasuring(nextState);

  if (nextState) {
    setPlacementMode(null);
    setSelectedObject(null);
    setSelectedAssetId(null);

    const viewer = viewerRef.current;
    if (viewer) {
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
    }
  }
};

export const clearMeasurements = (measurementsPluginRef, setMeasurementsList) => {
  const plugin = measurementsPluginRef.current;
  if (plugin) {
    plugin.clear();
  }
  setMeasurementsList([]);
};

const normalizePoint = (point) => {
  if (!point || point.length < 3) return null;
  const result = [Number(point[0]), Number(point[1]), Number(point[2])];
  return result.every(Number.isFinite) ? result : null;
};

const modelIdFromEndpoint = (endpoint) => {
  return endpoint?.entity?.model?.id || endpoint?.entity?.modelId || null;
};

const buildMeasurementRecord = (measurement) => {
  if (!measurement) return null;

  const originPos = normalizePoint(measurement.origin?.worldPos);
  const targetPos = normalizePoint(measurement.target?.worldPos);
  if (!originPos || !targetPos) return null;

  const dx = targetPos[0] - originPos[0];
  const dy = targetPos[1] - originPos[1];
  const dz = targetPos[2] - originPos[2];
  const lengthMeters = vec3Distance(originPos, targetPos);

  return {
    id: measurement.id,
    lengthMeters,
    modelId: modelIdFromEndpoint(measurement.origin) || modelIdFromEndpoint(measurement.target) || null,
    origin: originPos,
    target: targetPos,
    midpoint: [
      (originPos[0] + targetPos[0]) / 2,
      (originPos[1] + targetPos[1]) / 2,
      (originPos[2] + targetPos[2]) / 2,
    ],
    axisDeltaMeters: {
      x: Math.abs(dx),
      y: Math.abs(dy),
      z: Math.abs(dz),
    },
    planDistanceMeters: Math.hypot(dx, dz),
    verticalDistanceMeters: Math.abs(dy),
    elevationDeltaMeters: dy,
    measurementKind: measurement._hciMeasurementKind || 'reference',
    orthogonalConstraint: measurement._hciOrthogonalConstraint || null,
  };
};


export const applyMeasurementUnitToPlugin = (measurementsPluginRef, measurementUnit = 'm') => {
  const plugin = measurementsPluginRef.current;
  if (!plugin?.measurements) return;

  const config = MEASUREMENT_UNITS[measurementUnit] || MEASUREMENT_UNITS.m;

  // Xeokit DistanceMeasurement exposes labelStringFormat specifically so the
  // displayed world-space labels can be reformatted without recreating the
  // measurement geometry. This keeps existing measurements alive while the
  // editor unit changes.
  Object.values(plugin.measurements).forEach((measurement) => {
    if (!measurement) return;
    measurement.labelStringFormat = (len) => {
      const value = len * config.factor;
      return `${value.toFixed(config.decimals)} ${config.shortLabel}`;
    };
  });
};

export const syncMeasurementsList = (measurementsPluginRef, setMeasurementsList) => {
  const plugin = measurementsPluginRef.current;
  if (!plugin?.measurements) return;

  const next = Object.values(plugin.measurements)
    .filter((measurement) => !String(measurement?.id || '').startsWith('hci_measurement_preview_'))
    .map(buildMeasurementRecord)
    .filter(Boolean);

  setMeasurementsList(next);
};

export const deleteMeasurement = (id, measurementsPluginRef, setMeasurementsList) => {
  const plugin = measurementsPluginRef.current;
  if (!plugin) return;

  plugin.destroyMeasurement(id);
  syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
};

export const flyToMeasurement = (viewerRef, midpoint) => {
  const viewer = viewerRef.current;
  if (!viewer || !midpoint) return;

  const pad = 1.5;
  viewer.cameraFlight.flyTo({
    aabb: [
      midpoint[0] - pad,
      midpoint[1] - pad,
      midpoint[2] - pad,
      midpoint[0] + pad,
      midpoint[1] + pad,
      midpoint[2] + pad,
    ],
    duration: 0.6,
  });
};

export const toggleSnapping = (measurementControlRef, snappingEnabled, setSnappingEnabled) => {
  const control = measurementControlRef.current;
  const next = !snappingEnabled;

  if (control) {
    // Current xeokit DistanceMeasurementsMouseControl API.
    if ('snapping' in control) {
      control.snapping = next;
    } else {
      // Compatibility fallback for older xeokit builds.
      control.snapToVertex = next;
      control.snapToEdge = next;
    }
  }

  setSnappingEnabled(next);
};

export const toggleAxisBreakdown = (measurementsPluginRef, axisBreakdownVisible, setAxisBreakdownVisible) => {
  const plugin = measurementsPluginRef.current;
  const next = !axisBreakdownVisible;

  if (plugin) {
    plugin.setAxisVisible(next);
  }

  setAxisBreakdownVisible(next);
};

export const formatLength = (meters, measurementUnit = 'm') => {
  if (!Number.isFinite(meters)) return '—';

  const config = MEASUREMENT_UNITS[measurementUnit] || MEASUREMENT_UNITS.m;
  const value = meters * config.factor;
  return `${value.toFixed(config.decimals)} ${config.shortLabel}`;
};

export const getMeasurementUnitOptions = () => Object.entries(MEASUREMENT_UNITS).map(([value, config]) => ({
  value,
  label: config.shortLabel,
  name: config.label,
}));

export const cancelActiveMeasurement = (measurementControlRef) => {
  const control = measurementControlRef.current;
  if (!control?.active) return;
  control.reset?.();
};
