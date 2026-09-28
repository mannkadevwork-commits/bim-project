import { useEffect, useRef } from 'react';
import { Viewer } from '@xeokit/xeokit-sdk/src/viewer/Viewer';
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { NavCubePlugin } from '@xeokit/xeokit-sdk/src/plugins/NavCubePlugin/NavCubePlugin';
import * as WebIFC from 'web-ifc';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function hexToRgb01(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

export function IFCEditorViewer({ sessionId, selectedIds, rooms, onSelect, onMultiSelect, onViewerReady }) {
  const canvasRef    = useRef(null);
  const navCubeRef   = useRef(null);
  const viewerRef    = useRef(null);
  const isShiftRef   = useRef(false);
  const modelRef     = useRef(null);

  // Track shift key
  useEffect(() => {
    const down = e => { if (e.key === 'Shift') isShiftRef.current = true; };
    const up   = e => { if (e.key === 'Shift') isShiftRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // Boot viewer once
  useEffect(() => {
    if (!canvasRef.current) return;

    const viewer = new Viewer({ canvasElement: canvasRef.current, transparent: true, antialias: true });
    viewer.cameraControl.navMode = 'orbit';
    viewer.cameraControl.followPointer = true;
    viewer.cameraControl.smartPivot = true;
    viewer.camera.eye = [-3.93, 2.85, 27.01];
    viewer.camera.look = [4.4, 3.72, 8.89];
    viewer.camera.up = [-0.01, 0.99, 0.039];

    const selMat = viewer.scene.selectedMaterial;
    selMat.fill = false; selMat.edges = true;
    selMat.edgeColor = [1.0, 0.57, 0.3]; selMat.edgeAlpha = 0.96; selMat.edgeWidth = 2.5;

    navCubeRef.current = new NavCubePlugin(viewer, {
      canvasElement: navCubeRef.current,
      color: '#1a2435', frontColor: '#202d40',
    });

    viewerRef.current = viewer;

    // Selection handler
    viewer.cameraControl.on('picked', (pick) => {
      if (!pick.entity) return;
      const entity = pick.entity;
      const meta = viewer.metaScene.metaObjects[entity.id];
      const name = meta?.name || entity.id;
      const id   = meta?.id   || entity.id;

      if (isShiftRef.current) {
        onMultiSelect(id, name);
      } else {
        // clear all selections first
        viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
        onSelect(id, name);
      }
      entity.selected = true;
    });

    viewer.cameraControl.on('pickedNothing', () => {
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
      onSelect(null, null);
    });

    // Wheel zoom
    const canvas = canvasRef.current;
    const onWheel = e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1.1 : 0.9;
      const eye  = viewer.camera.eye;
      const look = viewer.camera.look;
      const dir  = [eye[0]-look[0], eye[1]-look[1], eye[2]-look[2]];
      viewer.camera.eye = [look[0]+dir[0]*delta, look[1]+dir[1]*delta, look[2]+dir[2]*delta];
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    if (onViewerReady) onViewerReady(viewer);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      try { viewer.destroy(); } catch (_) {}
      viewerRef.current = null;
    };
  }, []);

  // Load IFC when sessionId changes
  useEffect(() => {
    if (!sessionId || !viewerRef.current) return;
    const viewer = viewerRef.current;

    // Destroy previous model
    if (modelRef.current) { try { modelRef.current.destroy(); } catch (_) {} modelRef.current = null; }

    let alive = true;
    const init = async () => {
      const ifcAPI = new WebIFC.IfcAPI();
      ifcAPI.SetWasmPath('/');
      await ifcAPI.Init();
      if (!alive) return;

      const loader = new WebIFCLoaderPlugin(viewer, { WebIFC, IfcAPI: ifcAPI });
      const url = `${API_BASE}/api/ifc-editor/file/${sessionId}`;
      const model = loader.load({ id: 'ifc_editor_model', src: url, edges: true, globalizeCoordinates: false });
      modelRef.current = model;
      model.on('loaded', () => { if (alive) viewer.cameraFlight.flyTo(model); });
    };
    init().catch(console.error);

    return () => { alive = false; };
  }, [sessionId]);

  // Sync room colors onto wall entities
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    rooms.forEach(room => {
      const rgb = hexToRgb01(room.color);
      room.wallIds.forEach(wid => {
        const entity = viewer.scene.objects[wid];
        if (entity) entity.colorize = rgb;
      });
    });
  }, [rooms]);

  // Highlight currently selected ids
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
    selectedIds.forEach(id => {
      const entity = viewer.scene.objects[id];
      if (entity) entity.selected = true;
    });
  }, [selectedIds]);

  return (
    <div className="relative flex-1 bg-slate-950">
      <canvas ref={canvasRef} className="w-full h-full" />
      <canvas ref={navCubeRef} className="absolute bottom-4 right-4 w-20 h-20 pointer-events-none" />
      <div className="absolute top-3 left-3 bg-slate-900/80 text-slate-400 text-[10px] px-2 py-1 rounded-lg border border-slate-700">
        Click to select &nbsp;·&nbsp; Shift+Click to multi-select
      </div>
    </div>
  );
}
