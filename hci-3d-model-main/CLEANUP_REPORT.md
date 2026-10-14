# Cleanup Report

## What changed

- Renamed the legacy `H_new/` application folder to `HCI_2.1/`, matching the runtime path assumptions and deployment documentation.
- Removed the bundled `gdrive_dataset/` tree (raw and training images, labels, marked previews, per-image metadata, generated IFCs/debug files, and Ultralytics run outputs). It contained development/runtime data rather than source code and is recreated by the app at startup.
- Removed the `_p1` through `_p5b` experiment folders, JSON reports/diagnostics, and replay scripts. These were historical iteration artifacts and are not imported by the runtime app.
- Removed `.vscode/`, an unreferenced `web/Test_Model.png`, the duplicate `web/ifc_properties.py`, and the unreferenced `logic/wall_cv_assist.py` module.
- Consolidated the docs: kept the API integration reference, wrote a current architecture overview, rewrote deployment guidance, and added a root README.
- Removed developer-account and machine-specific paths from the interpreter guard and Windows launch scripts. Launch scripts now support explicit Python/model/host/port overrides and a Conda fallback.
- Simplified dependency declarations with major-version bounds and kept the existing regression tests and useful maintenance scripts.

## Retained

- Application runtime modules under `HCI_2.1/logic`, `config`, `web`, and `auto_label.py`.
- All regression tests and operational scripts.
- `best_hci21.pt`, the active checkpoint bundled at the project root.

## Validation

- Python compilation: **41 files checked, passed**.
- Unit/regression tests: **201 passed, 1 skipped**.
- Local FastAPI smoke test: `/api/status` returned **HTTP 200** and resolved `best_hci21.pt` correctly.

The local validation environment did not have `ultralytics` or `ifcopenshell` installed, so this cleanup verification does not certify model inference or IFC export end-to-end. Install the declared requirements and the appropriate PyTorch build before using those functions.
