# GLB Asset Support — Implementation Document

**Feature:** Drag & drop `.glb` files from the Catalog onto the BIM viewer (same UX as existing IFC furniture like sofa).  
**Status:** Ready for implementation / parallel release  
**Affected files:** 4 files total

---

## Background

The existing furniture pipeline (sofa, chair, etc.) uses `.ifc` files loaded via `WebIFCLoaderPlugin`. It fetches the file as an `ArrayBuffer` and passes raw bytes to the loader.

GLB files cannot use this path. xeokit's `GLTFLoaderPlugin` loads GLB/GLTF by URL (`src:`) directly — no manual fetch or buffer needed. All other behaviour (AABB-based centering, global scale factor, rotation, project state persistence, reload on re-open) must be identical to the IFC furniture path.

---

## File 1 — `bim-viewer-app/src/hooks/useBIMEngine.js`

### Change 1a — Add import at top of file

```js
// BEFORE
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';

// AFTER
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { GLTFLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/GLTFLoaderPlugin/GLTFLoaderPlugin';
```

### Change 1b — Initialize GLTFLoaderPlugin alongside XKTLoaderPlugin

Find the block where `loadersRef.current.xkt` is set (inside the viewer setup `useEffect`) and add the gltf loader on the next line:

```js
// BEFORE
sectionPlanesRef.current = new SectionPlanesPlugin(viewer);
loadersRef.current.xkt = new XKTLoaderPlugin(viewer);

// AFTER
sectionPlanesRef.current = new SectionPlanesPlugin(viewer);
loadersRef.current.xkt = new XKTLoaderPlugin(viewer);
loadersRef.current.gltf = new GLTFLoaderPlugin(viewer);
```

### Change 1c — Add `loadGLBAssetIntoScene` function

Add this function immediately before the existing `loadIFCAssetIntoScene` function:

```js
const loadGLBAssetIntoScene = async (instanceId, srcUrl, targetPosition, rotation) => {
  if (!loadersRef.current.gltf) return;
  try {
    const assetModel = loadersRef.current.gltf.load({
      id: instanceId,
      src: srcUrl,
      edges: true,
    });

    assetModel.on('loaded', () => {
      const gs = globalScaleFactorRef.current;
      if (gs && (gs.x !== 1 || gs.y !== 1 || gs.z !== 1)) {
        assetModel.scale = [gs.x, gs.y, gs.z];
      }
      const aabb = assetModel.aabb;
      if (aabb && targetPosition) {
        assetModel.position = [
          targetPosition[0] - (aabb[0] + aabb[3]) / 2,
          targetPosition[1] - aabb[1],
          targetPosition[2] - (aabb[2] + aabb[5]) / 2,
        ];
      }
      if (rotation) assetModel.rotation = rotation;
    });
  } catch (error) {
    console.error('[BIM Engine] GLB placement failure:', error);
  }
};
```

### Change 1d — Update furniture reload on project load to handle GLB

Inside the `useEffect` that watches `[file]`, find the furniture restore block and update it:

```js
// BEFORE
if (projectStateRef.current.furniture) {
  projectStateRef.current.furniture.forEach(item => {
    if (!viewerRef.current.scene.models[item.instanceId]) {
      loadIFCAssetIntoScene(item.instanceId, item.src, item.position, item.rotation);
    }
  });
}

// AFTER
if (projectStateRef.current.furniture) {
  projectStateRef.current.furniture.forEach(item => {
    if (!viewerRef.current.scene.models[item.instanceId]) {
      if (item.assetFormat === 'glb') {
        loadGLBAssetIntoScene(item.instanceId, item.src, item.position, item.rotation);
      } else {
        loadIFCAssetIntoScene(item.instanceId, item.src, item.position, item.rotation);
      }
    }
  });
}
```

### Change 1e — Export `loadGLBAssetIntoScene` in the actions return

```js
// BEFORE
actions: {
  ...
  loadIFCAssetIntoScene,
  getDropPosition,
  ...
}

// AFTER
actions: {
  ...
  loadIFCAssetIntoScene,
  loadGLBAssetIntoScene,
  getDropPosition,
  ...
}
```

---

## File 2 — `bim-viewer-app/src/hooks/useProjectSync.js`

### Change 2a — Update `spawnAsset` to accept and route GLB loader

```js
// BEFORE
const spawnAsset = (asset, coordinates, loadIFCAssetIntoScene, rotation = [0, 0, 0]) => {
  const uniqueId = `${asset.id}_${Date.now()}`;
  const urlPath = asset.url || asset.src || `/assets/${asset.id}.ifc`;
  const fullAssetUrl = urlPath.startsWith('http')
    ? urlPath
    : `${API_BASE_URL}${urlPath}`;

  setProjectState(prev => ({
    ...prev,
    furniture: [
      ...prev.furniture,
      {
        id: asset.id,
        instanceId: uniqueId,
        name: asset.name,
        src: fullAssetUrl,
        position: coordinates,
        rotation: rotation,
      },
    ],
  }));

  loadIFCAssetIntoScene(uniqueId, fullAssetUrl, coordinates, rotation);

  setToastMessage(`${asset.name} placed!`);
  setTimeout(() => setToastMessage(null), 3000);
};

// AFTER
const spawnAsset = (asset, coordinates, loadIFCAssetIntoScene, rotation = [0, 0, 0], loadGLBAssetIntoScene = null) => {
  const uniqueId = `${asset.id}_${Date.now()}`;
  const urlPath = asset.url || asset.src || `/assets/${asset.id}.ifc`;
  const fullAssetUrl = urlPath.startsWith('http')
    ? urlPath
    : `${API_BASE_URL}${urlPath}`;

  const isGLB = urlPath.toLowerCase().endsWith('.glb');

  setProjectState(prev => ({
    ...prev,
    furniture: [
      ...prev.furniture,
      {
        id: asset.id,
        instanceId: uniqueId,
        name: asset.name,
        src: fullAssetUrl,
        position: coordinates,
        rotation: rotation,
        assetFormat: isGLB ? 'glb' : 'ifc',  // persisted so reload knows which loader to use
      },
    ],
  }));

  if (isGLB && loadGLBAssetIntoScene) {
    loadGLBAssetIntoScene(uniqueId, fullAssetUrl, coordinates, rotation);
  } else {
    loadIFCAssetIntoScene(uniqueId, fullAssetUrl, coordinates, rotation);
  }

  setToastMessage(`${asset.name} placed!`);
  setTimeout(() => setToastMessage(null), 3000);
};
```

---

## File 3 — `bim-viewer-app/src/BIMViewer.jsx`

### Change 3a — Pass `loadGLBAssetIntoScene` in the click-placement handler (useBIMEngine callback)

```js
// BEFORE
(asset, data) => {
  if (asset.type === 'door') {
    insertDoor(asset, data);
  } else {
    spawnAsset(asset, data, engineActions.loadIFCAssetIntoScene);
  }
},

// AFTER
(asset, data) => {
  if (asset.type === 'door') {
    insertDoor(asset, data);
  } else {
    spawnAsset(asset, data, engineActions.loadIFCAssetIntoScene, [0, 0, 0], engineActions.loadGLBAssetIntoScene);
  }
},
```

### Change 3b — Pass `loadGLBAssetIntoScene` in the drag-drop handler (`handleDrop`)

```js
// BEFORE
} else {
  const worldPos = engineActions.getDropPosition(canvasPos);
  spawnAsset(asset, worldPos, engineActions.loadIFCAssetIntoScene);
}

// AFTER
} else {
  const worldPos = engineActions.getDropPosition(canvasPos);
  spawnAsset(asset, worldPos, engineActions.loadIFCAssetIntoScene, [0, 0, 0], engineActions.loadGLBAssetIntoScene);
}
```

---

## File 4 — `ifc-render-app/server.js`

### Change 4a — Fix the `bed_glb` catalog entry

The entry was registered with `type: 'bed'` and `category: 'Structural'` which caused it to:
- Not appear under the Furniture filter in the Catalog
- Not follow the standard furniture placement path

```js
// BEFORE
{ id: 'bed_glb', name: 'Bed Glb', type: 'bed', category: 'Structural', url: '/assets/Bed.glb' },

// AFTER
{ id: 'bed_glb', name: 'Bed (GLB)', type: 'furniture', category: 'Furniture', url: '/assets/Bed.glb' },
```

---

## How it all connects

```
User drags Bed (GLB) from Catalog
        │
        ▼
handleDrop in BIMViewer.jsx
  → asset.type === 'furniture'  (not 'door')
  → getDropPosition(canvasPos)  → floor-snap world position
  → spawnAsset(asset, worldPos, loadIFCAssetIntoScene, [0,0,0], loadGLBAssetIntoScene)
        │
        ▼
spawnAsset in useProjectSync.js
  → detects url ends with .glb
  → saves { assetFormat: 'glb' } to projectState (persisted to localStorage + cloud)
  → calls loadGLBAssetIntoScene(uniqueId, fullAssetUrl, coordinates, rotation)
        │
        ▼
loadGLBAssetIntoScene in useBIMEngine.js
  → GLTFLoaderPlugin.load({ id, src, edges })
  → on 'loaded': applies globalScaleFactor, centers via AABB, applies rotation
        │
        ▼
Bed.glb appears in the 3D viewer at the drop position

On project reload:
  → furniture item has assetFormat: 'glb'
  → routes to loadGLBAssetIntoScene instead of loadIFCAssetIntoScene
```

---

## Assets required

- `Bed.glb` must be present at: `ifc-render-app/assets/Bed.glb` ✅ (already placed)
- The backend serves it via the existing static route: `app.use('/assets', express.static(assetsDir))` ✅ (no server change needed for serving)

---

## Notes for parallel release

- No new npm packages needed — `GLTFLoaderPlugin` is already part of `@xeokit/xeokit-sdk`
- The `assetFormat` field added to furniture state is backward-compatible — existing saved states without it will default to the IFC path (no migration needed)
- Any future `.glb` assets added to the catalog only need `type: 'furniture'` and a `.glb` URL — the detection is purely URL-extension based
- The same `spawnAsset` signature change supports any number of future GLB assets without further code changes
