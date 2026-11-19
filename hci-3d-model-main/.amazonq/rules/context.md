# HCI_2.1 Project Context

## What This Project Does
Converts 2D floor-plan images (PNG/JPG) into IFC 3D building models using YOLO segmentation + geometry pipeline.

## Tech Stack
- Backend: FastAPI + Uvicorn (Python 3.11)
- ML: Ultralytics YOLO (segmentation), PyTorch
- IFC Export: IfcOpenShell (IFC4 schema)
- Image Processing: OpenCV, NumPy, Pillow
- Runtime Data: `gdrive_dataset/` tree (not in source)

## Project Layout
```
HCI_2.1/
├── config/classes.py               # 17-class taxonomy (Room → EnergyConversionDevice)
├── auto_label.py                   # YOLO → YOLO-seg label orchestration
├── logic/
│   ├── yolo_inference.py           # Model resolution + inference + wall post-processing
│   ├── ifc_pipeline.py             # Wall graph + opening association + IFC4 writer
│   ├── ifc_service.py              # IFC service entry point
│   ├── production_orchestrator.py  # End-to-end pipeline for external frontend
│   ├── production_validation.py    # Quality gates (QualityValidator)
│   ├── dataset_io.py               # Runtime paths, IMG_EXTS, save helpers
│   ├── scale_calibration.py        # DEFAULT_MPP=0.01, resolve_mpp
│   ├── wall_connect.py             # L/T/X junction connector
│   └── p5b_skeleton.py             # Optional complex centerline recovery (default OFF)
└── web/
    ├── server.py                   # FastAPI app, all HTTP routes
    └── index.html                  # Single-page operator UI
```

## Key Class IDs (config/classes.py)
| ID | Name   | IFC Entity |
|----|--------|------------|
| 1  | Window | IfcWindow  |
| 2  | Door   | IfcDoor    |
| 3  | Wall   | IfcWall    |

## API Contract (External Frontend)
1. `POST /api/process-floorplan` — multipart `file` + optional `meters_per_pixel`
2. Wait for JSON (synchronous — IFC is fully generated before response returns)
3. `GET /api/ifc/file/{basename}` — download `.ifc` binary

Default host: `127.0.0.1:8000`. No auth. CORS open `*`.

## Model Resolution Order (yolo_inference.py)
1. `HCI21_MODEL_PATH` env var
2. `HCI_MODEL_PATH` env var (legacy alias)
3. `best_hci21.pt` (promoted active checkpoint)
4. CubiCasa HQA500 offline best.pt
5. CubiCasa smoke10 best.pt
- Never falls through to `best_gdrive.pt` (read-only production comparison model)

## IFC Pipeline Stages (ifc_pipeline.py)
1. Parse YOLO-seg labels → wall/door/window polygons
2. `build_wall_graph` — P2 thickness + P3 topology (snap, dedupe, P5A wall runs)
3. `associate_openings` — P4 multi-factor door/window → wall mapping
4. `write_ifc4` — emit IfcWall + IfcOpeningElement + IfcDoor/IfcWindow

## Important Constants
- `DEFAULT_MPP = 0.01` m/px (scale_calibration.py)
- `WALL_H = 3.0m`, `DOOR_H = 2.1m`, `WIN_H = 1.2m`, `WIN_SILL = 0.9m`
- `DEFAULT_AUTOLABEL_TIMEOUT_S = 600` (production_orchestrator.py)
- `THICK_FALLBACK = 0.23m` (global fallback wall thickness)

## Env Vars
- `HCI21_MODEL_PATH` — YOLO weights path (set by start scripts)
- `HCI_MODEL_PATH` — legacy alias
- `HCI21_DEBUG` — enables error tracebacks in API responses
- `HCI21_ALLOW_ANY_PYTHON` — interpreter override

## Test Suite
Run from `HCI_2.1/`: `python -m unittest discover -s tests -v`
Covers: class-ID stability, polygon editing, wall topology, label import, model resolution, checkpoint promotion.

## What IFC Contains (this pipeline)
- IfcWall, IfcDoor, IfcWindow, IfcOpeningElement
- Does NOT include: furniture, appliances, DetectionIR/BuildingModelIR pipeline
