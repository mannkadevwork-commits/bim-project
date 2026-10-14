# HCI_2.1 Deployment Guide

This package is structured as a project root containing `HCI_2.1/` and the active `best_hci21.pt` checkpoint. Keep this parent-child relationship: both the app and inference code resolve the runtime data/model paths from the parent of `HCI_2.1`.

## 1. Requirements

- Python 3.11, 64-bit (recommended)
- A working PyTorch build for the deployment host (CPU or matching CUDA)
- Enough disk space for uploaded images, training runs, generated metadata, and IFC exports
- Linux or Windows; launch scripts are provided for Windows

## 2. Install dependencies

Create and activate the named Conda environment (the default interpreter guard checks for this environment name):

```bash
conda create -n improved_model_train python=3.11 -y
conda activate improved_model_train
```

Install the PyTorch build appropriate for the machine from [pytorch.org](https://pytorch.org), then install the app packages:

```bash
cd HCI_2.1
python -m pip install -r requirements.txt
```

If using a validated non-Conda environment, set `HCI21_ALLOW_ANY_PYTHON=1` before starting the app. Do this only after confirming that PyTorch and Ultralytics import correctly in that interpreter.

## 3. Model checkpoints

The source bundle contains `best_hci21.pt` at the project root. It is used automatically if no override is provided. An explicit checkpoint takes precedence:

```bash
# Linux/macOS
export HCI21_MODEL_PATH=/absolute/path/to/best.pt

# Windows PowerShell
$env:HCI21_MODEL_PATH = "D:\models\best.pt"
```

The `HCI21_MODEL_PATH` file must exist. `HCI_MODEL_PATH` is supported as a legacy alias. `best_gdrive.pt` is a separate read-only comparison model and is never the HCI_2.1 Auto Label default. Training-from-scratch workflows may also require `yolov8n-seg.pt`; provision that file separately if you use those features.

## 4. Runtime data

The app creates the following sibling tree automatically on startup. It is not included in this source package because it contains uploads, labels, generated output and training artifacts.

```text
gdrive_dataset/
├── images_raw/
├── images/train/
├── labels/train/
├── marked/
├── metadata/
├── output/
└── runs/
```

Back up `gdrive_dataset/` according to your retention policy. Do not commit it to source control.

## 5. Start the server

### Windows

Use `START_HCI_2.1.bat`, which calls `scripts/start_server.bat`. It can use the active Conda environment or the named environment. Optional environment variables:

- `HCI21_PYTHON`: absolute path to the Python executable
- `HCI21_MODEL_PATH`: override model checkpoint
- `HCI21_HOST`: bind address (defaults to `127.0.0.1`)
- `HCI21_PORT`: port (defaults to `8000`)

PowerShell users can run `scripts/start_server.ps1`.

### Linux / manual

```bash
conda activate improved_model_train
cd HCI_2.1/web
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`. For an internal server behind an authenticated reverse proxy, the host may be changed to `0.0.0.0`; do not expose the application directly to the public internet.

## 6. Optional packages

`gdown` supports Google Drive folder download. `cairosvg` supports SVG preview/thumbnail features and may require system Cairo libraries on Linux. IFC generation requires `ifcopenshell`, which is included in `requirements.txt`.

## 7. Security and operations

This is an operator-facing application with no built-in authentication. It exposes upload, labeling, correction, model training and IFC export endpoints. Restrict it to localhost/private networks or deploy behind authentication, TLS, rate limits and a firewall. Back up the runtime dataset and checkpoint files before changing deployment versions.
