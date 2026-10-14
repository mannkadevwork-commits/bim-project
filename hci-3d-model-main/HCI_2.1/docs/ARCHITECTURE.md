# HCI_2.1 Architecture

## Runtime flow

1. `web/server.py` serves the browser UI from `web/index.html` and exposes the FastAPI endpoints.
2. `logic/dataset_io.py` manages the sibling `gdrive_dataset/` runtime tree.
3. `auto_label.py` calls `logic/yolo_inference.py` to load a segmentation checkpoint and create YOLO-format labels and overlay images.
4. Browser edits are validated and saved as label polygons by the correction endpoints in `web/server.py`.
5. `logic/scale_calibration.py`, `logic/image_metadata.py`, and `logic/ifc_properties.py` handle calibration and metadata/property sets.
6. `logic/ifc_service.py` and `logic/ifc_pipeline.py` create IFC output; `logic/production_orchestrator.py` and `logic/production_validation.py` apply workflow and quality checks.

## Model resolution

`logic/yolo_inference.py` resolves inference weights in this order:

1. `HCI21_MODEL_PATH` if set to an existing file.
2. `HCI_MODEL_PATH` as a legacy alias if it points to an existing file.
3. The sibling `best_hci21.pt` active checkpoint.
4. The CubiCasa HQA500 offline checkpoint, if provisioned.
5. The CubiCasa smoke-test checkpoint, if provisioned.

The HCI_2.1 promotion flow writes `best_hci21.pt`; it must not overwrite `best_gdrive.pt`, which is treated as a separate read-only production comparison model.

## Runtime data

At startup, the app creates `gdrive_dataset/` subdirectories for raw uploads, training images, labels, marked previews, metadata, IFC output, and training runs. Those are persistent runtime data and are deliberately not included in this cleaned source archive.

## Main modules

| Module | Responsibility |
|---|---|
| `config/classes.py` | Canonical class taxonomy and IDs |
| `auto_label.py` | Inference-to-label orchestration |
| `logic/yolo_inference.py` | Model resolution, segmentation inference and contour helpers |
| `logic/dataset_io.py` | Runtime file/dataset paths and I/O |
| `logic/ifc_pipeline.py` | Geometry/topology processing for IFC generation |
| `logic/ifc_service.py` | IFC generation service layer |
| `logic/production_orchestrator.py` | End-to-end production workflow coordination |
| `logic/production_validation.py` | Quality gates and validation |
| `web/server.py` | HTTP API, UI state, upload/edit/train/export routes |
| `web/index.html` | Single-page operator UI |

## Regression tests

Run `python -m unittest discover -s tests -v` from this directory. Tests focus on class-ID stability, polygon editing, wall connectivity/topology, label import, model resolution and checkpoint promotion behavior.
