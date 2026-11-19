# HCI_2.1 Known Issues

## Critical

### ISSUE-001 — No Authentication on API
**File:** `web/server.py`
**Route:** `POST /api/process-floorplan`, `GET /api/ifc/file/{basename}`
**Detail:** Zero authentication (no API key, Bearer token, or session). CORS is open `allow_origins=["*"]`.
**Risk:** Any process that can reach the server can upload images and download IFC files.
**Fix:** Add API key middleware or Bearer token validation before public internet exposure.

---

### ISSUE-002 — Path Traversal Risk on IFC Download
**File:** `web/server.py` → `download_ifc_file`
**Route:** `GET /api/ifc/file/{basename}`
**Detail:** No explicit sanitization of `basename` path component verified in code. A crafted `basename` containing `../` sequences could potentially escape `gdrive_dataset/output/`.
**Fix:** Sanitize `basename` — strip path separators, validate it matches expected filename pattern before constructing the file path.

---

### ISSUE-003 — No Upload Size Limit
**File:** `web/server.py`
**Detail:** No `max_upload_size` configured on the FastAPI app or Uvicorn. Large file uploads can exhaust memory/disk.
**Fix:** Add `app.add_middleware` with a request size limit or configure Uvicorn `--limit-max-requests`.

---

## High

### ISSUE-004 — Synchronous 600s Blocking POST
**File:** `logic/production_orchestrator.py`
**Detail:** `POST /api/process-floorplan` blocks the HTTP connection for up to `DEFAULT_AUTOLABEL_TIMEOUT_S = 600s`. Under concurrent load, this exhausts Uvicorn worker threads.
**Fix:** Move pipeline to a background task queue (e.g. Celery, ARQ) with a polling or webhook pattern, or increase Uvicorn workers significantly.

---

### ISSUE-005 — No IFC File Retention / Cleanup
**File:** `logic/dataset_io.py`, `web/server.py`
**Detail:** IFC files written to `gdrive_dataset/output/` are never cleaned up. Disk will fill over time in production.
**Fix:** Implement TTL-based cleanup (e.g. delete files older than N hours) or move to object storage with lifecycle policies.

---

### ISSUE-006 — Wall Thickness Clipped to Legacy Constants in IFC Writer
**File:** `logic/ifc_pipeline.py` → `write_ifc4`
**Line:** `thick = float(np.clip(s["thickness_m"], THICK_MIN, THICK_MAX))`
**Detail:** `THICK_MIN=0.10`, `THICK_MAX=0.40` are legacy P1 constants. The P2 pipeline uses soft bounds `[0.08, 0.50]`. The IFC writer silently overrides P2 estimates outside `[0.10, 0.40]`, discarding accurate thin/thick wall measurements.
**Fix:** Use P2 soft bounds `[THICK_SOFT_HIGH_MIN_M, THICK_SOFT_HIGH_MAX_M]` in `write_ifc4`, or remove the clip and trust P2 output.

---

### ISSUE-007 — `logger.info` Called with Extra Positional Arg
**File:** `logic/yolo_inference.py`
**Line:** `logger.info("Wall detection: YOLO=%d Final=%d", len(yolo_walls), len(new_walls), conn_report.get(...))`
**Detail:** Three format args passed but format string only has two `%d` placeholders. The third arg is silently ignored; no runtime error but the log is misleading.
**Fix:** Add a third placeholder or remove the extra argument.

---

## Medium

### ISSUE-008 — Model Cache Not Thread-Safe
**File:** `logic/yolo_inference.py`
**Detail:** `_model_cache` is a plain dict mutated without a lock. Under concurrent requests (multiple Uvicorn workers in the same process), a race condition can cause two threads to load the model simultaneously or read a partially-written cache entry.
**Fix:** Protect `_model_cache` reads/writes with a `threading.Lock`.

---

### ISSUE-009 — `hashlib` Imported Inside Function
**File:** `logic/ifc_pipeline.py` → `stable_geometry_fingerprint`
**Detail:** `import hashlib` is inside the function body. Called frequently during opening association diagnostics, this adds repeated import overhead (minor but unnecessary).
**Fix:** Move `import hashlib` to the top of the file.

---

### ISSUE-010 — `ifcopenshell` Imported Inside `write_ifc4`
**File:** `logic/ifc_pipeline.py` → `write_ifc4`
**Detail:** `import ifcopenshell` and `import ifcopenshell.guid` are deferred inside the function. While this avoids import-time failure if the package is missing, it hides the dependency and makes errors appear late.
**Fix:** Import at module level with a clear `ImportError` message, or document the intentional deferral.

---

### ISSUE-011 — `ultralytics` Imported Inside `_get_model`
**File:** `logic/yolo_inference.py` → `_get_model`
**Detail:** Same pattern as ISSUE-010. `from ultralytics import YOLO` is deferred inside the function.
**Fix:** Import at module level or document the intentional deferral.

---

### ISSUE-012 — O(n²) Loops in Topology Pipeline
**File:** `logic/ifc_pipeline.py`
**Functions:** `rebuild_nodes_from_segments`, `dedupe_coincident_segments`, `reconstruct_wall_runs_p5a`, `apply_t_junction_snaps`
**Detail:** All use nested O(n²) loops over wall segments. Acceptable for typical floor plans (< 100 walls) but will degrade on large commercial plans (200+ walls).
**Fix:** Use spatial indexing (e.g. `scipy.spatial.KDTree` or a simple grid bucket) for endpoint proximity queries.

---

### ISSUE-013 — `world_pl` Reused Across Multiple IFC Placements
**File:** `logic/ifc_pipeline.py` → `write_ifc4`
**Detail:** The same `IfcAxis2Placement3D` entity (`world_pl`) is referenced by multiple `IfcLocalPlacement` entities (site, building, storey, and wall origins that fall back to it). IFC4 spec requires each placement to reference its own placement entity.
**Fix:** Create a fresh `IfcAxis2Placement3D` for each entity that needs the identity placement.

---

### ISSUE-014 — `make_extruded_box` Uses `world_pl` as Fallback Position
**File:** `logic/ifc_pipeline.py` → `make_extruded_box`
**Detail:** When `z0 == 0`, the function reuses the module-level `world_pl` entity as the `Position` of `IfcExtrudedAreaSolid`. This shares a single IFC entity across many solids, which can cause issues in strict IFC validators.
**Fix:** Always create a new `IfcAxis2Placement3D` per solid.

---

## Low

### ISSUE-015 — `START_HCI_2.1.bat` / `start_server.bat` Bind to `127.0.0.1`
**File:** `HCI_2.1/scripts/start_server.bat`, `HCI_2.1/START_HCI_2.1.bat`
**Detail:** Start scripts bind to loopback only. Remote browsers cannot reach the API without a reverse proxy. This is documented but easy to miss during deployment.
**Fix:** Document clearly in `DEPLOY.md` that a reverse proxy (nginx, Caddy) is required for remote access.

---

### ISSUE-016 — No Uvicorn / HTTP Server Timeout Configured
**File:** `HCI_2.1/scripts/start_server.bat`
**Detail:** No `--timeout-keep-alive` or proxy read timeout is set. With a 600s pipeline, intermediate proxies (nginx default 60s) will time out before the POST completes.
**Fix:** Set `--timeout-keep-alive 620` in Uvicorn args and configure proxy upstream timeout > 600s.

---

### ISSUE-017 — `cairosvg` Listed as Optional but No Graceful Fallback
**File:** `HCI_2.1/requirements.txt`
**Detail:** `cairosvg` requires system Cairo libraries. If missing, import fails at runtime with an unhelpful error rather than a graceful degradation.
**Fix:** Wrap `import cairosvg` in a try/except and disable SVG thumbnail feature with a warning log.

---

### ISSUE-018 — `ifc_path` Exposed in API Response
**File:** `logic/production_orchestrator.py` → `build_production_success_body`
**Detail:** The absolute server filesystem path (`C:\H\gdrive_dataset\output\...`) is returned in the JSON response. This leaks server directory structure to clients.
**Fix:** Remove `ifc_path` from the public response body, or gate it behind `HCI21_DEBUG`.

---

### ISSUE-019 — `work_dir` Debug Sidecars Written in Production
**File:** `logic/ifc_pipeline.py` → `generate_full_ifc`
**Detail:** When `work_dir` is provided, full wall graph JSON and opening map JSON are written to disk. These can be large and accumulate without cleanup.
**Fix:** Gate behind `HCI21_DEBUG` env var or implement the same TTL cleanup as IFC files.

---

### ISSUE-020 — Tests Do Not Cover `write_ifc4` / IFC Output Validity
**File:** `HCI_2.1/tests/`
**Detail:** Test suite covers topology, polygon editing, wall runs, and model resolution but has no test that validates the generated `.ifc` file is parseable by IfcOpenShell or contains expected entity counts.
**Fix:** Add an integration test that calls `generate_full_ifc` on a synthetic label file and asserts wall/door/window counts in the output IFC.
