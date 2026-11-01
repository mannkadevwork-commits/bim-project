GLB PIPELINE PATCH — BACKEND

This is the consolidated backend patch for the GLB PBR/compilation pass and the
admin catalogue upload pass. Use this ZIP instead of separately applying the
older glb_pbr_backend_patch.zip and glb_admin_upload_backend_patch.zip.
All files are complete replacements with project-relative paths.

Copy into backend root (normally xeo-kit-project/ifc-render-app/):
- admin-routes.js
- compiler/compiler.ts
- compiler/glb-optimizer.ts

Changes:
1. Admin uploads accept only .glb/.ifc in the model field and supported raster
   images in the thumbnail field.
2. GLB uploads are checked for a valid GLB 2.0 header and a plausible total length;
   a renamed image or truncated/non-GLB file is rejected with HTTP 400.
3. GLB catalogue records ignore submitted color_rgb overrides and retain neutral
   white in the existing legacy DB field for schema compatibility. IFC color
   metadata is unchanged. GLB materials in the binary are not recolored on upload.
4. The scene compiler preserves supported source material texture maps and PBR
   dependency data rather than recreating only a handful of scalar properties.
5. The optimizer obeys configured texture-size/quality budgets rather than forcing
   a 4096-pixel minimum.

No database migration is required. Uploaded GLB bytes are stored as submitted;
recompile scenes after deployment to use the compiler changes.

Local test sequence:
- Run node --check admin-routes.js, then restart backend.
- Upload a valid GLB and confirm POST /api/admin/items succeeds.
- Rename an image to .glb and confirm upload is rejected with HTTP 400.
- Upload an IFC catalogue item and confirm its display color is still supported.
- Recompile one room containing a textured GLB and inspect the new output.glb and
  optimization_report.json; test multiple objects in ?perf=1 walkthrough mode.
