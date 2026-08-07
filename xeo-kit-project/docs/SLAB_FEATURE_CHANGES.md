# Slab Feature — Change Log & ifc_properties.py Usage Guide

---

## What Was Added

Floor/Base slab support was added to the BIM engine. Every generated IFC now includes at least one `IfcSlab` representing the ground floor. If the AI extracts a floor boundary from the image, that polygon is used. If not, the slab is auto-generated from the bounding box of all wall endpoints.

---

## Files Changed

### 1. `ifc-render-app/latest_interior_v2/automated_bim_v4_connected.py`

Three separate locations were changed in this single file.

---

#### Change A — New `SlabData` Pydantic model (Section 1: Data Models)

Added immediately after the `WallData` class.

```python
class SlabData(BaseModel):
    slab_id: str = "slab_ground"
    slab_type: str = Field(default="FLOOR", description="IFC slab type: FLOOR, ROOF, LANDING, or BASESLAB")
    thickness: float = Field(default=0.15, description="Slab thickness in unit")
    elevation: float = Field(default=0.0, description="Z offset from storey level (0 = ground floor)")
    outline_pts: List[List[float]] = Field(default_factory=list, description="2D polygon boundary [[x,y], ...]. Auto-derived from walls if empty.")
    material: str = Field(default="RCC", description="Slab material e.g. RCC, Precast, Composite")
    finish: str = Field(default="Smooth", description="Top surface finish e.g. Smooth, Rough, Polished")
    unit: str = "m"
```

Why: This is the structured schema that holds all slab configuration. Pydantic validates and normalizes the data whether it comes from the AI JSON response or from the auto-generation fallback.

---

#### Change B — `slabs` field added to `BuildingAnalysis` (Section 1: Data Models)

The root model now carries a `slabs` list alongside `walls`, `openings`, and `interiors`.

```python
class BuildingAnalysis(BaseModel):
    building_name: str = "1 BHK Detailed Plan"
    walls: List[WallData]
    openings: List[OpeningComponent] = Field(default_factory=list)
    interiors: List[InteriorComponent] = Field(default_factory=list)
    slabs: List[SlabData] = Field(
        default_factory=list,
        description="Floor/roof slabs. If empty, a ground floor slab is auto-generated from wall extents."
    )
```

Why: `BuildingAnalysis` is both the Gemini response schema and the JSON cache format. Adding `slabs` here means Gemini can optionally return slab data, and the cache will also store/restore it correctly.

---

#### Change C — Slab extraction instruction added to AI prompt (function `_build_extraction_prompt`)

Added as item 5 at the end of the prompt string, just before the final `return`.

```
5. If the plan shows a clear outer boundary or floor plate, extract it as a slab entry under 'slabs'.
   - Set slab_type=FLOOR, thickness=0.15, elevation=0.0, material=RCC, finish=Smooth.
   - outline_pts should be a list of [x, y] polygon points tracing the outer floor boundary.
   - If the boundary is not clearly visible, leave 'slabs' as an empty list; a slab will be auto-generated.
```

Why: Without this instruction Gemini would never populate the `slabs` field. The instruction is intentionally lenient — if the boundary is unclear, Gemini leaves it empty and the compiler auto-generates one.

---

#### Change D — Slab builder block added to `build_detailed_ifc` (Section 4: BIM Compiler)

Inserted as section `1b`, between the walls loop and the openings loop.

Full logic flow:

```
slabs = data.slabs  (from AI or cache)
│
├── if empty → auto-create one SlabData() with defaults
│
└── for each slab:
      ├── convert thickness + elevation to metres
      ├── create IfcLocalPlacement at (0, 0, elevation)
      ├── build 2D outline polygon
      │     ├── if outline_pts provided → use them
      │     └── else → derive bounding box from all wall start/end points + 0.25m margin
      ├── create IfcArbitraryClosedProfileDef + IfcPolyline
      ├── create IfcExtrudedAreaSolid (depth = thickness)
      ├── assign surface color via assign_surface_style()
      ├── create IfcShapeRepresentation (Body / SweptSolid)
      ├── create IfcSlab with PredefinedType = slab_type
      ├── attach Pset_SlabCommon (Material, Thickness in mm, Finish)
      ├── assign IfcMaterial
      ├── attach ArchiCADPName pset
      └── append to elements list → included in IfcRelContainedInSpatialStructure
```

Console output produced:
```
[Slab] No slabs in extraction — auto-generating ground floor slab from wall extents.
[Slab] Created slab_ground (FLOOR) thickness=150mm material=RCC
```

---

### 2. No changes to `ifc_properties.py`

The `Slab` schema was already present in `IFC_SCHEMA` before this feature was added:

```python
"Slab": {
    "ifc_class": "IfcSlab",
    "psets": {
        "Pset_SlabCommon": {
            "Material":   {"type": "text",   "default": "RCC"},
            "Thickness":  {"type": "number", "unit": "mm", "default": 150},
            "FireRating": {"type": "text",   "default": "None"},
            "Finish":     {"type": "text",   "default": "Smooth"},
        }
    }
}
```

The compiler calls `assign_default_ifc_properties(..., "Slab", props_module, ...)` which looks up this schema and applies all defaults, then merges the custom overrides (actual thickness, material, finish from the slab data).

---

## Where and When `ifc_properties.py` Is Used

This file is a **pure data/configuration module** — it has no side effects and is never imported at the top of the script. It is loaded dynamically at runtime.

### How it is loaded

At the bottom of `automated_bim_v4_connected.py`, in the `__main__` block:

```python
prop_paths = find_ifc_properties_files()       # walks directory tree looking for ifc_properties.py
ifc_props = load_ifc_properties_module(prop_paths[0])   # loads it as a Python module object
build_detailed_ifc(data, args.output, props_module=ifc_props, ...)
```

`find_ifc_properties_files()` walks from the script's own directory downward, so it will find `ifc_properties.py` in the same folder automatically.

---

### Every place `props_module` (ifc_properties.py) is used inside the compiler

| Call site | What it reads from ifc_properties.py | Purpose |
|---|---|---|
| `assign_default_ifc_properties(..., "IfcWall", props_module)` | `IFC_SCHEMA["Wall"]["psets"]` | Attaches `Pset_WallCommon` defaults to every wall |
| `assign_default_ifc_properties(..., "Door", props_module)` | `IFC_SCHEMA["Door"]["psets"]` | Attaches `Pset_DoorCommon` defaults to every door |
| `assign_default_ifc_properties(..., "Window", props_module)` | `IFC_SCHEMA["Window"]["psets"]` | Attaches `Pset_WindowCommon` defaults to every window |
| `assign_default_ifc_properties(..., "Slab", props_module)` | `IFC_SCHEMA["Slab"]["psets"]` | Attaches `Pset_SlabCommon` defaults to every slab ← NEW |
| `assign_default_ifc_properties(..., "Furniture", props_module)` | `IFC_SCHEMA["Furniture"]["psets"]` | Attaches furniture psets (bed, sofa, chair, etc.) |
| `assign_default_ifc_properties(..., "FlowTerminal", props_module)` | `IFC_SCHEMA["FlowTerminal"]["psets"]` | Attaches sanitary terminal psets |
| `assign_default_ifc_properties(..., "ElectricAppliance", props_module)` | `IFC_SCHEMA["ElectricAppliance"]["psets"]` | Attaches appliance psets |
| `resolve_component_spec(item, props_module)` | `COMPONENT_TYPE_MAP` | Maps AI category/type strings to IFC classes and pset names |
| `resolve_opening_spec(op, opening_type, props_module)` | `OPENING_TYPE_MAP` | Maps AI operation strings to IFC door/window operation enums |
| `_material_color(material_name, props_module)` | `MATERIALS` | Looks up RGB color for a material name (e.g. "Teak Wood" → [0.55, 0.27, 0.07]) |
| `_get_component_config(category, props_module)` | `COMPONENT_TYPE_MAP` | Gets IFC class config for furnishing/sanitary/appliance |

---

### What `ifc_properties.py` contains (summary)

| Section | What it is | Used for |
|---|---|---|
| `IFC_SCHEMA` | Dict of entity schemas with psets and default values | Default property values for every IFC element type |
| `ENTITY_SCHEMA_ALIASES` | Maps IFC class names to schema keys | Lets the compiler look up `IfcFurniture` → `Furniture` in the schema |
| `COMPONENT_TYPE_MAP` | Maps AI category strings to IFC classes + type enums | Resolves `furnishing/BED` → `IfcFurniture / BED` |
| `OPENING_TYPE_MAP` | Maps AI operation strings to IFC door/window enums | Resolves `SLIDING` → `SLIDING_TO_RIGHT` for doors |
| `MATERIALS` | Dict of material names to RGB colors | Provides visual colors when AI does not supply one |
| `GLOBAL_PSETS` | Psets applied to all entities | Adds `CreationDate`, `LastModifiedDate` to everything |
| `get_default_pset()` | Helper function | Returns all default property values for a given class |
| `get_standard_property_names()` | Helper function | Returns property names grouped by pset |
| `get_entity_attributes()` | Helper function | Introspects live IFC4 schema for entity attributes |

---

## Summary of All Changes

| File | Location | What Changed |
|---|---|---|
| `automated_bim_v4_connected.py` | After `WallData` class | Added `SlabData` Pydantic model |
| `automated_bim_v4_connected.py` | `BuildingAnalysis` class | Added `slabs: List[SlabData]` field |
| `automated_bim_v4_connected.py` | `_build_extraction_prompt()` | Added item 5 instructing Gemini to extract slab boundary |
| `automated_bim_v4_connected.py` | `build_detailed_ifc()` between walls and openings | Added full slab builder block (section 1b) |
| `ifc_properties.py` | No changes | `Slab` schema was already present |
