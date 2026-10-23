# HCI 3D BIM Viewer — Ubuntu CI/CD Setup

This package replaces the existing Windows self-hosted `.github/workflows/deploy.yml` pipeline with a GitHub-hosted CI workflow and gated SSH deployment to the Ubuntu production server.

## What the workflow does

1. On pull requests to `main`, runs `npm ci` + `npm run build` for the Vite frontend, installs backend dependencies, and checks top-level backend JS syntax. Pull requests never deploy.
2. On pushes to `main` (after the PR is merged) or manual runs against `main`, deploys the exact artifact produced by the successful validation job.
3. Builds the frontend with `VITE_API_URL` from the repository variable when set, otherwise `http://103.212.137.8`.
4. Applies tracked SQL migrations once using `schema_migrations`, then deploys backend and frontend, restarts `hci-backend`, and checks the API directly, the API via Nginx, and the homepage.
5. Keeps backups of the previous app code, node_modules, and frontend. If health checks fail after deployment starts, it attempts to roll back code/dependencies/frontend.

## Server-only data that is protected from synchronization

The backend sync explicitly excludes and does not replace:

- `ifc-render-app/assets/`
- `ifc-render-app/uploads/`
- `ifc-render-app/jobs/`
- `ifc-render-app/.env`
- `ifc-render-app/material-library.json`
- `ifc-render-app/hci_catalog_db.dump`

The frontend deployment replaces only `/var/www/hci-3d-viewer/` contents.

## Before merging to main

1. Copy `xeo-kit-project/ifc-render-app/migrations/20261022_upgrade_material_assets.sql` into the same path in your working repository. Do not overwrite the older `20261015` migration.
2. Copy `xeo-kit-project/ifc-render-app/ops/hci-deploy.sh` into the same path in your working repository.
3. Replace `.github/workflows/deploy.yml` with this package's workflow.
4. Commit and push these files to a setup branch and open a PR to `main`. Make sure the PR's **Build and verify** job succeeds. Do not merge until the server key and repository secrets are configured.

## Prepare the server (run as root)

Install rsync if necessary and create the restricted deploy account:

```bash
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y rsync
id hci-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash hci-deploy
install -d -o hci-deploy -g hci-deploy -m 700 /home/hci-deploy/.ssh
install -d -o hci-deploy -g hci-deploy -m 700 /home/hci-deploy/incoming
```

Upload the deploy script from Windows PowerShell after copying this package into your local repo:

```powershell
$backend = "D:\manish_work\high-creation_project\xeo-kit-project\ifc-render-app"
scp "$backend\ops\hci-deploy.sh" root@103.212.137.8:/tmp/hci-deploy.sh
```

Then on Ubuntu as root:

```bash
install -o root -g root -m 0755 /tmp/hci-deploy.sh /usr/local/sbin/hci-deploy.sh
cat > /etc/sudoers.d/hci-deploy <<'EOF'
hci-deploy ALL=(root) NOPASSWD: /usr/local/sbin/hci-deploy.sh *
EOF
chmod 0440 /etc/sudoers.d/hci-deploy
visudo -cf /etc/sudoers.d/hci-deploy
```

The deploy script is root-owned, validates the supplied commit SHA, validates tar paths, and preserves the server's runtime data directories.

## Create a dedicated deployment SSH key (Windows PowerShell)

```powershell
$keyDir = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
ssh-keygen -t ed25519 -C github-actions-hci-deploy -f "$env:USERPROFILE\.ssh\hci_cicd_ed25519"
```

When prompted for a passphrase, press Enter twice to create a key suitable for unattended automation. Protect the private key and store it only as a GitHub Actions secret; never commit it to the repository.

Add the public key to the deploy account:

```powershell
Get-Content "$env:USERPROFILE\.ssh\hci_cicd_ed25519.pub" | ssh root@103.212.137.8 "cat >> /home/hci-deploy/.ssh/authorized_keys && chown -R hci-deploy:hci-deploy /home/hci-deploy/.ssh && chmod 700 /home/hci-deploy/.ssh && chmod 600 /home/hci-deploy/.ssh/authorized_keys"
```

Test the key:

```powershell
ssh -i "$env:USERPROFILE\.ssh\hci_cicd_ed25519" hci-deploy@103.212.137.8 "id -un"
```

Expected output: `hci-deploy`.

## Pin the server host key

On Ubuntu as root, display the server's Ed25519 SSH host-key fingerprint:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On Windows PowerShell, collect its known-host entry and compare fingerprints before trusting it:

```powershell
$knownHosts = Join-Path $env:USERPROFILE ".ssh\hci_cicd_known_hosts"
ssh-keyscan -t ed25519 103.212.137.8 2>$null | Set-Content -Encoding ascii $knownHosts
ssh-keygen -lf $knownHosts
Get-Content $knownHosts
```

The SHA256 fingerprint must match the fingerprint printed on the Ubuntu server. Store the complete contents of `hci_cicd_known_hosts` in the GitHub secret below. Do not use the key without verifying the fingerprint.

## Configure repository Actions secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Add:

- `DEPLOY_HOST` = `103.212.137.8`
- `DEPLOY_PORT` = `22`
- `DEPLOY_USER` = `hci-deploy`
- `DEPLOY_SSH_KEY` = complete private key text from `%USERPROFILE%\.ssh\hci_cicd_ed25519` (keep it secret)
- `DEPLOY_KNOWN_HOSTS` = complete verified known-host entry from `hci_cicd_known_hosts`

Optional repository variable (not a secret):
- `VITE_API_URL` = `http://103.212.137.8`

If you later set up HTTPS, change `VITE_API_URL` to the HTTPS origin before rebuilding.

## Merge and test

- Ensure the PR's build/validation job is green.
- Ensure the deploy user can SSH without a password and can run `sudo -n /usr/local/sbin/hci-deploy.sh <sha>` only after a valid bundle exists.
- Confirm the five repository secrets are set.
- Merge the PR to `main`. The deployment job will start only after all CI checks succeed.
- Watch **GitHub → Actions → HCI 3D BIM Viewer CI/CD**.
- After deployment, verify `http://103.212.137.8`, `http://103.212.137.8/api/catalog/tree`, and `http://103.212.137.8/api/admin/materials`.

## Notes / limitations

- The database migration tracking table is created automatically at first deployment. Existing SQL migrations that are not yet recorded will run in filename order; this is why migrations must be repeatable or written to run only once.
- This pipeline runs frontend production build checks and backend JavaScript syntax checks; it is not a substitute for end-to-end BIM rendering tests.
- The backend currently uses `tsx` at runtime, so backend dependencies are installed with dev dependencies included.
- HTTP is still used for the current public frontend/API endpoint. Set up HTTPS before entering real user credentials or other sensitive data.
