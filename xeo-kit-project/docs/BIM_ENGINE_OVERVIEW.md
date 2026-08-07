# BIM Engine Overview
**File:** `ifc-render-app/latest_interior_v2/automated_bim_v4_connected.py`

---

## What This File Does

This is the **core BIM generation engine**. It takes a floor plan image (JPG/PNG), sends it to Google Gemini AI for visual analysis, extracts all architectural data, and compiles a fully structured **IFC4 file** — the industry-standard format for Building Information Modeling.

---

## End-to-End Pipeline

```
Floor Plan Image (.jpg / .png)
        │
        ▼
[Stage 1]  Gemini AI Visual Extraction
           - Reads image bytes
           - Sends to gemini-3-flash-preview
           - Returns structured JSON (walls, openings, interiors)
           - Auto-retries if result looks incomplete
        │
        ▼
[Stage 2]  JSON Cache
           - Saves extraction result as *_Detailed_Cache.json
           - Reused on next run unless --force is passed
        │
        ▼
[Stage 3]  Asset Library Scan
           - Scans assets/ folder for .ifc mesh files
           - Registers each by filename (e.g. bed.ifc → key "bed")
        │
        ▼
[Stage 4]  BIM Compiler
           - Builds IFC hierarchy: Project → Site → Building → Storey
           - Creates Walls, Openings (Doors/Windows), Interior elements
           - Uses asset geometry if available, else procedural box
        │
        ▼
[Stage 5]  IFC4 File Written
           - output.ifc saved to --output path
```

---

## IFC Hierarchy Produced

```
IfcProject
  └── IfcSite
        └── IfcBuilding
              └── IfcBuildingStorey  ("Ground Floor")
                    ├── IfcWallStandardCase        (one per wall segment)
                    ├── IfcOpeningElement
                    │     └── IfcDoor / IfcWindow  (one per door/window)
                    ├── IfcFurniture               (sofas, beds, tables...)
                    ├── IfcSanitaryTerminal        (WC, basin, shower...)
                    └── IfcElectricAppliance       (fridge, AC, fan...)
```

---

## Owner / Metadata Embedded in IFC

| Field | Value |
|---|---|
| Person | Sushil Dev |
| Organization | Entrevista Media |
| Application | OonexBIM v1.0 |
| IFC Schema | IFC4 |
| Length Unit | METRE |
| Coordinate Precision | 1e-5 |

---

## CLI Usage

```bash
python automated_bim_v4_connected.py \
  --image  "3_BHK.jpg" \
  --output "output/my_building.ifc" \
  --assets "assets/" \
  --force \
  --debug \
  --allow-low-detail
```

| Argument | Default | Purpose |
|---|---|---|
| `--image` | `1 BHK HOUSE .jpg` | Input floor plan image |
| `--output` | `1_BHK_Detailed.ifc` | Output IFC file path |
| `--cache` | auto from image name | JSON cache file |
| `--assets` | `./assets/` | Path to IFC asset folder |
| `--force` | False | Re-run AI even if cache exists |
| `--debug` | False | Print property attachment logs |
| `--allow-low-detail` | False | Write IFC even if AI extraction is sparse |

---

## Output File Location

The IFC file is written to whatever path you pass in `--output`.  
Default is the **current working directory** where you run the script.

The JSON cache is saved alongside as `<image_stem>_Detailed_Cache.json`.

---

## Key Design Decisions

| Decision | Reason |
|---|---|
| Centerline walls | Corners meet perfectly without gaps |
| Asset-first geometry | Real IFC mesh looks better than procedural boxes |
| AABB collision avoidance | Furniture auto-nudges away from walls |
| ArchiCAD psets | File opens cleanly in ArchiCAD |
| Unit-agnostic input | AI can return m/mm/cm/ft — all normalized before writing |
| Cache-first | Avoids expensive Gemini API calls on re-runs |

---

## Related Documents

- `BIM_DATA_MODELS.md` — Pydantic schemas and AI extraction logic
- `BIM_COMPILER_DETAIL.md` — Wall, opening, interior construction + how to add floor/slab
