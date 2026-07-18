# BIM Project (XEO-KIT + IFC Rendering Backend)

This project consists of two major modules:

1. BIM Viewer Frontend (React + Vite + Xeokit)
2. IFC Rendering Backend (Node.js + Express + Python Pipeline)

Together they allow users to:

- Upload and visualize IFC files
- Edit walls, doors and furniture
- Save project modifications
- Generate updated GLB models
- Generate interactive 360 walkthroughs

---

# Repository Structure

```
bim-project/

├── bim-viewer-app/        # React Frontend
├── ifc-render-app/        # Backend Rendering Pipeline
├── docs/
```

---

# Documentation

Please read these before starting.

- docs/LOCAL_SETUP.md
- docs/SYSTEM_ARCHITECTURE.md
- docs/KNOWN_ISSUES.md

---

# Technology Stack

Frontend

- React
- Vite
- Xeokit
- Web-IFC

Backend

- Node.js
- Express
- Three.js
- Web-IFC
- Python IFC Processing
- GLTF Generation

---

# Current Features

- IFC Loading
- Wall Editing
- Door Placement
- Furniture Placement
- GLB Export
- 360 Viewer
- Navigation Graph
- Room Navigation

---

# Future Improvements

- Better walkthrough generation
- Improved navigation graph
- Better room detection
- IFC asset orientation normalization