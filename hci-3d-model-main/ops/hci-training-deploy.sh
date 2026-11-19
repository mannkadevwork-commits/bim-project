#!/usr/bin/env bash
# Restricted, root-owned deployment entry point for the HCI 2.1 training service.
set -Eeuo pipefail

SHA="${1:-}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: hci-training-deploy.sh <40-character commit SHA>" >&2
  exit 2
fi

readonly INCOMING="/home/hci-deploy/training-incoming/$SHA"
readonly ARCHIVE="$INCOMING/HCI_2.1-source.tar.gz"
readonly TRAINING_PARENT="/opt/hci-training-repo/hci-3d-model-main"
readonly TRAINING_APP="$TRAINING_PARENT/HCI_2.1"
readonly DATA_ROOT="/var/lib/hci-training"
readonly VENV_PYTHON="/opt/hci-training-venv/bin/python"
readonly SERVICE="hci-training"
readonly BACKUP_ROOT="/var/backups/hci-training-cicd"
readonly BACKUP="$BACKUP_ROOT/${SHA}_$(date +%Y%m%d_%H%M%S)"
readonly WORK="/var/tmp/hci-training-deploy-${SHA}-$$"
readonly STAGE_ROOT="$WORK/stage"
readonly STAGE_APP="$STAGE_ROOT/HCI_2.1"
readonly REQUIREMENTS_STATE="$DATA_ROOT/deploy/requirements.sha256"

DEPLOY_STARTED=0

cleanup() {
  rm -rf "$WORK"
}

rollback_on_error() {
  local status="${1:-$?}"
  trap - ERR
  if [[ "$DEPLOY_STARTED" -eq 1 ]]; then
    echo "Training deployment failed; restoring previous HCI_2.1 source from $BACKUP" >&2
    set +e
    local restore_root="$WORK/restore"
    mkdir -p "$restore_root"
    if [[ -f "$BACKUP/HCI_2.1-source.tar.gz" ]]; then
      tar -xzf "$BACKUP/HCI_2.1-source.tar.gz" -C "$restore_root"
      rsync -a --delete \
        --exclude='/.env*' \
        --exclude='/__pycache__/' \
        --exclude='*.pyc' \
        "$restore_root/HCI_2.1/" "$TRAINING_APP/"
      systemctl restart "$SERVICE"
      echo "Rollback attempted. Check: journalctl -u $SERVICE -n 100 --no-pager" >&2
    else
      echo "No source backup found; automatic rollback was not possible." >&2
    fi
    set -e
  fi
  exit "$status"
}

trap cleanup EXIT
trap rollback_on_error ERR

# Refuse deployment unless the existing training installation is present.
[[ -d "$TRAINING_PARENT" ]] || { echo "Training project root missing: $TRAINING_PARENT" >&2; exit 1; }
[[ -d "$TRAINING_APP" ]] || { echo "Training app directory missing: $TRAINING_APP" >&2; exit 1; }
[[ -x "$VENV_PYTHON" ]] || { echo "Training Python environment missing: $VENV_PYTHON" >&2; exit 1; }
[[ -d "$DATA_ROOT/gdrive_dataset" ]] || { echo "Persistent dataset storage missing: $DATA_ROOT/gdrive_dataset" >&2; exit 1; }
[[ -d "$TRAINING_PARENT/gdrive_dataset" ]] || { echo "Training dataset link/path missing: $TRAINING_PARENT/gdrive_dataset" >&2; exit 1; }
systemctl cat "$SERVICE" >/dev/null
[[ -d "$INCOMING" && ! -L "$INCOMING" ]] || { echo "Incoming directory missing or unsafe: $INCOMING" >&2; exit 1; }
[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" ]] || { echo "Training archive missing or unsafe: $ARCHIVE" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "rsync is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for archive validation." >&2; exit 1; }

mkdir -p "$WORK" "$STAGE_ROOT" "$BACKUP_ROOT" "$DATA_ROOT/deploy"
chmod 700 "$BACKUP_ROOT"

# Reject traversal paths, symlinks, hard links, and special files before extraction.
python3 - "$ARCHIVE" <<'PY'
import sys
import tarfile
from pathlib import PurePosixPath

archive = sys.argv[1]
required = {"HCI_2.1/web/server.py", "HCI_2.1/requirements.txt"}
seen = set()
with tarfile.open(archive, "r:gz") as tf:
    for item in tf.getmembers():
        path = PurePosixPath(item.name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise SystemExit(f"Unsafe archive path: {item.name}")
        if path.parts[0] != "HCI_2.1":
            raise SystemExit(f"Unexpected archive root: {item.name}")
        if not (item.isdir() or item.isfile()):
            raise SystemExit(f"Links and special files are not allowed: {item.name}")
        if item.isfile():
            seen.add(item.name)
if not required.issubset(seen):
    raise SystemExit(f"Archive is missing required files: {sorted(required - seen)}")
PY

tar -xzf "$ARCHIVE" -C "$STAGE_ROOT" --no-same-owner --no-same-permissions
[[ -f "$STAGE_APP/web/server.py" && -f "$STAGE_APP/web/index.html" && -f "$STAGE_APP/requirements.txt" ]] || {
  echo "Staged HCI_2.1 source is incomplete." >&2; exit 1;
}

# Compile the staged source before touching the running application.
"$VENV_PYTHON" -m compileall -q "$STAGE_APP"

# Install Python dependencies only when requirements.txt changes. Keep the server's
# validated CUDA/PyTorch build intact; torch is deliberately removed from this install.
REQUIREMENTS_HASH="$(sha256sum "$STAGE_APP/requirements.txt" | awk '{print $1}')"
PREVIOUS_REQUIREMENTS_HASH=""
if [[ -f "$REQUIREMENTS_STATE" ]]; then
  PREVIOUS_REQUIREMENTS_HASH="$(cat "$REQUIREMENTS_STATE")"
fi
if [[ "$REQUIREMENTS_HASH" != "$PREVIOUS_REQUIREMENTS_HASH" ]]; then
  TORCH_VERSION_BEFORE="$("$VENV_PYTHON" -c 'import torch; print(torch.__version__)')"
  grep -Ev '^[[:space:]]*torch([[:space:]<>=!~].*)?$' "$STAGE_APP/requirements.txt" > "$WORK/requirements-runtime.txt"
  echo "Installing HCI_2.1 requirements (excluding torch; current torch is $TORCH_VERSION_BEFORE)."
  "$VENV_PYTHON" -m pip install --disable-pip-version-check --no-input -r "$WORK/requirements-runtime.txt"
  "$VENV_PYTHON" -m pip check
  TORCH_VERSION_AFTER="$("$VENV_PYTHON" -c 'import torch; print(torch.__version__)')"
  [[ "$TORCH_VERSION_BEFORE" == "$TORCH_VERSION_AFTER" ]] || {
    echo "PyTorch changed unexpectedly ($TORCH_VERSION_BEFORE -> $TORCH_VERSION_AFTER)." >&2
    exit 1
  }
  printf '%s\n' "$REQUIREMENTS_HASH" > "$WORK/requirements.sha256"
fi

# Back up only application source. Runtime data, checkpoints, and the GPU venv are
# sibling paths and are never synchronized or replaced by this deployment.
mkdir -p "$BACKUP"
tar -czf "$BACKUP/HCI_2.1-source.tar.gz" \
  --exclude='./__pycache__' \
  --exclude='*.pyc' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  -C "$TRAINING_PARENT" HCI_2.1

DEPLOY_STARTED=1
systemctl stop "$SERVICE"
rsync -a --delete \
  --exclude='/.env*' \
  --exclude='/__pycache__/' \
  --exclude='*.pyc' \
  "$STAGE_APP/" "$TRAINING_APP/"
chown -R root:root "$TRAINING_APP"
find "$TRAINING_APP" -type d -exec chmod 0755 {} +
find "$TRAINING_APP" -type f -exec chmod 0644 {} +

if [[ -f "$WORK/requirements.sha256" ]]; then
  install -o root -g root -m 0644 "$WORK/requirements.sha256" "$REQUIREMENTS_STATE"
fi

systemctl restart "$SERVICE"

health_ok=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8000/api/production/health -o "$WORK/health.json"; then
    if python3 - "$WORK/health.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    health = json.load(handle)
if health.get("version") != "2.1":
    raise SystemExit("Unexpected HCI 2.1 health version")
if health.get("dataset_directory_exists") is not True:
    raise SystemExit("Persistent training dataset directory is not available")
if health.get("output_directory_exists") is not True:
    raise SystemExit("Training output directory is not available")
print(
    "Training API responded:",
    "status=" + str(health.get("status")),
    "model_available=" + str(health.get("model_available")),
)
PY
    then
      health_ok=1
      break
    fi
  fi
  sleep 2
done
if [[ "$health_ok" -ne 1 ]]; then
  echo "HCI 2.1 health check failed." >&2
  journalctl -u "$SERVICE" -n 100 --no-pager >&2
  rollback_on_error 1
fi

DEPLOY_STARTED=0
rm -rf "$INCOMING"
echo "HCI 2.1 deployment successful: $SHA"
echo "Training service restarted and /api/production/health passed."
echo "Dataset, model files, training outputs, and PyTorch environment were preserved."
echo "Note: model_available=false is reported by the health endpoint if no checkpoint has been provisioned."

# Keep the five most recent source backups.
mapfile -t old_backups < <(ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +6)
for old in "${old_backups[@]}"; do rm -rf "$old"; done
