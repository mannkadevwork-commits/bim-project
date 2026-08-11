# GLB / IFC Asset Pipeline Update

## What changed

- Added `GLTFLoaderPlugin` support to the runtime xeokit engine.
- Standalone `.glb` / `.gltf` assets now load through the same scene-model path as IFC/XKT assets.
- Main uploaded `.glb` / `.gltf` files can now render in the viewer.
- Backend `/upload-ifc` synchronization is now limited to IFC files.
- Furniture state now persists `fileType` and `scale`, so GLB assets can be restored after reload.
- GLB assets without IFC metadata now remain selectable and editable using their model ID.
- Positioning uses the model's actual world AABB and preserves the existing bottom-center placement contract.
- Move, rotate and stretch operate on the xeokit model transform instead of replacing its matrix.
- Stretch scaling no longer rebuilds `matrix`, which previously discarded rotation.
- Material/color persistence now handles both native scene objects and GLB model children.
- The duplicate legacy `src/hooks/useBIMEngine.js` was converted into a compatibility re-export so there is only one runtime engine implementation.

## Runtime contract

Catalog items should expose:
- `model_url`
- `file_type` (`ifc` / `glb` / `gltf` / `xkt`)

Persisted furniture entries now look like:

```js
{
  id,
  instanceId,
  name,
  src,
  fileType,
  position: [x, y, z],
  rotation: [rx, ry, rz],
  scale: [sx, sy, sz]
}
```

## Verification

The modified JavaScript files were syntax-checked with Node.js.

A full Vite production build could not be run because the uploaded archive contains only `src/` and does not include the project's `package.json` / dependency tree.
