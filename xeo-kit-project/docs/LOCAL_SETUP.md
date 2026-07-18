# Local Development Setup

## Prerequisites

Install the following:

- Git
- Node.js (LTS Recommended)
- Python 3.10+
- npm

---

# Clone Repository

```bash
git clone <repo-url>

cd bim-project
```

---

# Frontend Setup

Navigate to frontend.

```bash
cd bim-viewer-app
```

Install dependencies.

```bash
npm install
```

Start frontend.

```bash
npm run dev
```

The frontend uses Vite for development. :contentReference[oaicite:0]{index=0}

Default URL

```
http://localhost:5173
```

---

# Backend Setup

Navigate to backend.

```bash
cd ifc-render-app
```

Install dependencies.

```bash
npm install
```

The backend uses Express, Three.js, Web-IFC and TypeScript tooling. :contentReference[oaicite:1]{index=1}

Start backend.

Example

```bash
node server.js
```

or

```bash
npx tsx compiler.ts
```

depending on the module you are running.

---

# Environment Variables

Create

```
.env
```

Configure

```
APS_CLIENT_ID=

APS_CLIENT_SECRET=

ASSET_DIR=
```

Additional environment variables may be required depending on deployment.

---

# Running Both

Terminal 1

```bash
cd ifc-render-app

node server.js
```

Terminal 2

```bash
cd bim-viewer-app

npm run dev
```

Open browser

```
http://localhost:5173
```

---

# Production

Backend

PM2

```
pm2 start server.js
```

Frontend

```
npm run build
```

Deploy the generated dist folder.