#!/usr/bin/env bash
# Restricted production deploy entrypoint. Install root-owned at /usr/local/sbin/hci-deploy.sh.
set -Eeuo pipefail

SHA="${1:-}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: hci-deploy.sh <40-character commit SHA>" >&2
  exit 2
fi

readonly INCOMING="/home/hci-deploy/incoming/$SHA"
readonly BACKEND="/hci_3d_project/3d_editor/xeo-kit-project/ifc-render-app"
readonly FRONTEND="/var/www/hci-3d-viewer"
readonly BACKUP_ROOT="/var/backups/hci-cicd"
readonly BACKUP="$BACKUP_ROOT/${SHA}_$(date +%Y%m%d_%H%M%S)"
readonly WORK="/var/tmp/hci-deploy-${SHA}-$$"
readonly STAGE_BACKEND="$WORK/backend"
readonly STAGE_FRONTEND="$WORK/frontend"

DEPLOY_STARTED=0

cleanup() {
  rm -rf "$WORK"
}

rollback_on_error() {
  local status=$?
  trap - ERR
  if [[ "$DEPLOY_STARTED" -eq 1 ]]; then
    echo "Deployment failed; attempting code/frontend rollback from $BACKUP" >&2
    set +e
    local restore_backend="$WORK/restore-backend"
    local restore_frontend="$WORK/restore-frontend"
    mkdir -p "$restore_backend" "$restore_frontend"

    if [[ -f "$BACKUP/backend-code.tar.gz" ]]; then
      tar -xzf "$BACKUP/backend-code.tar.gz" -C "$restore_backend"
      rsync -a --delete \
        --exclude='/.env*' --exclude='/assets/' --exclude='/uploads/' \
        --exclude='/jobs/' --exclude='/node_modules/' \
        --exclude='/material-library.json' --exclude='/hci_catalog_db.dump' \
        "$restore_backend/" "$BACKEND/"
    fi

    if [[ -d "$BACKUP/node_modules" ]]; then
      rm -rf "$BACKEND/node_modules"
      mv "$BACKUP/node_modules" "$BACKEND/node_modules"
    fi

    if [[ -f "$BACKUP/frontend.tar.gz" ]]; then
      tar -xzf "$BACKUP/frontend.tar.gz" -C "$restore_frontend"
      rsync -a --delete "$restore_frontend/" "$FRONTEND/"
    fi

    systemctl restart hci-backend
    echo "Rollback attempted. Review: journalctl -u hci-backend -n 100 --no-pager" >&2
    set -e
  fi
  exit "$status"
}
trap cleanup EXIT
trap rollback_on_error ERR

[[ -d "$BACKEND" ]] || { echo "Backend directory missing: $BACKEND" >&2; exit 1; }
[[ -d "$FRONTEND" ]] || { echo "Frontend directory missing: $FRONTEND" >&2; exit 1; }
[[ -f "$BACKEND/.env" ]] || { echo "Backend .env missing; refusing deploy." >&2; exit 1; }
[[ -d "$BACKEND/assets" && -d "$BACKEND/uploads" ]] || { echo "Persistent assets/uploads directories missing; refusing deploy." >&2; exit 1; }
[[ -d "$INCOMING" && ! -L "$INCOMING" ]] || { echo "Incoming bundle directory missing/unsafe." >&2; exit 1; }

for archive in backend-source.tar.gz frontend-dist.tar.gz; do
  file="$INCOMING/$archive"
  [[ -f "$file" && ! -L "$file" ]] || { echo "Missing or unsafe archive: $archive" >&2; exit 1; }
  if tar -tzf "$file" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then
    echo "Unsafe path in archive: $archive" >&2
    exit 1
  fi
done

command -v rsync >/dev/null 2>&1 || { echo "rsync is required. Install it before deploying." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }

mkdir -p "$WORK" "$BACKUP_ROOT" "$BACKEND/assets" "$BACKEND/uploads" "$BACKEND/jobs" "$FRONTEND"
chmod 700 "$BACKUP_ROOT"
mkdir -p "$STAGE_BACKEND" "$STAGE_FRONTEND"
tar -xzf "$INCOMING/backend-source.tar.gz" -C "$STAGE_BACKEND"
tar -xzf "$INCOMING/frontend-dist.tar.gz" -C "$STAGE_FRONTEND"

[[ -f "$STAGE_BACKEND/server.js" && -f "$STAGE_BACKEND/package.json" && -f "$STAGE_BACKEND/package-lock.json" ]] || {
  echo "Backend artifact is incomplete." >&2; exit 1;
}
[[ -f "$STAGE_FRONTEND/index.html" ]] || { echo "Frontend build artifact lacks index.html." >&2; exit 1; }

# Install/test dependencies in staging before touching production code.
echo "=== Installing staged backend dependencies ==="
(cd "$STAGE_BACKEND" && npm ci --include=dev --no-audit --no-fund)
for file in "$STAGE_BACKEND"/*.js; do
  [[ -f "$file" ]] && node --check "$file"
done

# Apply tracked SQL migrations once, in lexical order. DATABASE_URL is read via dotenv,
# and is never printed. Existing manual migrations are safe to re-run if not tracked yet.
if [[ -d "$STAGE_BACKEND/migrations" ]]; then
  BACKEND_ENV_FILE="$BACKEND/.env" \
  STAGE_BACKEND="$STAGE_BACKEND" \
  node <<'NODE'
const fs = require('fs');
const path = require('path');
const base = process.env.STAGE_BACKEND;
const dotenv = require(path.join(base, 'node_modules', 'dotenv'));
dotenv.config({ path: process.env.BACKEND_ENV_FILE, override: true });
const { Pool } = require(path.join(base, 'node_modules', 'pg'));

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing in backend environment file.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const dir = path.join(base, 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const filename of files) {
      const existing = await client.query(
        'SELECT 1 FROM public.schema_migrations WHERE filename = $1', [filename]
      );
      if (existing.rowCount) {
        console.log(`Migration already recorded: ${filename}`);
        continue;
      }
      console.log(`Applying migration: ${filename}`);
      const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO public.schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [filename]
      );
      console.log(`Migration completed: ${filename}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
NODE
fi

# Back up only deployable code and frontend. Persistent runtime data is intentionally excluded.
mkdir -p "$BACKUP"
tar -czf "$BACKUP/backend-code.tar.gz" \
  --exclude='assets' --exclude='uploads' --exclude='jobs' \
  --exclude='node_modules' --exclude='.env*' \
  --exclude='material-library.json' --exclude='hci_catalog_db.dump' \
  -C "$BACKEND" .
tar -czf "$BACKUP/frontend.tar.gz" -C "$FRONTEND" .

# Save the previous dependencies for rollback, then update only application source files.
DEPLOY_STARTED=1
if [[ -d "$BACKEND/node_modules" ]]; then
  mv "$BACKEND/node_modules" "$BACKUP/node_modules"
fi

rsync -a --delete \
  --exclude='/.env*' \
  --exclude='/assets/' \
  --exclude='/uploads/' \
  --exclude='/jobs/' \
  --exclude='/node_modules/' \
  --exclude='/material-library.json' \
  --exclude='/hci_catalog_db.dump' \
  "$STAGE_BACKEND/" "$BACKEND/"

mv "$STAGE_BACKEND/node_modules" "$BACKEND/node_modules"
rsync -a --delete "$STAGE_FRONTEND/" "$FRONTEND/"

# Verify backend via loopback and Nginx before declaring success.
systemctl restart hci-backend
backend_ok=0
for attempt in $(seq 1 30); do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/catalog/tree || true)"
  if [[ "$status" == "200" ]]; then backend_ok=1; break; fi
  sleep 2
done
[[ "$backend_ok" -eq 1 ]] || { echo "Backend health check failed." >&2; journalctl -u hci-backend -n 80 --no-pager >&2; exit 1; }

nginx_api_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: 103.212.137.8' http://127.0.0.1/api/catalog/tree)"
[[ "$nginx_api_status" == "200" ]] || { echo "Nginx API check failed: HTTP $nginx_api_status" >&2; exit 1; }
frontend_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: 103.212.137.8' http://127.0.0.1/)"
[[ "$frontend_status" == "200" ]] || { echo "Frontend check failed: HTTP $frontend_status" >&2; exit 1; }

DEPLOY_STARTED=0
rm -rf "$INCOMING"
echo "Deployment successful: $SHA"
echo "Backend, catalog API via Nginx, and frontend health checks passed."
echo "Server assets/, uploads/, jobs/, .env, material-library.json, and catalog dump were excluded from sync."

# Keep the most recent five deploy backups.
mapfile -t old_backups < <(ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +6)
for old in "${old_backups[@]}"; do rm -rf "$old"; done
