# Phase 1 — PostgreSQL Installation & Setup (Windows Local Dev)

This document covers everything needed to get PostgreSQL running locally on Windows
for the Furniture Catalog feature. No cloud DB is needed at this stage.

---

## Step 1 — Download & Install PostgreSQL

1. Go to: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads
2. Download **PostgreSQL 16** for Windows x86-64
3. Run the installer
4. During setup:
   - Installation directory: leave as default (`C:\Program Files\PostgreSQL\16`)
   - Components: keep all checked (Server, pgAdmin 4, Stack Builder, Command Line Tools)
   - Data directory: leave as default
   - **Password**: set a password for the `postgres` superuser — write this down, e.g. `postgres123`
   - Port: **5432** (default, keep it)
   - Locale: leave as default
5. Finish the installer. Stack Builder will open — you can skip it (click Cancel)

---

## Step 2 — Add PostgreSQL to Windows PATH

So you can run `psql` from any terminal:

1. Open **Start → Search → "Edit the system environment variables"**
2. Click **Environment Variables**
3. Under **System variables**, find `Path` → click **Edit**
4. Click **New** and add: `C:\Program Files\PostgreSQL\16\bin`
5. Click OK on all dialogs
6. Open a **new** Command Prompt and verify:
   ```
   psql --version
   ```
   Expected output: `psql (PostgreSQL) 16.x`

---

## Step 3 — Create the Application Database & User

Open Command Prompt and connect as the postgres superuser:

```cmd
psql -U postgres
```

Enter the password you set during install. Then run these SQL commands:

```sql
-- Create a dedicated database for the app
CREATE DATABASE hci_catalog;

-- Create a dedicated user (don't use the superuser in the app)
CREATE USER hci_user WITH PASSWORD 'hci_pass_2024';

-- Grant full access on the database
GRANT ALL PRIVILEGES ON DATABASE hci_catalog TO hci_user;

-- Connect to the new database
\c hci_catalog

-- Grant schema permissions (required in Postgres 15+)
GRANT ALL ON SCHEMA public TO hci_user;

-- Exit
\q
```

---

## Step 4 — Verify the Connection

Test that the app user can connect:

```cmd
psql -U hci_user -d hci_catalog -h localhost
```

Enter password `hci_pass_2024`. You should see the `hci_catalog=#` prompt. Type `\q` to exit.

---

## Step 5 — Add DATABASE_URL to the Backend .env

Open `ifc-render-app/.env` and add this line:

```
DATABASE_URL=postgresql://hci_user:hci_pass_2024@localhost:5432/hci_catalog
```

Also update `ifc-render-app/.env.example` (without real credentials):

```
DATABASE_URL=postgresql://<db_user>:<db_password>@localhost:5432/hci_catalog
```

---

## Step 6 — Install the `pg` Node Package

Inside `ifc-render-app/`:

```cmd
cd c:\work\hci_v1\bim-project\xeo-kit-project\ifc-render-app
npm install pg
```

This is the only new Node dependency needed for Phase 1.

---

## Step 7 — Run the Database Migration

Once `db.js` and the migration SQL file are created (see CATALOG_PHASE1_BACKEND.md),
run the schema migration:

```cmd
psql -U hci_user -d hci_catalog -h localhost -f migrations/001_catalog.sql
```

You should see output like:
```
CREATE TABLE
CREATE TABLE
CREATE INDEX
CREATE INDEX
INSERT 0 1
INSERT 0 3
INSERT 0 2
```

---

## Step 8 — Verify Tables Were Created

```cmd
psql -U hci_user -d hci_catalog -h localhost
```

```sql
\dt
```

Expected output:
```
          List of relations
 Schema |     Name      | Type  |  Owner
--------+---------------+-------+----------
 public | categories    | table | hci_user
 public | catalog_items | table | hci_user
```

Type `\q` to exit.

---

## pgAdmin 4 (Optional GUI)

pgAdmin 4 was installed alongside PostgreSQL. You can use it to browse tables visually:

1. Open **pgAdmin 4** from Start menu
2. Set a master password when prompted
3. In the left tree: Servers → PostgreSQL 16 → enter your `postgres` password
4. Navigate to: Databases → hci_catalog → Schemas → public → Tables

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `psql` not found | PATH not set — redo Step 2, open a new terminal |
| `password authentication failed` | Wrong password — reset via pgAdmin or reinstall |
| `connection refused` | PostgreSQL service not running — open Services, start `postgresql-x64-16` |
| Port 5432 in use | Another Postgres instance running — stop it or change port in `postgresql.conf` |
| `permission denied for schema public` | Run the `GRANT ALL ON SCHEMA public` command in Step 3 |

---

## PostgreSQL Service Management (Windows)

```cmd
# Check if running
sc query postgresql-x64-16

# Start the service
net start postgresql-x64-16

# Stop the service
net stop postgresql-x64-16
```

Or use **Services** app (Win+R → `services.msc`) and find `postgresql-x64-16`.

---

## Next Step

Once PostgreSQL is running and the database is created, proceed to:
**`CATALOG_PHASE1_BACKEND.md`** — DB schema, migration SQL, and all new backend files.
