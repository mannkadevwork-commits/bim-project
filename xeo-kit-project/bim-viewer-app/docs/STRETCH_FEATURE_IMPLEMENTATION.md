# Stretch / Resize Handle Feature — Final Implementation

**Status**: Working for dropped IFC asset models (furniture, isolated elements).
**Scope**: Stretch handles appear on asset selection. Drag any handle to scale the asset along that axis in real-time. Native IFC architectural elements (walls, floors, slabs) are excluded — see Constraints section.

---

## Architecture Overview

```
User clicks asset
  → XeoKit cameraControl 'picked' fires
  → buildStretchHandles() creates 6 colored Mesh boxes at AABB face centers
  → User mousedowns on a handle (captured before cameraControl via capture:true)
  → Native canvas onCanvasMouseDown picks handle, reads _stretchMeta, stores drag state
  → document onDocMouseMove computes pixel delta → new scale → model.matrix updated
  → document onDocMouseUp finalizes, re-enables camera, rebuilds handles at new AABB
```

There is also a secondary React-layer path (`startStretchDrag` / `updateStretchDrag` / `endStretchDrag`)
exported as engine actions and called from `BIMViewer.jsx` pointer handlers. In practice the native
listener path owns the actual drag — the React path is wired but the native path fires first due to
capture phase priority.

---

## Critical XeoKit SDK Constraints (Must Know)

### 1. `SceneModel.scale` setter is a NOP
In `@xeokit/xeokit-sdk/src/viewer/scene/model/SceneModel.js`:
```js
set scale(value) {
    // NOP - deprecated
}
```
Every `model.scale = [...]` call silently does nothing. Scale must be applied via `model.matrix` using a 4x4 matrix.

### 2. `SceneModelEntity` has no scale or matrix
Native IFC entities (`viewer.scene.objects[id]`) are `SceneModelEntity` instances. Their geometry is baked into GPU buffers at load time. They only support `offset` (translation), `colorize`, `visible`, `xrayed`, etc. — no scale, no matrix. This is why stretch handles are disabled for native elements.

### 3. XeoKit `cameraControl` consumes mousedown before React synthetic events
React's `onPointerDown` fires after XeoKit's cameraControl has already processed the event. The fix is to use native `canvas.addEventListener('mousedown', handler, { capture: true })` which fires in the capture phase, before cameraControl's bubble-phase listener.

### 4. `mousemove` must be on `document`, not the canvas
During a drag, the mouse cursor moves off the small handle box and often off the canvas entirely within the first few pixels. Canvas-bound `mousemove` stops firing when the cursor leaves the canvas. `document`-level listeners fire regardless of cursor position.

### 5. React state is async — use refs for synchronous drag checks
`isStretching` React state cannot be read synchronously inside `mousemove`. Use `isStretchingRef` (a plain `useRef`) that is set synchronously alongside the state setter.

### 6. Functions defined outside `useEffect` capture stale closures
`buildStretchHandles` and `destroyStretchHandles` are defined outside the main `useEffect` but called inside it. Store them in refs (`buildStretchHandlesRef.current`, `destroyStretchHandlesRef.current`) and call via `ref.current?.()` inside the closure.

### 7. Scale must preserve existing position
When setting `model.matrix`, the translation row must include the model's current `model.position`. Otherwise the model jumps to the world origin on first drag.

### 8. Read scale from matrix column magnitudes, not `.scale`
Since `.scale` getter may not reflect matrix-applied scale, extract scale from the matrix using column vector magnitudes:
```js
const sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
```

---

## File 1: `src/hooks/useBIMEngine.js`

### 1.1 — New Imports (top of file, alongside existing xeokit imports)
```js
import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { buildBoxGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/builders/buildBoxGeometry';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
```

### 1.2 — New Refs and State (inside `useBIMEngine`, before useEffects)
```js
const stretchHandlesRef = useRef([]);
const stretchDragRef = useRef(null);
const isStretchingRef = useRef(false);
const [isStretching, setIsStretching] = useState(false);
const buildStretchHandlesRef = useRef(null);
const destroyStretchHandlesRef = useRef(null);
```

### 1.3 — Guard in `cameraControl.on('picked')` handler
At the very top of the `picked` handler, prevent handle clicks from re-triggering selection:
```js
viewer.cameraControl.on('picked', (pickResult) => {
  if (isMeasuringRef.current) return;
  if (pickResult.entity?._stretchMeta?.isStretchHandle) return;
  // ... rest of handler
```

### 1.4 — Call `buildStretchHandles` on asset selection (inside `picked` handler)
For dropped assets (`entity.model.id !== currentModelRef.current.id`), after `setSelectedAssetId`:
```js
buildStretchHandlesRef.current?.(entity.model.id, true);
```
For native elements — do NOT call `buildStretchHandles`. Native IFC entities cannot be individually scaled (geometry is GPU-baked).

### 1.5 — `destroyStretchHandles` (defined outside useEffect, stored in ref)
```js
const destroyStretchHandles = () => {
  stretchHandlesRef.current.forEach(mesh => { try { mesh.destroy(); } catch (_) {} });
  stretchHandlesRef.current = [];
};
destroyStretchHandlesRef.current = destroyStretchHandles;
```

### 1.6 — `buildStretchHandles` (defined outside useEffect, stored in ref)
```js
const buildStretchHandles = (entityId, isAsset) => {
  destroyStretchHandles();
  const viewer = viewerRef.current;
  if (!viewer) return;

  let aabb;
  if (isAsset) {
    const model = viewer.scene.models[entityId];
    if (!model) return;
    aabb = model.aabb;
  } else {
    const entity = viewer.scene.objects[entityId];
    if (!entity) return;
    aabb = entity.aabb;
  }
  if (!aabb) return;

  const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const cz = (zMin + zMax) / 2;
  const handleSize = 0.15;

  const handleDefs = [
    { pos: [xMax, cy, cz], axis: 0, dir: +1, color: [1, 0.2, 0.2] },  // +X red
    { pos: [xMin, cy, cz], axis: 0, dir: -1, color: [1, 0.2, 0.2] },  // -X red
    { pos: [cx, yMax, cz], axis: 1, dir: +1, color: [0.2, 1, 0.2] },  // +Y green
    { pos: [cx, yMin, cz], axis: 1, dir: -1, color: [0.2, 1, 0.2] },  // -Y green
    { pos: [cx, cy, zMax], axis: 2, dir: +1, color: [0.2, 0.4, 1] },  // +Z blue
    { pos: [cx, cy, zMin], axis: 2, dir: -1, color: [0.2, 0.4, 1] },  // -Z blue
  ];

  const ts = Date.now();
  handleDefs.forEach((def, i) => {
    const mesh = new Mesh(viewer.scene, {
      id: `sh_${ts}_${i}`,
      geometry: new ReadableGeometry(viewer.scene, buildBoxGeometry({
        xSize: handleSize, ySize: handleSize, zSize: handleSize,
      })),
      material: new PhongMaterial(viewer.scene, {
        diffuse: def.color,
        emissive: def.color,
        opacity: 0.9,
      }),
      position: def.pos,
      pickable: true,
    });
    mesh._stretchMeta = { isStretchHandle: true, axis: def.axis, dir: def.dir, targetId: entityId, isAsset };
    stretchHandlesRef.current.push(mesh);
  });
};
buildStretchHandlesRef.current = buildStretchHandles;
```

### 1.7 — Native canvas + document mouse listeners (inside main `useEffect`, after viewer setup)

These are the primary drag handlers. They own the actual stretch interaction.

```js
const canvas = canvasRef.current;

const onCanvasMouseDown = (e) => {
  const canvasPos = [e.offsetX, e.offsetY];
  const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
  if (pick?.entity?._stretchMeta?.isStretchHandle) {
    e.stopPropagation();
    e.preventDefault();
    viewer.cameraControl.active = false;
    const meta = pick.entity._stretchMeta;
    const { axis, dir, targetId, isAsset } = meta;
    const getScale = (obj) => {
      if (!obj) return [1, 1, 1];
      const m = obj.matrix;
      if (!m || m.length < 11) return [1, 1, 1];
      const sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
      const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
      const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
      return [sx || 1, sy || 1, sz || 1];
    };
    const startScale = isAsset
      ? getScale(viewer.scene.models[targetId])
      : getScale(viewer.scene.objects[targetId]);
    stretchDragRef.current = { axis, dir, targetId, isAsset, startCanvasX: e.offsetX, startCanvasY: e.offsetY, startScale };
    isStretchingRef.current = true;
    setIsStretching(true);
  }
};

// SceneModel.scale setter is a NOP (deprecated) — must use model.matrix.
// Compose scale + existing translation so position is preserved.
const applyScale = (targetId, isAsset, scaleVec) => {
  const [sx, sy, sz] = scaleVec;
  if (isAsset) {
    const model = viewer.scene.models[targetId];
    if (!model) return;
    const p = model.position || [0, 0, 0];
    model.matrix = [
      sx, 0,  0,  0,
      0,  sy, 0,  0,
      0,  0,  sz, 0,
      p[0], p[1], p[2], 1,
    ];
  } else {
    const entity = viewer.scene.objects[targetId];
    if (!entity) return;
    const p = entity.position || [0, 0, 0];
    entity.matrix = [
      sx, 0,  0,  0,
      0,  sy, 0,  0,
      0,  0,  sz, 0,
      p[0], p[1], p[2], 1,
    ];
  }
};

const onDocMouseMove = (e) => {
  if (!isStretchingRef.current || !stretchDragRef.current) return;
  const { axis, dir, targetId, isAsset, startCanvasX, startCanvasY, startScale } = stretchDragRef.current;
  const rect = canvas.getBoundingClientRect();
  const curX = e.clientX - rect.left;
  const curY = e.clientY - rect.top;
  // Y axis: drag up = bigger. X/Z axis: drag right = bigger.
  const pixelDelta = axis === 1 ? (startCanvasY - curY) : (curX - startCanvasX);
  const newScaleOnAxis = Math.max(0.05, startScale[axis] + pixelDelta * 0.005 * dir);
  const s = [...startScale];
  s[axis] = newScaleOnAxis;
  applyScale(targetId, isAsset, s);
};

const onDocMouseUp = () => {
  if (!isStretchingRef.current || !stretchDragRef.current) return;
  const { targetId, isAsset } = stretchDragRef.current;
  stretchDragRef.current = null;
  isStretchingRef.current = false;
  setIsStretching(false);
  viewer.cameraControl.active = true;
  buildStretchHandlesRef.current?.(targetId, isAsset);
};

// IMPORTANT: mousedown uses { capture: true } to fire before cameraControl.
// mousemove and mouseup are on document so they fire even when mouse leaves canvas.
canvas.addEventListener('mousedown', onCanvasMouseDown, { capture: true });
document.addEventListener('mousemove', onDocMouseMove);
document.addEventListener('mouseup', onDocMouseUp);
```

### 1.8 — `pickedNothing` handler — clear stretch state
```js
viewer.cameraControl.on('pickedNothing', () => {
  if (placementModeRef.current) { setPlacementMode(null); return; }
  viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
  setSelectedObject(null);
  setSelectedAssetId(null);
  destroyStretchHandlesRef.current?.();
  stretchDragRef.current = null;
  isStretchingRef.current = false;
  setIsStretching(false);
});
```

### 1.9 — Cleanup in `useEffect` return
```js
return () => {
  canvas.removeEventListener('mousedown', onCanvasMouseDown, { capture: true });
  document.removeEventListener('mousemove', onDocMouseMove);
  document.removeEventListener('mouseup', onDocMouseUp);
  // ... existing cleanup (viewer.destroy(), etc.)
};
```

### 1.10 — Secondary React-layer drag actions (defined outside useEffect, exported)

These are exported as engine actions and called from `BIMViewer.jsx` pointer handlers.
In practice the native listener path (1.7) owns the drag — these are a secondary wiring.

```js
const startStretchDrag = (canvasPos, stretchMeta) => {
  const { axis, dir, targetId, isAsset } = stretchMeta;
  let startScale;
  if (isAsset) {
    const model = viewerRef.current?.scene.models[targetId];
    startScale = model ? [...(model.scale || [1, 1, 1])] : [1, 1, 1];
  } else {
    const entity = viewerRef.current?.scene.objects[targetId];
    startScale = entity ? [...(entity.scale || [1, 1, 1])] : [1, 1, 1];
  }
  stretchDragRef.current = { axis, dir, targetId, isAsset, startCanvasX: canvasPos[0], startCanvasY: canvasPos[1], startScale };
  isStretchingRef.current = true;
  setIsStretching(true);
};

const updateStretchDrag = (canvasPos) => {
  if (!isStretchingRef.current) return;
  const drag = stretchDragRef.current;
  if (!drag) return;
  const { axis, dir, targetId, isAsset, startCanvasX, startCanvasY, startScale } = drag;
  const pixelDelta = axis === 1 ? (startCanvasY - canvasPos[1]) : (canvasPos[0] - startCanvasX);
  const newScaleOnAxis = Math.max(0.05, startScale[axis] + pixelDelta * 0.005 * dir);
  if (isAsset) {
    const model = viewerRef.current?.scene.models[targetId];
    if (model) { const s = [...(model.scale || [1, 1, 1])]; s[axis] = newScaleOnAxis; model.scale = s; }
  } else {
    const entity = viewerRef.current?.scene.objects[targetId];
    if (entity) { const s = [...(entity.scale || [1, 1, 1])]; s[axis] = newScaleOnAxis; entity.scale = s; }
  }
};

const endStretchDrag = (persistCallback) => {
  if (!isStretchingRef.current) return;
  const drag = stretchDragRef.current;
  if (!drag) return;
  const { axis, targetId, isAsset } = drag;
  let finalScale;
  if (isAsset) {
    const model = viewerRef.current?.scene.models[targetId];
    finalScale = model?.scale || [1, 1, 1];
  } else {
    const entity = viewerRef.current?.scene.objects[targetId];
    finalScale = entity?.scale || [1, 1, 1];
  }
  if (persistCallback) persistCallback(targetId, 'scale', axis, finalScale[axis]);
  stretchDragRef.current = null;
  isStretchingRef.current = false;
  setIsStretching(false);
  buildStretchHandlesRef.current?.(targetId, isAsset);
};
```

### 1.11 — Export `isStretching` and stretch actions in returned object
```js
state: {
  // ... all existing state fields
  isStretching,
},
actions: {
  // ... all existing actions
  buildStretchHandles,
  destroyStretchHandles,
  startStretchDrag,
  updateStretchDrag,
  endStretchDrag,
},
```

---

## File 2: `src/BIMViewer.jsx`

### 2.1 — `handlePointerDown`
```js
const handlePointerDown = (e) => {
  refs.canvasRef.current?.focus();
  if (!engineState.selectedObject && !engineState.selectedAssetId) return;
  const viewer = refs.viewerRef.current;
  if (!viewer) return;
  const canvasPos = [e.nativeEvent.offsetX, e.nativeEvent.offsetY];
  const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
  if (pick?.entity?._stretchMeta?.isStretchHandle) {
    e.stopPropagation();
    viewer.cameraControl.active = false;
    engineActions.startStretchDrag(canvasPos, pick.entity._stretchMeta);
  }
};
```

### 2.2 — `handlePointerMove`
```js
const handlePointerMove = (e) => {
  updateCursorTooltip(e.clientX, e.clientY, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
  engineActions.updateStretchDrag([e.nativeEvent.offsetX, e.nativeEvent.offsetY]);
};
```

### 2.3 — `handlePointerUp`
```js
const handlePointerUp = () => {
  const viewer = refs.viewerRef.current;
  if (viewer) viewer.cameraControl.active = true;
  engineActions.endStretchDrag(updateStructuralEdit);
};
```

### 2.4 — Canvas wrapper div — `cursor-ew-resize` when stretching
```jsx
className={`... ${engineState.isStretching ? 'cursor-ew-resize' : engineState.placementMode || engineState.isMeasuring ? 'cursor-crosshair' : 'cursor-default'}`}
```

### 2.5 — Canvas element — pointer event handlers
```jsx
<canvas
  ref={refs.canvasRef}
  tabIndex={0}
  onPointerDown={handlePointerDown}
  onPointerMove={handlePointerMove}
  onPointerUp={handlePointerUp}
  onPointerLeave={handlePointerLeave}
  onDragEnter={handleDragEnter}
  onDragOver={handleDragOver}
  onDragLeave={handlePointerLeave}
  onDrop={handleDrop}
  style={{ width: '100%', height: '100%', display: 'block', outline: 'none', touchAction: 'none' }}
/>
```

---

## File 3: `src/components/RightPanel.jsx`

### 3.1 — Stretching status pill (inside `propertySubTab === 'design'` content block)
Add at the very top of the design tab content:
```jsx
{engineState.isStretching && (
  <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 animate-pulse">
    <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block"></span>
    Stretching — release mouse to apply
  </div>
)}
```

---

## How It Works End to End

1. **User clicks a dropped asset** → `cameraControl 'picked'` fires → `buildStretchHandles(modelId, true)` creates 6 colored `Mesh` boxes at the 6 face centers of the model's AABB. Each mesh is tagged with `mesh._stretchMeta = { isStretchHandle, axis, dir, targetId, isAsset }`.

2. **User mousedowns on a handle** → Native `canvas mousedown` listener (capture phase, fires before cameraControl) calls `viewer.scene.pick()`. If the picked entity has `_stretchMeta.isStretchHandle`, it:
   - Calls `e.stopPropagation()` + `e.preventDefault()` to block camera orbit
   - Sets `viewer.cameraControl.active = false`
   - Reads current scale from `model.matrix` column magnitudes
   - Stores drag state in `stretchDragRef`
   - Sets `isStretchingRef.current = true` and `setIsStretching(true)`

3. **User drags** → `document mousemove` computes pixel delta from drag start using `e.clientX - rect.left` for accurate off-canvas coordinates. Converts to scale delta (`pixelDelta * 0.005 * dir`). Builds new 4x4 matrix with scale on diagonal and existing `model.position` in translation row. Assigns to `model.matrix`.

4. **User releases** → `document mouseup` clears drag state, re-enables `cameraControl`, calls `buildStretchHandles` again to reposition handles at the new AABB.

5. **User clicks empty space** → `cameraControl 'pickedNothing'` fires → `destroyStretchHandles()` removes all 6 meshes, stretch state is reset.

---

## Constraints / Known Limitations

| Constraint | Reason |
|---|---|
| Only works on dropped asset models | `SceneModelEntity` (native IFC) has no `matrix` or `scale` API — geometry is GPU-baked |
| `model.scale` setter is a NOP | Explicitly deprecated in XeoKit SDK — must use `model.matrix` |
| Scale does not persist across page reload | `model.matrix` is not saved to `projectState` yet — add persistence if needed |
| Handles stay at original positions during drag | Handles are rebuilt only on mouseup at the new AABB |
| Rotation is lost when scaling | The matrix is built as pure scale + translation. If the model has a rotation applied via `model.rotation`, that rotation is lost when `model.matrix` is set. Fix: compose rotation into the matrix before assigning |
| `console.log` debug lines still present | `onCanvasMouseDown`, `buildStretchHandles`, `onDocMouseUp`, and `loadIFCAssetIntoScene` all have debug logs — remove before production |

---

## XeoKit SDK Import Paths (verified working)

```
@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh
@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry
@xeokit/xeokit-sdk/src/viewer/scene/geometry/builders/buildBoxGeometry
@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial
```
