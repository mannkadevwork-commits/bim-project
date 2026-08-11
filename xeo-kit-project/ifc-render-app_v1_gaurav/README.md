# IFC Render Pipeline

Render high-quality images from IFC (Building Information Model) files using Autodesk 3ds Max Design Automation, with an interactive 360° Three.js viewer.

## Features

- **Single-angle renders** — High-quality 1920×1080 PNG via 3ds Max cloud rendering
- **360° interactive viewer** — Real-time Three.js viewer with drag-to-rotate, zoom, pan
- **10 camera presets** — Front, rear, bird's eye, isometric, eye-level, etc.
- **Configurable lighting** — Shared config for consistent look across render and 360 view
- **IFC → OBJ conversion** — Automatic via IfcOpenShell

## Prerequisites

- **Node.js** (v16+)
- **Python 3** with `ifcopenshell` package
- **APS (Autodesk Platform Services) account** with Design Automation API access

### Install dependencies

```bash
npm install
pip3 install ifcopenshell
```

### Configure credentials

```bash
cp .env.example .env
# Edit .env with your APS credentials
```

## Usage

Place your IFC file as `input.ifc` in the project root.

### Rendered Image (via 3ds Max cloud)

```bash
node aps-pipeline.js <angle>
```

Output: `result.png`

Available angles:

| Angle | Description |
|---|---|
| `top-front-right` | Classic 3/4 view (default) |
| `top-front-left` | Mirror of default |
| `front` | Front elevation |
| `rear` | Back elevation |
| `left` | Left side |
| `right` | Right side |
| `birds-eye` | High aerial view |
| `top-down` | Plan view |
| `eye-level` | Human perspective |
| `isometric` | Equal-angle technical view |

### 360° Interactive Viewer (instant, local)

```bash
node aps-pipeline.js 360
npx http-server -p 8080 -o 360_viewer.html
```

Output: `360_viewer.html` — open in browser via HTTP server.

Controls:
- **Drag** to rotate
- **Scroll** to zoom
- **Right-drag** to pan
- **Buttons** for preset views and auto-rotate

## Configuration

Edit `render-config.json` to customize lighting, materials, and background. Changes apply to both render modes.

```json
{
  "lighting": {
    "keyLight": { "color": [255, 245, 230], "intensity": 1.2 },
    "fillLight": { "color": [200, 210, 230], "intensity": 0.4 },
    "backLight": { "color": [220, 230, 255], "intensity": 0.3 }
  },
  "material": { "color": [220, 215, 205], "roughness": 0.7 },
  "background": { "color": [240, 240, 240] }
}
```

## Project Structure

```
├── aps-pipeline.js            # Main pipeline script
├── ifc2obj.py                 # IFC to OBJ converter
├── render-config.json         # Shared lighting/material config
├── IFCRenderBundle.bundle/    # 3ds Max render script
│   ├── render.ms
│   └── PackageContents.xml
├── input.ifc                  # Input IFC file
├── .env                       # APS credentials (not in git)
└── package.json
```

## How It Works

1. **IFC → OBJ**: Python script converts IFC geometry using IfcOpenShell
2. **Single render**: OBJ uploaded to APS OSS → 3ds Max Design Automation renders with lighting/camera → PNG downloaded
3. **360 view**: OBJ embedded in a self-contained Three.js HTML viewer
