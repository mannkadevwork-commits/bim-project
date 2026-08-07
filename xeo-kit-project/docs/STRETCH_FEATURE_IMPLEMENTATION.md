# Mouse Stretch Feature — Implementation Guide

## Overview

This document describes every code change required to add real-time mouse stretching of walls and furniture in the BIM viewer. The user selects an element, colored axis handles appear on its faces, they drag a handle, and the element stretches live at 60fps. On mouse release the stretch is saved to `projectState`.

**No backend changes required.** Everything is client-side WebGL transforms.

---

## How It Works (Concept)

1. User clicks a wall or furniture item → element is selected (already works)
2. Stretch handles appear — small colored box meshes rendered by XeoKit at the 6 face centers of the element's bounding box (AABB)
3. User clicks and holds a handle → drag starts, `stretchMode` becomes active
4. On every `mousemove` → compute delta from drag start → apply as `entity.scale` change on the relevant axis → XeoKit redraws instantly
5. On `mouseup` → drag ends → final scale saved to `projectState` via `updateStructuralEdit`
6. Handles are destroyed when element is deselected

**Axis color convention (matches XeoKit standard):**
- Red handles = X axis (width/side)
- Green handles = Y axis (height)
- Blue handles = Z axis (depth/length)

---

## Files to Change

| File | Type of Change |
|---|---|
| `useBIMEngine.js` | Add stretch handle logic, drag state machine, 3 new actions |
| `BIMViewer.jsx` | Wire `onPointerDown` / `onPointerUp` on canvas, pass stretch mode state |
| `RightPanel.jsx` | Show "Stretch Mode Active" indicator when a handle is being dragged |

---

---

## FILE 1: `useBIMEngine.js`

**Path:** `bim-viewer-app/src/hooks/useBIMEngine.js`

---

### Change 1A — Add new imports at the top of the file

**Location:** Line 1, after the existing imports block (after the `import * as WebIFC` line)

Add this import:

```js
import { buildBoxGeometry } from '@xeokit/xeokit-sdk/src/scene/geometry/builders/buildBoxGeometry';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/scene/geometry/ReadableGeometry';
import { Mesh } from '@xeokit/xeokit-sdk/src/scene/mesh/Mesh';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/scene/materials/PhongMaterial';
```

---

### Change 1B — Add new refs and state variables

**Location:** After the existing `const placementModeRef = useRef(null);` line (around line 40)

Add these new refs and state:

```js
// Stretch handle refs
const stretchHandlesRef = useRef([]);        // array of XeoKit Mesh objects (the handle boxes)
const stretchDragRef = useRef(null);         // active drag state: { axis, startCanvasX, startCanvasY, startScale, entityId, isAsset }
const [isStretching, setIsStretching] = useState(false);  // true while mouse is held on a handle
```

---

### Change 1C — Add the `buildStretchHandles` function

**Location:** After the `getWallSnapData` function (around line 490, just before `loadIFCAssetIntoScene`)

Add this entire new function:

```js
// ── Stretch Handles ─────────────────────────────────────────────────
// Builds 6 small colored box meshes at the face centers of the given
// entity/model AABB. Each mesh is tagged with { axis, direction } so
// the drag handler knows which axis to scale.
//
// axisColors: X=red, Y=green, Z=blue (standard BIM convention)
// Handle size is fixed at 0.15m so it's always visible regardless of
// element scale. Handles are stored in stretchHandlesRef so they can
// be destroyed on deselect.
const buildStretchHandles = (entityId, isAsset) => {
  destroyStretchHandles(); // clear any previous handles first

  const viewer = viewerRef.current;
  if (!viewer) return;

  // Get the AABB — for assets use the model, for native use the entity
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

  // Define the 6 face handle positions and their axis/direction metadata
  const handleDefs = [
    { pos: [xMax, cy, cz], axis: 0, dir: +1, color: [1, 0.2, 0.2] },  // +X face, red
    { pos: [xMin, cy, cz], axis: 0, dir: -1, color: [1, 0.2, 0.2] },  // -X face, red
    { pos: [cx, yMax, cz], axis: 1, dir: +1, color: [0.2, 1, 0.2] },  // +Y face, green
    { pos: [cx, yMin, cz], axis: 1, dir: -1, color: [0.2, 1, 0.2] },  // -Y face, green
    { pos: [cx, cy, zMax], axis: 2, dir: +1, color: [0.2, 0.4, 1] },  // +Z face, blue
    { pos: [cx, cy, zMin], axis: 2, dir: -1, color: [0.2, 0.4, 1] },  // -Z face, blue
  ];

  const handleSize = 0.15; // meters, fixed visual size

  handleDefs.forEach((def, i) => {
    const mesh = new Mesh(viewer.scene, {
      id: `stretch_handle_${entityId}_${i}`,
      geometry: new ReadableGeometry(viewer.scene, buildBoxGeometry({
        xSize: handleSize,
        ySize: handleSize,
        zSize: handleSize,
      })),
      material: new PhongMaterial(viewer.scene, {
        diffuse: def.color,
        emissive: def.color,
        opacity: 0.9,
      }),
      position: def.pos,
      pickable: true,
      // Tag the mesh with stretch metadata so the pick handler can read it
      userData: { isStretchHandle: true, axis: def.axis, dir: def.dir, targetId: entityId, isAsset },
    });

    stretchHandlesRef.current.push(mesh);
  });
};

const destroyStretchHandles = () => {
  stretchHandlesRef.current.forEach(mesh => {
    try { mesh.destroy(); } catch (_) {}
  });
  stretchHandlesRef.current = [];
};
```

---

### Change 1D — Add the `startStretchDrag` and `endStretchDrag` functions

**Location:** Directly after the `buildStretchHandles` / `destroyStretchHandles` block added in Change 1C

```js
// Called from BIMViewer.jsx onPointerDown when the picked entity is a
// stretch handle. Stores drag start state so onPointerMove can compute
// the delta.
const startStretchDrag = (canvasPos, handleMesh) => {
  const { axis, dir, targetId, isAsset } = handleMesh.userData;

  // Capture the current scale of the target as the drag baseline
  let startScale;
  if (isAsset) {
    const model = viewerRef.current?.scene.models[targetId];
    startScale = model ? [...(model.scale || [1, 1, 1])] : [1, 1, 1];
  } else {
    const entity = viewerRef.current?.scene.objects[targetId];
    startScale = entity ? [...(entity.scale || [1, 1, 1])] : [1, 1, 1];
  }

  stretchDragRef.current = {
    axis,
    dir,
    targetId,
    isAsset,
    startCanvasX: canvasPos[0],
    startCanvasY: canvasPos[1],
    startScale,
  };
  setIsStretching(true);
};

// Called from BIMViewer.jsx onPointerMove while a drag is active.
// Computes pixel delta → world-space scale delta → applies to entity.
const updateStretchDrag = (canvasPos) => {
  const drag = stretchDragRef.current;
  if (!drag) return;

  const { axis, dir, targetId, isAsset, startCanvasX, startCanvasY, startScale } = drag;

  // Use horizontal mouse delta for X/Z axes, vertical for Y axis.
  // Sensitivity: 0.005 scale units per pixel — feels natural at typical
  // zoom levels. Multiply by dir so dragging outward always grows the element.
  const pixelDelta = axis === 1
    ? (startCanvasY - canvasPos[1])   // Y: drag up = grow (inverted screen Y)
    : (canvasPos[0] - startCanvasX);  // X/Z: drag right = grow

  const sensitivity = 0.005;
  const scaleDelta = pixelDelta * sensitivity * dir;
  const newScaleOnAxis = Math.max(0.05, startScale[axis] + scaleDelta); // clamp > 0

  if (isAsset) {
    const model = viewerRef.current?.scene.models[targetId];
    if (model) {
      const s = [...(model.scale || [1, 1, 1])];
      s[axis] = newScaleOnAxis;
      model.scale = s;
    }
  } else {
    const entity = viewerRef.current?.scene.objects[targetId];
    if (entity) {
      const s = [...(entity.scale || [1, 1, 1])];
      s[axis] = newScaleOnAxis;
      entity.scale = s;
    }
  }
};

// Called from BIMViewer.jsx onPointerUp. Finalizes the drag and
// persists the new scale to projectState so it survives a reload.
const endStretchDrag = (persistCallback) => {
  const drag = stretchDragRef.current;
  if (!drag) return;

  const { axis, targetId, isAsset } = drag;

  // Read the final scale that was applied during the drag
  let finalScale;
  if (isAsset) {
    const model = viewerRef.current?.scene.models[targetId];
    finalScale = model?.scale || [1, 1, 1];
  } else {
    const entity = viewerRef.current?.scene.objects[targetId];
    finalScale = entity?.scale || [1, 1, 1];
  }

  // Persist via the callback (updateStructuralEdit from useProjectSync)
  if (persistCallback) {
    persistCallback(targetId, 'scale', axis, finalScale[axis]);
  }

  stretchDragRef.current = null;
  setIsStretching(false);

  // Rebuild handles at new AABB position after stretch
  buildStretchHandles(targetId, isAsset);
};
```

---

### Change 1E — Destroy handles when selection clears

**Location:** Inside the existing `viewer.cameraControl.on('pickedNothing', ...)` callback (around line 195)

Find this existing block:
```js
viewer.cameraControl.on('pickedNothing', () => {
  if (placementModeRef.current) { setPlacementMode(null); return; }
  viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
  setSelectedObject(null);
  setSelectedAssetId(null);
});
```

Replace it with:
```js
viewer.cameraControl.on('pickedNothing', () => {
  if (placementModeRef.current) { setPlacementMode(null); return; }
  viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
  setSelectedObject(null);
  setSelectedAssetId(null);
  destroyStretchHandles();   // ← ADD THIS LINE
  stretchDragRef.current = null;
  setIsStretching(false);
});
```

---

### Change 1F — Build handles when an element is selected

**Location:** Inside the existing `viewer.cameraControl.on('picked', ...)` callback.

There are two selection branches in the picked handler:
1. When an **asset model** is selected (the `entity.model.id !== currentModelRef.current.id` branch)
2. When a **native element** is selected (the else branch at the bottom)

**In branch 1** (asset selected), find the line `setSelectedAssetId(entity.model.id);` and add after it:
```js
buildStretchHandles(entity.model.id, true);   // ← ADD
```

**In branch 2** (native element selected), find the line `entity.selected = true;` and add after it:
```js
buildStretchHandles(entity.id, false);   // ← ADD
```

---

### Change 1G — Export new actions and state

**Location:** The `return` statement at the bottom of `useBIMEngine.js`

In the `state: { ... }` object, add:
```js
isStretching,
```

In the `actions: { ... }` object, add:
```js
buildStretchHandles,
destroyStretchHandles,
startStretchDrag,
updateStretchDrag,
endStretchDrag,
```

---

---

## FILE 2: `BIMViewer.jsx`

**Path:** `bim-viewer-app/src/BIMViewer.jsx`

---

### Change 2A — Add `onPointerDown` handler on the canvas

**Location:** Find the existing `handlePointerMove` function definition (around line 130)

Add this new function directly before `handlePointerMove`:

```js
const handlePointerDown = (e) => {
  if (!engineState.selectedObject && !engineState.selectedAssetId) return;
  const canvasPos = [e.nativeEvent.offsetX, e.nativeEvent.offsetY];
  const viewer = refs.viewerRef.current;
  if (!viewer) return;

  // Pick at the click position — check if it's a stretch handle
  const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
  if (pick?.entity?.userData?.isStretchHandle) {
    e.stopPropagation();
    engineActions.startStretchDrag(canvasPos, pick.entity);
  }
};
```

---

### Change 2B — Update `handlePointerMove` to feed the drag

**Location:** Find the existing `handlePointerMove` function:
```js
const handlePointerMove = (e) => updateCursorTooltip(e.clientX, e.clientY, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
```

Replace it with:
```js
const handlePointerMove = (e) => {
  updateCursorTooltip(e.clientX, e.clientY, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
  if (engineState.isStretching) {
    engineActions.updateStretchDrag([e.nativeEvent.offsetX, e.nativeEvent.offsetY]);
  }
};
```

---

### Change 2C — Add `onPointerUp` handler

**Location:** Directly after the updated `handlePointerMove` function

Add:
```js
const handlePointerUp = () => {
  if (engineState.isStretching) {
    engineActions.endStretchDrag(updateStructuralEdit);
  }
};
```

---

### Change 2D — Wire the new handlers onto the canvas element

**Location:** Find the `<canvas>` element in the JSX (around line 210). It currently has:
```jsx
onPointerDown={() => refs.canvasRef.current?.focus()}
onPointerMove={handlePointerMove}
onPointerLeave={handlePointerLeave}
```

Replace those three lines with:
```jsx
onPointerDown={(e) => { refs.canvasRef.current?.focus(); handlePointerDown(e); }}
onPointerMove={handlePointerMove}
onPointerUp={handlePointerUp}
onPointerLeave={handlePointerLeave}
```

---

### Change 2E — Update the cursor class to show grab cursor during stretch

**Location:** Find the outer container `div` className (around line 200):
```jsx
${engineState.placementMode || engineState.isMeasuring ? 'cursor-crosshair' : 'cursor-default'}
```

Replace with:
```jsx
${engineState.isStretching ? 'cursor-ew-resize' : engineState.placementMode || engineState.isMeasuring ? 'cursor-crosshair' : 'cursor-default'}
```

---

---

## FILE 3: `RightPanel.jsx`

**Path:** `bim-viewer-app/src/components/RightPanel.jsx`

---

### Change 3A — Show a stretch mode indicator in the Design/Transform tab

**Location:** In the `propertySubTab === 'design'` section, find the opening `<div className="space-y-8 pb-8">` tag. Add this block as the very first child inside it (before the Material Paint section):

```jsx
{engineState.isStretching && (
  <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 animate-pulse">
    <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block"></span>
    Stretching — release mouse to apply
  </div>
)}
```

This requires `engineState` to be passed into `RightPanel` — it already is (check the existing props: `engineState` is already a prop of `RightPanel`).

---

---

## Summary of All Changes

| # | File | What Changes |
|---|---|---|
| 1A | `useBIMEngine.js` | Add XeoKit Mesh/Geometry/Material imports |
| 1B | `useBIMEngine.js` | Add 3 new refs: `stretchHandlesRef`, `stretchDragRef`, `isStretching` state |
| 1C | `useBIMEngine.js` | Add `buildStretchHandles()` and `destroyStretchHandles()` functions |
| 1D | `useBIMEngine.js` | Add `startStretchDrag()`, `updateStretchDrag()`, `endStretchDrag()` functions |
| 1E | `useBIMEngine.js` | In `pickedNothing` handler — call `destroyStretchHandles()` on deselect |
| 1F | `useBIMEngine.js` | In `picked` handler — call `buildStretchHandles()` on both asset and native select |
| 1G | `useBIMEngine.js` | Export `isStretching` in state, export 5 new actions |
| 2A | `BIMViewer.jsx` | Add `handlePointerDown` function — detects handle click |
| 2B | `BIMViewer.jsx` | Update `handlePointerMove` — feeds drag delta during stretch |
| 2C | `BIMViewer.jsx` | Add `handlePointerUp` function — finalizes and saves stretch |
| 2D | `BIMViewer.jsx` | Wire `onPointerDown`, `onPointerUp` onto the canvas element |
| 2E | `BIMViewer.jsx` | Add `cursor-ew-resize` class during active stretch |
| 3A | `RightPanel.jsx` | Show animated "Stretching" indicator in Design tab during drag |

---

## Important Notes for the Team

### XeoKit import paths
The imports in Change 1A use the internal `src/` path style that matches all other imports already in `useBIMEngine.js`. If your build resolves XeoKit differently, check the existing import lines at the top of `useBIMEngine.js` and match the same pattern.

### `userData` on XeoKit Mesh
XeoKit's `Mesh` class accepts a `userData` property that is a plain object — it is not rendered or processed by XeoKit, it's just a bag for your own metadata. This is how the pick handler identifies a handle vs a real element.

### Native wall scale behavior
For native IFC elements (walls from the main structure), `entity.scale` is a visual-only transform — it does NOT rewrite `input.ifc`. This is the same delta-based pattern already used by the existing "Apply Width/Length" button in `RightPanel.jsx`. The scale is persisted to `project_state.json` via `updateStructuralEdit` and re-applied on reload.

### Furniture (asset models)
For dropped furniture, `model.scale` is used instead of `entity.scale`. The `isAsset` flag in the handle's `userData` tells the drag functions which path to take.

### Handle rebuild after stretch
`endStretchDrag` calls `buildStretchHandles` again after the drag ends. This repositions the handles to the new AABB of the stretched element so they are always at the correct face positions.

### Sensitivity tuning
The `sensitivity = 0.005` constant in `updateStretchDrag` controls how many scale units change per pixel of mouse movement. If it feels too fast or too slow after testing, adjust this single constant.
