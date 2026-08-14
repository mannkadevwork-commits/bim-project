import { vec3Distance } from '../utils/helpers';

export const toggleMeasurementMode = (isMeasuring, setIsMeasuring, setPlacementMode, setSelectedObject, setSelectedAssetId, viewerRef) => {
  const nextState = !isMeasuring;
  setIsMeasuring(nextState);
  if (nextState) {
      setPlacementMode(null);
      setSelectedObject(null);
      setSelectedAssetId(null);
      if (viewerRef.current) viewerRef.current.scene.setObjectsSelected(viewerRef.current.scene.selectedObjectIds, false);
  }
};

export const clearMeasurements = (measurementsPluginRef, setMeasurementsList) => {
  if (measurementsPluginRef.current) {
      measurementsPluginRef.current.clear();
  }
  setMeasurementsList([]);
};

export const syncMeasurementsList = (measurementsPluginRef, setMeasurementsList) => {
  const plugin = measurementsPluginRef.current;
  if (!plugin || !plugin.measurements) return;

  const next = Object.values(plugin.measurements)
    .map((m) => {
      const originPos = m.origin?.worldPos;
      const targetPos = m.target?.worldPos;
      if (!originPos || !targetPos) return null;

      const modelId = m.origin?.entity?.model?.id || m.target?.entity?.model?.id || null;

      return {
        id: m.id,
        lengthMeters: vec3Distance(originPos, targetPos),
        modelId: modelId, 
        midpoint: [
          (originPos[0] + targetPos[0]) / 2,
          (originPos[1] + targetPos[1]) / 2,
          (originPos[2] + targetPos[2]) / 2,
        ],
      };
    })
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
      midpoint[0] - pad, midpoint[1] - pad, midpoint[2] - pad,
      midpoint[0] + pad, midpoint[1] + pad, midpoint[2] + pad,
    ],
    duration: 0.6,
  });
};

export const toggleSnapping = (measurementsPluginRef, snappingEnabled, setSnappingEnabled) => {
  const control = measurementsPluginRef.current?.control;
  const next = !snappingEnabled;
  if (control) {
    control.snapToVertex = next;
    control.snapToEdge = next;
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

export const formatLength = (meters, measurementUnit) => {
  if (measurementUnit === 'ft') {
    return `${(meters * 3.28084).toFixed(2)} ft`;
  }
  return `${meters.toFixed(2)} m`;
};