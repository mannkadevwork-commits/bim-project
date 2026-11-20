#!/usr/bin/env bash
# HCI_2.1 Linux launcher.
# Optional env overrides: HCI21_PYTHON, HCI21_MODEL_PATH, HCI21_HOST, HCI21_PORT, HCI21_VENV

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEB_DIR="$SCRIPT_DIR/../web"

: "${HCI21_HOST:=127.0.0.1}"
: "${HCI21_PORT:=8000}"
: "${HCI21_VENV:=$PROJECT_ROOT/hci-venv}"

# Auto-set model path if best_hci21.pt exists at project root
if [[ -z "$HCI21_MODEL_PATH" && -f "$PROJECT_ROOT/best_hci21.pt" ]]; then
    export HCI21_MODEL_PATH="$PROJECT_ROOT/best_hci21.pt"
fi

# --- Resolve Python interpreter ---
if [[ -n "$HCI21_PYTHON" ]]; then
    PYTHON="$HCI21_PYTHON"
elif [[ -f "$HCI21_VENV/bin/python" ]]; then
    PYTHON="$HCI21_VENV/bin/python"
    echo "[HCI_2.1] Using venv: $HCI21_VENV"
elif command -v conda &>/dev/null && conda env list | grep -q "improved_model_train"; then
    echo "[HCI_2.1] Using conda env: improved_model_train"
    exec conda run --no-capture-output -n improved_model_train \
        bash "$0" "$@"
elif [[ -n "$HCI21_ALLOW_ANY_PYTHON" ]]; then
    PYTHON="$(command -v python3)"
else
    echo "ERROR: No suitable Python found."
    echo "Options:"
    echo "  1. Create venv:  python3 -m venv $HCI21_VENV && $HCI21_VENV/bin/pip install -r $SCRIPT_DIR/../requirements.txt"
    echo "  2. Set HCI21_PYTHON=/path/to/python"
    echo "  3. Set HCI21_ALLOW_ANY_PYTHON=1 (only after confirming torch/ultralytics work)"
    exit 1
fi

export HCI21_ALLOW_ANY_PYTHON=1

echo "[HCI_2.1] Python:  $PYTHON"
"$PYTHON" -c "import torch; print('[HCI_2.1] torch:', torch.__version__)"
"$PYTHON" -c "import ultralytics; print('[HCI_2.1] ultralytics:', ultralytics.__version__)"
echo "[HCI_2.1] Model:   ${HCI21_MODEL_PATH:-<not set>}"
echo "[HCI_2.1] Starting on http://$HCI21_HOST:$HCI21_PORT"

cd "$WEB_DIR"
exec "$PYTHON" -m uvicorn server:app --host "$HCI21_HOST" --port "$HCI21_PORT"
