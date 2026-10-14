# HCI Floor Plan Trainer (HCI 2.1)

A FastAPI web application for floor-plan image upload, YOLO segmentation-assisted labeling, polygon correction, model fine-tuning, scale calibration, metadata editing, and IFC export.

## Project structure

```text
.
├── best_hci21.pt             # Bundled active inference checkpoint
├── HCI_2.1/
│   ├── web/                  # FastAPI API + browser UI
│   ├── logic/                # Inference, dataset, IFC, metadata and validation
│   ├── config/               # Canonical class taxonomy
│   ├── scripts/              # Launch and maintenance helpers
│   ├── tests/                # Unit and regression tests
│   ├── docs/                 # API reference and architecture notes
│   ├── requirements.txt
│   ├── DEPLOY.md
│   └── START_HCI_2.1.bat
└── .gitignore
```

The `gdrive_dataset/` directory is intentionally excluded from the source bundle. The server creates its runtime folders on startup. Generated labels, uploads, IFC exports, metadata, and training runs belong in that runtime directory—not in source control.

## Quick start (Windows)

1. Install Python 3.11 (64-bit) and Miniconda/Anaconda.
2. Create the supported environment:
   ```powershell
   conda create -n improved_model_train python=3.11 -y
   conda activate improved_model_train
   ```
3. Install the matching CPU or CUDA version of PyTorch from [pytorch.org](https://pytorch.org), then install application dependencies:
   ```powershell
   cd HCI_2.1
   pip install -r requirements.txt
   ```
4. Start the app with `START_HCI_2.1.bat`, or run:
   ```powershell
   cd web
   python -m uvicorn server:app --host 127.0.0.1 --port 8000
   ```
5. Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

The included `best_hci21.pt` is discovered automatically. To use another checkpoint, set `HCI21_MODEL_PATH` to its absolute path before starting the server. The Windows launcher also supports `HCI21_PYTHON`, `HCI21_HOST`, and `HCI21_PORT` overrides.

## Linux / server

Use Python 3.11 in a Conda environment named `improved_model_train`, install the matching PyTorch build and `HCI_2.1/requirements.txt`, then start from `HCI_2.1/web` with Uvicorn. See [`HCI_2.1/DEPLOY.md`](HCI_2.1/DEPLOY.md) for deployment details.

## Verification

From `HCI_2.1/`:

```bash
python -m unittest discover -s tests -v
```

## Deployment security

This application has no built-in user authentication and exposes upload, correction, model-training, and IFC-generation endpoints. Keep it on localhost or a private, access-controlled network. Do not expose it directly to the public internet without an authentication layer and appropriate reverse-proxy/firewall configuration.
