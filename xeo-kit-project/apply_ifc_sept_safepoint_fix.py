#!/usr/bin/env python3
from __future__ import annotations
import subprocess
import sys
import shutil
from pathlib import Path
from datetime import datetime

ROOT = Path.cwd()
FILES = {
    "catalog": ROOT / "xeo-kit-project/bim-viewer-app/src/components/CatalogTree.jsx",
    "engine": ROOT / "xeo-kit-project/bim-viewer-app/src/engine/useBIMEngine.js",
    "stretch": ROOT / "xeo-kit-project/bim-viewer-app/src/engine/stretch/StretchController.js",
    "sync": ROOT / "xeo-kit-project/bim-viewer-app/src/hooks/useProjectSync.js",
}

def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
    if p.returncode:
        print(p.stdout)
        print(p.stderr, file=sys.stderr)
        raise SystemExit(p.returncode)
    return p.stdout

def git_show(path):
    rel = path.relative_to(ROOT).as_posix()
    return run(["git", "show", f"origin/main:{rel}"])

def backup(path):
    if not path.exists():
        return
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = path.with_name(path.name + f".ifc_safe_backup_{stamp}")
    shutil.copy2(path, dst)
    print("BACKUP", dst)

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)

def patch_catalog():
    p = FILES["catalog"]
    t = git_show(p)
    t = replace_once(t, '''function CatalogItemCard({ item, placementMode, setPlacementMode, resetSelection }) {
  const placementId = `cat_${item.id}`;
''', '''function CatalogItemCard({ item, placementMode, setPlacementMode, resetSelection }) {
  const placementId = `cat_${item.id}`;
  const dragFinishedRef = useRef(false);
''', "CatalogItemCard ref")
    t = replace_once(t, '''  const handleDragStart = (e) => {
    e.dataTransfer.setData('application/json', JSON.stringify(buildPlacementAsset()));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
''', '''  const handleDragStart = (e) => {
    dragFinishedRef.current = true;
    e.dataTransfer.setData('application/json', JSON.stringify(buildPlacementAsset()));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleClick = () => {
    // Chromium can emit a click after an HTML drag. Do not switch to
    // click-to-place mode after a drag/drop operation.
    if (dragFinishedRef.current) {
      dragFinishedRef.current = false;
      return;
    }
    setPlacementMode(buildPlacementAsset());
    resetSelection();
  };

  return (
''', "Catalog drag/click handlers")
    t = replace_once(t, "      onClick={() => { setPlacementMode(buildPlacementAsset()); resetSelection(); }}\n", "      onClick={handleClick}\n", "Catalog onClick")
    p.write_text(t, encoding="utf-8")

def patch_stretch():
    p = FILES["stretch"]
    t = git_show(p)
    a = t.index("export const applyScale =")
    b = t.index("export const resetHoveredStretchHandle", a)
    fn = '''export const applyScale = (viewerRef, targetId, isAsset, scaleVec) => {
  const viewer = viewerRef.current;
  if (!viewer) return;

  const [sx, sy, sz] = scaleVec;

  if (isAsset) {
    const model = viewer.scene.models[targetId];
    if (!model) return;

    if (isGLBModel(model)) {
      // PROTECTED GLB PATH.
      applyGLBPlacementTransform(
        model,
        getGLBPlacementTarget(model),
        model.rotation || [0, 0, 0],
        [sx, sy, sz]
      );
      return;
    }

    // IFC safe-point behavior: compose current Y rotation with scale rather
    // than replacing a rotated asset by a scale-only matrix.
    const p = model.position || [0, 0, 0];
    const ry = ((model.rotation?.[1] || 0) * Math.PI) / 180;
    const c = Math.cos(ry);
    const s = Math.sin(ry);

    model.matrix = [
      sx * c, 0, -sx * s, 0,
      0, sy, 0, 0,
      sz * s, 0, sz * c, 0,
      p[0], p[1], p[2], 1,
    ];
    return;
  }

  const entity = viewer.scene.objects[targetId];
  if (!entity) return;

  const p = entity.position || [0, 0, 0];
  const ry = ((entity.rotation?.[1] || 0) * Math.PI) / 180;
  const c = Math.cos(ry);
  const s = Math.sin(ry);

  entity.matrix = [
    sx * c, 0, -sx * s, 0,
    0, sy, 0, 0,
    sz * s, 0, sz * c, 0,
    p[0], p[1], p[2], 1,
  ];
};

'''
    t = t[:a] + fn + t[b:]
    p.write_text(t, encoding="utf-8")

def patch_engine():
    p = FILES["engine"]
    t = git_show(p)

    old = '''    if (Array.isArray(item.matrix) && item.matrix.length === 16 && item.matrix.every(Number.isFinite)) {
      model.matrix = Array.from(item.matrix);
      return;
    }

    const position = item.isNativeIsolation
'''
    new = '''    // Normal catalog IFC assets use the proven TRS/placement path.
    // Ignore stale runtime matrices. Native isolation may still restore one.
    if (!item.isNativeIsolation) {
      return;
    }

    if (Array.isArray(item.matrix) && item.matrix.length === 16 && item.matrix.every(Number.isFinite)) {
      model.matrix = Array.from(item.matrix);
      return;
    }

    const position = item.isNativeIsolation
'''
    t = replace_once(t, old, new, "IFC persisted matrix guard")

    a = t.index("    const onCanvasMouseDown = (e) => {")
    b = t.index("    const onCanvasHoverMove = (e) => {", a)

    block = r'''    const onCanvasMouseDown = (e) => {
      if (isMeasuringRef.current && (measurementModeRef.current === 'point' || measurementModeRef.current === 'orthogonal')) return;

      const rect = canvas.getBoundingClientRect();
      const canvasPos = [e.clientX - rect.left, e.clientY - rect.top];
      const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
      const meta = pick?.entity?._stretchMeta;
      if (!meta?.isStretchHandle) return;

      const mode = transformModeRef.current;
      const baseMetaMode = mode === 'stretch' ? 'stretch' : mode;
      if (meta.transformMode !== baseMetaMode) return;

      e.stopPropagation();
      e.preventDefault();
      viewer.cameraControl.active = false;

      const { targetId, isAsset, type, axes } = meta;
      if (!isAsset) {
        viewer.cameraControl.active = true;
        return;
      }

      const targetObj = viewer.scene.models[targetId];
      if (!targetObj) return;
      const glb = isGLBModel(targetObj);

      if (mode === 'move' && type === 'move') {
        const startPosition = glb
          ? getGLBPlacementTarget(targetObj)
          : [...(targetObj.position || [0, 0, 0])];
        const startGrab = calculateGrabPoint(viewerRef, canvas, canvasPos, startPosition[1]);
        if (!startGrab) {
          viewer.cameraControl.active = true;
          return;
        }
        stretchDragRef.current = {
          type: 'move', targetId, isAsset: true, isGLB: glb,
          startPosition, startGrab: [...startGrab],
        };
        isStretchingRef.current = true;
        setIsStretching(true);
        setActiveStretchData({ label: 'Move', x: e.clientX, y: e.clientY });
        return;
      }

      if (mode === 'rotate' && type === 'rotate') {
        if (!glb) {
          stretchDragRef.current = {
            type: 'rotate-ifc', targetId, isAsset: true, isGLB: false,
            lastX: e.clientX, currentRot: targetObj.rotation?.[1] || 0,
          };
          isStretchingRef.current = true;
          setIsStretching(true);
          canvas.style.cursor = 'grabbing';
          setActiveStretchData({
            label: `Rotate: ${(targetObj.rotation?.[1] || 0).toFixed(1)}°`,
            x: e.clientX, y: e.clientY,
          });
          return;
        }

        const center = getGLBPlacementTarget(targetObj);
        const startGrab = calculateGrabPoint(viewerRef, canvas, canvasPos, center[1]);
        if (!startGrab) {
          viewer.cameraControl.active = true;
          return;
        }
        stretchDragRef.current = {
          type: 'rotate', targetId, isAsset: true, isGLB: true,
          center, startGrab: [...startGrab],
          startRotationY: targetObj.rotation?.[1] || 0,
          rotationGizmoMeshes: stretchHandlesRef.current.filter(mesh => (
            mesh?._stretchMeta?.type === 'rotate' &&
            mesh?._stretchMeta?.targetId === targetId &&
            mesh?._stretchMeta?.isAsset === true
          )),
        };
        isStretchingRef.current = true;
        setIsStretching(true);
        canvas.style.cursor = 'grabbing';
        setActiveStretchData({ label: 'Rotate • drag around the arrow', x: e.clientX, y: e.clientY });
        return;
      }

      if (mode === 'stretch' && (type === 'face' || type === 'edge' || type === 'corner')) {
        const rotationY = ((targetObj.rotation?.[1] || 0) * Math.PI) / 180;
        const c = Math.cos(rotationY);
        const sn = Math.sin(rotationY);
        const localAxes = [[c, 0, -sn], [0, 1, 0], [sn, 0, c]];
        const startAabb = targetObj.aabb;
        const startHalf = startAabb
          ? [
              (startAabb[3] - startAabb[0]) / 2,
              (startAabb[4] - startAabb[1]) / 2,
              (startAabb[5] - startAabb[2]) / 2,
            ]
          : [1, 1, 1];

        const getScale = (obj) => {
          const m = obj?.matrix;
          if (!m || m.length < 11) return [1, 1, 1];
          return [
            Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]) || 1,
            Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]) || 1,
            Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]) || 1,
          ];
        };

        const startScale = getScale(targetObj);
        const startPosition = glb
          ? getGLBPlacementTarget(targetObj)
          : [...(targetObj.position || [0, 0, 0])];

        let anchorWorld = null;
        if (!glb && axes.length === 1 && startAabb) {
          const { axis, dir } = axes[0];
          anchorWorld = dir > 0 ? startAabb[axis] : startAabb[axis + 3];
        }

        stretchDragRef.current = {
          type: 'scale', axesList: axes, targetId, isAsset: true, isGLB: glb,
          startCanvasX: canvasPos[0], startCanvasY: canvasPos[1],
          startScale, startPosition, startHalf,
          startDimensions: startAabb
            ? [startAabb[3]-startAabb[0], startAabb[4]-startAabb[1], startAabb[5]-startAabb[2]]
            : [1, 1, 1],
          localAxes, anchorWorld,
        };
        isStretchingRef.current = true;
        setIsStretching(true);
        return;
      }

      viewer.cameraControl.active = true;
    };

    const onDocMouseMove = (e) => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const dragData = stretchDragRef.current;
      const rect = canvas.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      const targetObj = viewer.scene.models[dragData.targetId];
      if (!targetObj) return;

      if (dragData.type === 'move') {
        const currentGrab = calculateGrabPoint(viewerRef, canvas, [curX, curY], dragData.startPosition[1]);
        if (!currentGrab) return;
        const next = [
          dragData.startPosition[0] + currentGrab[0] - dragData.startGrab[0],
          dragData.startPosition[1],
          dragData.startPosition[2] + currentGrab[2] - dragData.startGrab[2],
        ];
        if (dragData.isGLB) {
          applyGLBPlacementTransform(targetObj, next, targetObj.rotation || [0,0,0], targetObj.scale || [1,1,1]);
        } else {
          targetObj.position = next;
        }
        setActiveStretchData({ label: 'Move', x: e.clientX, y: e.clientY });
        return;
      }

      if (dragData.type === 'rotate-ifc') {
        const deltaX = e.clientX - dragData.lastX;
        let newRotY = (dragData.currentRot + deltaX * 0.8) % 360;
        if (newRotY < 0) newRotY += 360;
        const current = targetObj.rotation || [0,0,0];
        targetObj.rotation = [current[0], newRotY, current[2]];
        dragData.lastX = e.clientX;
        dragData.currentRot = newRotY;
        setActiveStretchData({ label: `Rotate: ${newRotY.toFixed(1)}°`, x: e.clientX, y: e.clientY });
        return;
      }

      if (dragData.type === 'rotate') {
        const currentGrab = calculateGrabPoint(viewerRef, canvas, [curX, curY], dragData.center[1]);
        if (!currentGrab) return;
        const startAngle = Math.atan2(dragData.startGrab[2]-dragData.center[2], dragData.startGrab[0]-dragData.center[0]);
        const currentAngle = Math.atan2(currentGrab[2]-dragData.center[2], currentGrab[0]-dragData.center[0]);
        let delta = (startAngle-currentAngle)*180/Math.PI;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        let nextRotation = dragData.startRotationY + delta;
        while (nextRotation < 0) nextRotation += 360;
        nextRotation %= 360;
        const currentRotation = targetObj.rotation ? [...targetObj.rotation] : [0,0,0];
        applyGLBPlacementTransform(
          targetObj,
          getGLBPlacementTarget(targetObj),
          [currentRotation[0], nextRotation, currentRotation[2]],
          targetObj.scale || [1,1,1]
        );
        if (dragData.rotationGizmoMeshes?.length) {
          dragData.rotationGizmoMeshes.forEach(mesh => {
            try { mesh.position = [...dragData.center]; mesh.rotation = [0,nextRotation,0]; } catch (_) {}
          });
        }
        setActiveStretchData({ label: `Rotate: ${nextRotation.toFixed(1)}°`, x: e.clientX, y: e.clientY });
        return;
      }

      const deltaScreenX = curX - dragData.startCanvasX;
      const deltaScreenY = dragData.startCanvasY - curY;
      const s = [...dragData.startScale];

      if (!dragData.isGLB && dragData.axesList.length === 1) {
        const { axis, dir } = dragData.axesList[0];
        const pixelDelta = axis === 1 ? deltaScreenY : deltaScreenX;
        s[axis] = Math.max(0.05, dragData.startScale[axis] + pixelDelta * 0.005 * dir);
        const nextPosition = [...dragData.startPosition];
        if (dragData.anchorWorld !== null) {
          nextPosition[axis] = dragData.anchorWorld - (s[axis]/(dragData.startScale[axis] || 1)) * (dragData.anchorWorld - dragData.startPosition[axis]);
        }
        applyScale(viewerRef, dragData.targetId, true, s);
        targetObj.position = nextPosition;
      } else {
        const viewMatrix = viewer.scene.camera.viewMatrix;
        dragData.axesList.forEach(({ axis, dir }) => {
          const v = dragData.localAxes[axis];
          const screenX = viewMatrix[0]*v[0] + viewMatrix[4]*v[1] + viewMatrix[8]*v[2];
          const screenY = viewMatrix[1]*v[0] + viewMatrix[5]*v[1] + viewMatrix[9]*v[2];
          const len = Math.hypot(screenX, screenY) || 1;
          const effectiveDelta = (deltaScreenX*screenX/len + deltaScreenY*screenY/len) * dir;
          s[axis] = Math.max(0.05, dragData.startScale[axis] + effectiveDelta*0.005);
          if (!dragData.isGLB) {
            const startHalf = dragData.startHalf[axis];
            const scaleRatio = s[axis] / (dragData.startScale[axis] || 1);
            const halfDelta = startHalf * (scaleRatio - 1);
            dragData.startPosition[0] += dragData.localAxes[axis][0] * halfDelta * dir;
            dragData.startPosition[1] += dragData.localAxes[axis][1] * halfDelta * dir;
            dragData.startPosition[2] += dragData.localAxes[axis][2] * halfDelta * dir;
          }
        });
        if (dragData.isGLB) {
          applyGLBPlacementTransform(targetObj, dragData.startPosition, targetObj.rotation || [0,0,0], s);
        } else {
          applyScale(viewerRef, dragData.targetId, true, s);
          targetObj.position = [...dragData.startPosition];
        }
      }

      const names = dragData.axesList.map(({axis}) => axis===0 ? 'Width' : axis===1 ? 'Height' : 'Depth');
      setActiveStretchData({
        label: `${names.join(' + ')}: ${dragData.axesList.map(({axis}) => s[axis].toFixed(2)).join(' × ')}`,
        x: e.clientX, y: e.clientY,
      });
    };

    const onDocMouseUp = () => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const dragData = stretchDragRef.current;
      const targetObj = viewer.scene.models[dragData.targetId];

      if (targetObj && stretchPersistCallbackRef.current) {
        if (dragData.type === 'move') {
          const position = dragData.isGLB
            ? getGLBPlacementTarget(targetObj)
            : (targetObj.position || [0,0,0]);
          position.forEach((value, axis) => stretchPersistCallbackRef.current(dragData.targetId, 'position', axis, value));
        } else if (dragData.type === 'rotate-ifc' || dragData.type === 'rotate') {
          stretchPersistCallbackRef.current(dragData.targetId, 'rotation', 1, targetObj.rotation?.[1] || 0);
        } else {
          const matrix = targetObj.matrix;
          const matrixScale = matrix && matrix.length >= 11
            ? [
                Math.sqrt(matrix[0]*matrix[0] + matrix[1]*matrix[1] + matrix[2]*matrix[2]) || 1,
                Math.sqrt(matrix[4]*matrix[4] + matrix[5]*matrix[5] + matrix[6]*matrix[6]) || 1,
                Math.sqrt(matrix[8]*matrix[8] + matrix[9]*matrix[9] + matrix[10]*matrix[10]) || 1,
              ]
            : (targetObj.scale || [1,1,1]);
          dragData.axesList.forEach(({axis}) => stretchPersistCallbackRef.current(dragData.targetId, 'scale', axis, matrixScale[axis]));
          if (!dragData.isGLB) {
            const position = targetObj.position || [0,0,0];
            position.forEach((value, axis) => stretchPersistCallbackRef.current(dragData.targetId, 'position', axis, value));
          }
        }
      }

      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      setActiveStretchData(null);
      canvas.style.cursor = '';
      viewer.cameraControl.active = true;
      buildStretchHandlesRef.current?.(stretchCtx, dragData.targetId, dragData.isAsset);
      setTimeout(() => configureTransformHandles(transformModeRef.current), 0);
    };

'''
    t = t[:a] + block + t[b:]
    p.write_text(t, encoding="utf-8")

def patch_sync():
    p = FILES["sync"]
    t = git_show(p)
    a = t.index("  const updateAsset = (")
    b = t.index("  const deleteAsset =", a)
    fn = r'''  const updateAsset = (viewerRef, selectedAssetId, axis, value, isRotation = false, isScale = false) => {
    if (!selectedAssetId || !viewerRef.current) return;
    const assetModel = viewerRef.current.scene.models[selectedAssetId];
    if (!assetModel) return;
    const numValue = parseFloat(value);
    if (!Number.isFinite(numValue)) return;

    const isGLB = isGLBModel(assetModel);
    const currentGLBTarget = isGLB ? getGLBPlacementTarget(assetModel) : null;
    let updatedPos;
    let updatedRot;
    let updatedScale;

    if (isScale) {
      updatedScale = [...(assetModel.scale || [1,1,1])];
      updatedScale[axis] = Math.max(0.001, numValue);
      if (isGLB) {
        applyGLBPlacementTransform(assetModel, currentGLBTarget, assetModel.rotation || [0,0,0], updatedScale);
      } else {
        assetModel.scale = updatedScale;
      }
    } else if (isRotation) {
      updatedRot = [...(assetModel.rotation || [0,0,0])];
      updatedRot[axis] = numValue;
      if (isGLB) {
        applyGLBPlacementTransform(assetModel, currentGLBTarget, updatedRot, assetModel.scale || [1,1,1]);
      } else {
        assetModel.rotation = updatedRot;
      }
    } else {
      if (isGLB) {
        updatedPos = [...currentGLBTarget];
        updatedPos[axis] = numValue;
        applyGLBPlacementTransform(assetModel, updatedPos, assetModel.rotation || [0,0,0], assetModel.scale || [1,1,1]);
      } else {
        updatedPos = [...(assetModel.position || [0,0,0])];
        updatedPos[axis] = numValue;
        assetModel.position = updatedPos;
      }
    }

    const persistedPosition = isGLB
      ? (updatedPos || currentGLBTarget)
      : (updatedPos || assetModel.position || [0,0,0]);
    const persistedMatrix = isGLB ? normalizeMatrix(assetModel.matrix) : null;
    const glbNormalization = isGLB ? assetModel?._assetMeta?.glbNormalization : null;

    setProjectStateTracked(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f => f.instanceId === selectedAssetId
        ? {
            ...f,
            position: persistedPosition,
            rotation: updatedRot || f.rotation || [0,0,0],
            scale: updatedScale || f.scale || [1,1,1],
            ...(persistedMatrix ? { matrix: persistedMatrix } : {}),
            ...(glbNormalization ? { glbNormalization } : {}),
          }
        : f
      ),
    }), {
      coalesceKey: `asset-transform:${selectedAssetId}:${isScale ? 'scale' : isRotation ? 'rotation' : 'position'}`
    });
  };

'''
    t = t[:a] + fn + t[b:]

    old = """                ...(matrix ? { matrix } : {}),
                ...(normalizedGLB ? { glbNormalization: normalizedGLB } : {}),
"""
    new = """                ...(isGLBModel(model) && matrix ? { matrix } : {}),
                ...(normalizedGLB ? { glbNormalization: normalizedGLB } : {}),
"""
    if old in t:
        t = replace_once(t, old, new, "placed asset matrix guard")
    p.write_text(t, encoding="utf-8")

def main():
    if not (ROOT / ".git").exists():
        raise SystemExit("Run from repository root.")
    print("Fetching origin/main...")
    run(["git", "fetch", "origin"])
    for p in FILES.values():
        backup(p)

    patch_catalog()
    print("PATCHED", FILES["catalog"])
    patch_stretch()
    print("PATCHED", FILES["stretch"])
    patch_engine()
    print("PATCHED", FILES["engine"])
    patch_sync()
    print("PATCHED", FILES["sync"])

    print("\nIFC September safe-point recovery applied.")
    print("GLBAssetTransform.js was NOT modified.")
    print("Previous local files are backed up beside each file.")

if __name__ == "__main__":
    main()
