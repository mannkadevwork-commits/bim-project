# BIM Data Models & AI Extraction
**File:** `ifc-render-app/latest_interior_v2/automated_bim_v4_connected.py`

---

## 1. Pydantic Data Models

These are the structured schemas that Gemini AI fills in when it analyzes the floor plan image. They also serve as the JSON cache format.

### BuildingAnalysis (Root)

```
BuildingAnalysis
  ├── building_name   (str)
  ├── walls           (List[WallData])
  ├── openings        (List[OpeningComponent])
  └── interiors       (List[InteriorComponent])
```

---

### WallData

Represents one straight wall segment using **centerline** coordinates.

| Field | Type | Default | Notes |
|---|---|---|---|
| `wall_id` | str | — | Unique ID e.g. `W1` |
| `start_pt` | [x, y] | — | Centerline start |
| `end_pt` | [x, y] | — | Centerline end |
| `thickness` | float | 0.23 | In `unit` |
| `height` | float | 3.0 | In `unit` |
| `unit` | str | `"m"` | m / mm / cm / ft |

---

### OpeningComponent

Represents a door, window, or arch opening.

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | str | — | Unique ID e.g. `D1` |
| `type` | str | — | `door` or `window` |
| `location_pt` | [x, y] | — | Center of opening |
| `width` | float | 0.90 | In `unit` |
| `height` | float | 2.10 | In `unit` |
| `parent_wall_id` | str | — | Host wall ID |
| `operation_type` | str | None | e.g. `SINGLE_SWING_RIGHT`, `SLIDING` |
| `material` | str | None | e.g. `Teak Wood`, `Aluminium` |
| `color` | [r, g, b] | None | Values 0–1 |
| `properties` | List[ElementProperty] | [] | Extra IFC property rows |

---

### InteriorComponent

Represents furniture, sanitary fixtures, or appliances.

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | str | — | Unique ID e.g. `F1` |
| `category` | str | — | `furnishing`, `sanitary`, or `appliance` |
| `type` | str | None | e.g. `BED`, `SOFA`, `WC`, `REFRIGERATOR` |
| `location_pt` | [x, y] | — | Center position |
| `dimensions` | [w, d, h] | [0.8, 0.8, 0.5] | In `unit` |
| `rotation` | float | 0.0 | Degrees 0–360 |
| `material` | str | None | e.g. `Teak Wood`, `Ceramic` |
| `color` | [r, g, b] | None | Values 0–1 |
| `properties` | List[ElementProperty] | [] | Extra IFC property rows |

---

### ElementProperty

A single IFC property row attached to any element.

| Field | Notes |
|---|---|
| `name` | Property name e.g. `BedSize`, `Tonnage` |
| `value` | Value as text e.g. `"Queen (150x190)"`, `"1.5 Ton"` |
| `pset` | Optional pset name e.g. `Pset_BedTypeCommon` |

---

## 2. Unit Conversion

All values from AI are normalized to meters before writing to IFC.

| Input Unit | Conversion |
|---|---|
| `m` | × 1.0 |
| `mm` | ÷ 1000 |
| `cm` | ÷ 100 |
| `ft` | × 0.3048 |
| `in` | × 0.0254 |

Area units (`m2`, `ft2`, `sqft`, etc.) are also handled for property values.

---

## 3. AI Extraction Logic

### Function: `analyze_floor_plan_detailed(image_path)`

1. Reads image as bytes, detects MIME type from extension
2. Sends to `gemini-3-flash-preview` with a detailed structured prompt
3. Requests JSON response conforming to `BuildingAnalysis` schema
4. Checks completeness — if too sparse, **auto-retries** with a stricter prompt
5. Returns the best result between first attempt and retry

### Completeness Check

The script infers the BHK count from the image filename (e.g. `3_BHK.jpg` → 3 bedrooms) and sets minimum expected counts:

| BHK | Min Walls | Min Openings | Min Interiors |
|---|---|---|---|
| 1 BHK | 10 | 4 | 4 |
| 2 BHK | 14 | 8 | 8 |
| 3 BHK | 18 | 12 | 12 |

If the extraction is still below these counts after retry and `--allow-low-detail` is not set, the script **exits with an error** rather than writing an incomplete IFC.

---

### What the Prompt Instructs Gemini to Extract

**Walls:**
- All straight segments using centerline coordinates
- Split at every corner, T-junction, door/window gap, balcony break
- Exterior walls, interior partitions, toilet/kitchen/utility walls

**Openings:**
- All doors: entrance, bedroom, toilet, kitchen, balcony, sliding, folding
- All windows: sliding, casement, fixed, ventilators
- Operation types, materials, colors

**Interiors — Furniture types:**
`SOFA`, `BED`, `CHAIR`, `TABLE`, `DESK`, `SHELF`, `FILECABINET`, `TV_UNIT`, `WARDROBE`

**Interiors — Appliance types:**
`REFRIGERATOR`, `FRIDGE_FREEZER`, `WASHINGMACHINE`, `MICROWAVE`, `GAS_STOVE`, `SPLIT_AC`, `CEILING_FAN`, `WATER_HEATER`, `TELEVISION`, and more

**Interiors — Sanitary types:**
`WC`, `WASHBASIN`, `SINK`, `SHOWER`, `BATH`, `URINAL`

**Indian market dimensions used as reference:**

| Item | Dimensions (W×D×H) |
|---|---|
| 3-seater sofa | 2.1 × 0.9 × 0.85 m |
| Queen bed | 1.6 × 2.0 × 0.5 m |
| Wardrobe | 1.8 × 0.6 × 2.1 m |
| Dining table 6-seater | 1.8 × 0.9 × 0.76 m |
| Refrigerator | 0.65 × 0.7 × 1.7 m |
| Washing machine | 0.6 × 0.6 × 0.85 m |
| Split AC indoor | 1.0 × 0.2 × 0.3 m |
| Gas stove | 0.6 × 0.35 × 0.15 m |
| TV unit | 1.8 × 0.4 × 0.55 m |

---

## 4. IFC Asset Library

### Folder: `assets/`

Located in the same directory as the script, or passed via `--assets`.

### How It Works

1. `_scan_asset_dir()` runs once on startup — scans all `.ifc` files
2. Each file is registered by its filename stem (lowercase, normalized)
3. `_resolve_asset(type_name)` looks up the key with synonym fallback
4. `_build_asset_representation()` copies geometry into the output IFC and scales it to match AI-extracted dimensions

### Synonym Fallbacks

| AI type | Resolves to asset |
|---|---|
| `toilet`, `commode` | `wc` |
| `fridge` | `refrigerator` |
| `washbasin` | `wash_basin` |
| `dining_chair`, `armchair` | `chair` |
| `couch`, `settee` | `sofa` |

### Current Assets

| File | Used for |
|---|---|
| `sofa.ifc`, `sofa_modern.ifc` | Sofas |
| `bed.ifc` | Beds |
| `chair.ifc` | Chairs |
| `cabinet.ifc`, `cabinet_4.ifc` | Cabinets / wardrobes |
| `open_bookshelf.ifc` | Bookshelves |
| `Armoire.ifc` | Wardrobes |
| `commode.ifc` | WC / toilet |
| `sink_mirror.ifc` | Wash basin |
| `blackwall.ifc` | Wall (if present, replaces procedural geometry) |

If no matching asset is found → falls back to a **procedural extruded box** with color applied.

### Scaling Logic

When an asset is used, it is scaled to match the AI-extracted dimensions:

```
scale_x = target_width  / asset_bbox_width
scale_y = target_depth  / asset_bbox_depth
scale_z = target_height / asset_bbox_height
```

All `IfcCartesianPoint` coordinates in the copied geometry are multiplied by these scale factors.

---

## Related Documents

- `BIM_ENGINE_OVERVIEW.md` — Pipeline, IFC hierarchy, CLI, design decisions
- `BIM_COMPILER_DETAIL.md` — Wall, opening, interior construction + how to add floor/slab
