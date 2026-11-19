# HCI_2.1 Skills Reference

## 1. YOLO Inference & Model Management
**File:** `logic/yolo_inference.py`

- `resolve_hci21_model()` — resolves weights path via 5-level priority chain
- `find_model_path()` — default inference weights shortcut
- `invalidate_model_cache()` — drops cached model so next call reloads from disk
- `_get_model(model_path)` — loads + caches YOLO model
- `run_yolo_inference(img, ...)` — runs segmentation, maps class IDs to HCI names, applies wall post-processing
- `map_model_class_to_hci(cls_id, names)` — maps YOLO class → HCI PascalCase (Wall/Door/Window only)
- `draw_detection_overlay(img, labelled)` — draws colored filled polygons + labels on image

## 2. Wall Geometry Filtering & Post-Processing
**File:** `logic/yolo_inference.py`

- `_filter_contour(cnt, h, w)` — removes tiny/degenerate contours, applies polygon approximation
- `_filter_wall_candidates(contours, h, w)` — strict wall geometry filter (area, aspect ratio, solidity)
- `contour_to_yolo_seg(cnt, w, h, cid)` — converts contour to YOLO-seg label line

## 3. Wall Graph Construction (ifc_pipeline.py)
**File:** `logic/ifc_pipeline.py`

- `build_wall_graph(walls, W, H, mpp, warnings, scale_confidence)` — full P2+P3+P5A pipeline
- `yolo_polys(lbl, class_id, W, H)` — parses YOLO-seg label file into polygon dicts
- `min_area_centerline(pts_px)` — OBB-based centerline + thickness extraction
- `deterministic_wall_order(walls)` — stable sort for reproducible output

## 4. Wall Thickness Estimation (P2)
**File:** `logic/ifc_pipeline.py`

- `estimate_wall_thickness_candidate(...)` — perpendicular_median → OBB fallback hierarchy
- `sample_perpendicular_widths_px(...)` — boundary-to-boundary width sampling along centerline
- `robust_median_width_px(widths)` — outlier-rejected median
- `apply_plan_and_global_thickness_fallback(candidates)` — plan median → global 0.23m fallback
- `soft_clip_thickness_m(thickness_m, scale_confidence)` — soft metre bounds

## 5. Wall Topology (P3 Snap & Dedupe)
**File:** `logic/ifc_pipeline.py`

- `apply_t_junction_snaps(segs, ...)` — moves endpoints onto host interiors
- `rebuild_nodes_from_segments(segs, ...)` — clusters endpoints with hybrid angular-aware snap
- `dedupe_coincident_segments(segs, ...)` — removes duplicate/overlapping wall segments
- `compute_snap_radius_px(...)` — hybrid snap radius (tiny vs large image paths)
- `segments_are_coincident(a, b, snap_px)` — coincidence test with orientation + overlap checks

## 6. Wall Run Reconstruction (P5A)
**File:** `logic/ifc_pipeline.py`

- `reconstruct_wall_runs_p5a(segs, ...)` — merges collinear/coincident fragments into union runs
- `can_form_wall_run(a, b, tol_px, lateral_tol_px)` — collinearity + gap + T-stub check
- `union_wall_run_group(members)` — builds one wall run covering union of member projections
- `try_collinear_merge(a, b, snap_px)` — pairwise collinear merge attempt

## 7. Opening Association (P4)
**File:** `logic/ifc_pipeline.py`

- `associate_openings(graph_m, doors, wins, H, mpp, warnings)` — deterministic multi-factor door/window → wall mapping
- `score_opening_wall_candidate(...)` — distance + interior + overlap + orientation scoring
- `candidate_acceptance_valid(...)` — acceptance threshold check
- `opening_metrics(pts_px)` — centroid, width, orientation from polygon
- `longitudinal_overlap_ratio(...)` — fraction of opening projecting onto wall
- `orientation_alignment_score(wall_ang, opening_ang)` — undirected orientation agreement

## 8. IFC4 Export
**File:** `logic/ifc_pipeline.py`

- `write_ifc4(graph_m, opening_map, out_ifc, basename)` — writes full IFC4 file
  - Creates: IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey hierarchy
  - Emits: IfcWall, IfcOpeningElement, IfcDoor, IfcWindow
  - Connects: IfcRelVoidsElement, IfcRelFillsElement, IfcRelConnectsPathElements (L/T junctions)
- `generate_full_ifc(image_path, label_path, output_ifc, mpp, ...)` — end-to-end entry point

## 9. Production Orchestration
**File:** `logic/production_orchestrator.py`

- `ProductionOrchestrator.process(filename, image_bytes, mpp)` — full pipeline coordinator
- `validate_production_request(...)` — extension + empty + mpp validation
- `make_unique_production_filename(stem, ext)` — `{stem}_{YYYYMMDD_HHMMSS}_{6hex}{ext}`
- `build_production_success_body(...)` — JSON envelope with download_url
- `build_production_error_body(...)` — error JSON with error_code

## 10. Quality Validation
**File:** `logic/production_validation.py`

- `QualityValidator.ensure_model_available()` — checks YOLO weights exist (503 if not)
- `QualityValidator.validate_after_autolabel(basename)` — label quality gate (no walls → 422)

## 11. Auto-Labelling
**File:** `auto_label.py`

- `generate_labels(image_path, output_dir, model_path)` — YOLO inference → YOLO-seg label file + overlay image

## 12. Dataset I/O
**File:** `logic/dataset_io.py`

- `save_raw_image_bytes(filename, data)` — writes to `gdrive_dataset/images_raw/`
- `ifc_file_path(basename)` — resolves `gdrive_dataset/output/{basename}.ifc`
- `IMG_EXTS` — allowed extensions: `.jpg .jpeg .png .bmp .tiff .webp .svg`
- `ensure_dataset_dirs()` — creates all runtime subdirectories on startup

## 13. Scale Calibration
**File:** `logic/scale_calibration.py`

- `resolve_mpp(meters_per_pixel)` — validates + returns mpp or DEFAULT_MPP fallback
- `DEFAULT_MPP = 0.01` m/px

## 14. Wall Junction Connection
**File:** `logic/wall_connect.py`

- `connect_wall_contours(walls, W, H)` — connects L/T/X junctions in contour space (used in yolo_inference)
- `connect_wall_segments(segs, mpp)` — connects junctions in segment space (used in ifc_pipeline)
- `connect_walls_enabled(default)` — feature flag check

## 15. HTTP API (FastAPI)
**File:** `web/server.py`

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/process-floorplan` | POST | One-shot image → IFC (synchronous) |
| `/api/ifc/file/{basename}` | GET | Download IFC binary |
| `/api/production/health` | GET | Health check |
| `/api/detect` | POST | Detection overlay image |
| `/api/stream` | GET | SSE stream for training UI |

## 16. Geometry Utilities
**File:** `logic/ifc_pipeline.py`

- `dist_point_to_segment(px, py, ax, ay, bx, by)` — distance + clamped t + closest point
- `segment_angle_deg(p0, p1)` — angle in degrees
- `angle_diff_deg(a, b)` — undirected angular difference mod 180
- `stable_geometry_fingerprint(graph_m, opening_map)` — SHA-256 deterministic fingerprint
- `classify_L_X_junctions(segs, mpp)` — diagnostic L and X junction lists
