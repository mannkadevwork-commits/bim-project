# BIM Compiler Detail & Floor/Slab Guide
**File:** `ifc-render-app/latest_interior_v2/automated_bim_v4_connected.py`

---

## Function: `build_detailed_ifc`

This is where the IFC file is physically constructed. It receives the `BuildingAnalysis` data and writes every entity into the IFC model.

---

## Step 1 — IFC Infrastructure Setup

Before any geometry is created, the following IFC entities are set up:

```
IfcPerson + IfcOrganization → IfcPersonAndOrganization
IfcApplication (OonexBIM v1.0)
IfcOwnerHistory
IfcSIUnit (METRE)
IfcUnitAssignment
IfcGeometricRepresentationContext (3D, precision 1e-5)
IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey ("Ground Floor")
```

All spatial elements are linked via `IfcRelAggregates`.  
All physical elements (walls, doors, furniture) are linked to the storey via `IfcRelContainedInSpatialStructure`.

---

## Step 2 — Wall Construction

For each `WallData` in the analysis:

### Geometry
1. Computes `length` and `angle` from start/end centerline points
2. Creates `IfcLocalPlacement` with `RefDirection` aligned to the wall angle
3. Tries `assets/wall.ifc` (or `blackwall.ifc`) — if found, scales it to `[length × thickness × height]`
4. Fallback: creates `IfcExtrudedAreaSolid` from a rectangular profile centered on the centerline

### Properties Attached

| Property Set | Key Properties |
|---|---|
| `Pset_WallCommon` | Material, Thickness (mm), Height, OverallHeight, Width, FireRating, IsExternal, LoadBearing |
| `BaseQuantities` | Length, Height, Width, GrossFootprintArea, NetFootprintArea, GrossVolume, NetVolume |
| `ArchiCADQuantities` | Höhe, Dicke, Wandlänge, Fläche, Netto-Volumen (ArchiCAD compatibility) |
| `ArchiCADPName` | Wall ID name |
| `ArchiCADProperties` | GuidValue (new GUID per wall) |

> Note: `Thickness` in `Pset_WallCommon` is stored in **mm** (multiplied × 1000) to match IFC convention. All other dimensions are in metres.

---

## Step 3 — Opening Construction (Doors & Windows)

For each `OpeningComponent`:

### Build Order
1. Create `IfcOpeningElement` at the opening location
2. Link to host wall via `IfcRelVoidsElement`
3. Create `IfcDoor` or `IfcWindow` entity with `OverallHeight` and `OverallWidth`
4. Set `PredefinedType` (DOOR / WINDOW)
5. Set `OperationType` (door) or `PartitioningType` (window)
6. Link door/window to opening via `IfcRelFillsElement`
7. Try `assets/door.ifc` or `assets/window.ifc` for geometry (frame depth defaults to 0.15 m)
8. Attach property set and material

### Door Operation Types

| AI value | IFC value |
|---|---|
| `SINGLE_SWING_LEFT` | `SINGLE_SWING_LEFT` |
| `SINGLE_SWING_RIGHT` | `SINGLE_SWING_RIGHT` |
| `DOUBLE_SWING` | `DOUBLE_DOOR_DOUBLE_SWING` |
| `SLIDING` | `SLIDING_TO_RIGHT` |
| `FOLDING` | `FOLDING_TO_RIGHT` |

### Window Partitioning Types

| AI value | IFC value |
|---|---|
| `SLIDING` | `DOUBLE_PANEL_HORIZONTAL` |
| `CASEMENT` / `FIXED` | `SINGLE_PANEL` |
| `DOUBLE_PANEL` | `DOUBLE_PANEL_VERTICAL` |

### Properties Attached

| Property Set | Key Properties |
|---|---|
| `Pset_DoorCommon` | OperationType, OverallWidth, OverallHeight, Material, Finish, FireRating, IsExternal |
| `Pset_WindowCommon` | OperationType, OverallWidth, OverallHeight, Material, GlazingType, CillHeight, UValue |

---

## Step 4 — Interior Element Construction

For each `InteriorComponent`:

### IFC Class Resolution

| AI category | IFC Class |
|---|---|
| `furnishing` | `IfcFurniture` |
| `sanitary` | `IfcSanitaryTerminal` |
| `appliance` | `IfcElectricAppliance` |

### Build Order
1. Resolve IFC class and predefined type via `resolve_component_spec()`
2. Convert AI rotation (degrees) to radians → set `RefDirection` on placement
3. Run **AABB collision check** against all wall polygons
   - If element overlaps a wall, shrink footprint by 10% per iteration
   - Max 20 iterations, minimum half-size of 0.05 m
4. Try matching asset IFC by type name (e.g. `BED` → `bed.ifc`)
5. Fallback: procedural extruded box with `IfcSurfaceStyleRendering` color
6. Attach all relevant property sets
7. Assign `IfcMaterial`

### Property Sets by Type

| Element | Property Sets Attached |
|---|---|
| Sofa | `Pset_FurnitureTypeCommon`, `Pset_SofaTypeCommon` |
| Bed | `Pset_FurnitureTypeCommon`, `Pset_BedTypeCommon` |
| Chair | `Pset_FurnitureTypeCommon`, `Pset_ChairTypeCommon` |
| Table / Desk | `Pset_FurnitureTypeCommon`, `Pset_TableTypeCommon` |
| Wardrobe / Shelf | `Pset_FurnitureTypeCommon`, `Pset_CabinetTypeCommon`, `Pset_WardrobeTypeCommon` |
| TV Unit | `Pset_FurnitureTypeCommon`, `Pset_TVUnitTypeCommon` |
| WC / Basin / Shower | `Pset_SanitaryTerminalTypeCommon` |
| Refrigerator | `Pset_ElectricApplianceTypeCommon`, `Pset_RefrigeratorTypeCommon` |
| Washing Machine | `Pset_ElectricApplianceTypeCommon`, `Pset_WashingMachineTypeCommon` |
| Split AC | `Pset_ElectricApplianceTypeCommon`, `Pset_AirConditionerTypeCommon` |
| Ceiling Fan | `Pset_ElectricApplianceTypeCommon`, `Pset_CeilingFanTypeCommon` |
| Television | `Pset_ElectricApplianceTypeCommon`, `Pset_TelevisionTypeCommon` |
| Gas Stove | `Pset_ElectricApplianceTypeCommon`, `Pset_GasStoveTypeCommon` |
| Microwave / OTG | `Pset_ElectricApplianceTypeCommon`, `Pset_MicrowaveTypeCommon` |
| Water Heater | `Pset_ElectricApplianceTypeCommon`, `Pset_WaterHeaterTypeCommon` |
| Water Purifier | `Pset_ElectricApplianceTypeCommon`, `Pset_WaterPurifierTypeCommon` |

### Default Materials (when AI does not provide one)

| Category / Type | Default Material |
|---|---|
| Sanitary (general) | Ceramic |
| Sanitary (sink) | Stainless Steel |
| Appliance | Stainless Steel |
| Sofa / Chair | Fabric |
| Bed | Teak Wood |
| Table / Desk | Sheesham Wood |
| Shelf / Cabinet | MDF |

---

## How to Add Floor / Base (Slab) Configuration

Currently the script has `IfcSlab` defined in `ifc_properties.py` but **no slab is created** in the compiler. Follow these 4 steps to add it.

---

### Step 1 — Add `SlabData` model

In `automated_bim_v4_connected.py`, add this class near the other data models:

```python
class SlabData(BaseModel):
    slab_id: str = "slab_ground"
    slab_type: str = "FLOOR"          # FLOOR, ROOF, LANDING, BASESLAB
    thickness: float = 0.15           # metres
    elevation: float = 0.0            # Z offset (0 = ground floor)
    outline_pts: List[List[float]] = Field(default_factory=list)
    material: str = "RCC"
    unit: str = "m"
```

---

### Step 2 — Add `slabs` to `BuildingAnalysis`

```python
class BuildingAnalysis(BaseModel):
    building_name: str = "1 BHK Detailed Plan"
    walls: List[WallData]
    openings: List[OpeningComponent] = Field(default_factory=list)
    interiors: List[InteriorComponent] = Field(default_factory=list)
    slabs: List[SlabData] = Field(default_factory=list)   # ← ADD THIS
```

---

### Step 3 — Add slab builder inside `build_detailed_ifc`

Place this block **after the walls loop and before the openings loop**:

```python
# --- SLABS (Floor / Base) ---
for slab in getattr(data, "slabs", []):
    slab_unit = getattr(slab, "unit", "m") or "m"
    slab_thickness = _convert_to_meters(slab.thickness, slab_unit)
    slab_elevation = _convert_to_meters(slab.elevation, slab_unit)

    slab_origin = model.create_entity("IfcCartesianPoint", Coordinates=(0., 0., slab_elevation))
    slab_ax = model.create_entity("IfcAxis2Placement3D", Location=slab_origin)
    slab_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=slab_ax)

    # Use outline_pts if provided, else auto-derive bounding box from walls
    if slab.outline_pts:
        pts_2d = [_normalize_point(p, slab_unit) for p in slab.outline_pts]
    else:
        all_x = [pt for w in data.walls for pt in [w.start_pt[0], w.end_pt[0]]]
        all_y = [pt for w in data.walls for pt in [w.start_pt[1], w.end_pt[1]]]
        margin = 0.25
        minx, maxx = min(all_x) - margin, max(all_x) + margin
        miny, maxy = min(all_y) - margin, max(all_y) + margin
        pts_2d = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]]

    ifc_pts = [model.create_entity("IfcCartesianPoint", Coordinates=(p[0], p[1])) for p in pts_2d]
    ifc_pts.append(ifc_pts[0])  # close the polygon loop
    profile = model.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA",
                                   OuterCurve=model.create_entity("IfcPolyline", Points=ifc_pts))
    solid = model.create_entity("IfcExtrudedAreaSolid", SweptArea=profile, Position=world_pl,
                                 ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0., 0., 1.)),
                                 Depth=slab_thickness)
    rep = model.create_entity("IfcShapeRepresentation", ContextOfItems=context,
                               RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[solid])

    ifc_slab = model.create_entity("IfcSlab", GlobalId=ifcopenshell.guid.new(),
                                    Name=slab.slab_id, ObjectPlacement=slab_loc,
                                    PredefinedType=slab.slab_type)
    ifc_slab.Representation = model.create_entity("IfcProductDefinitionShape", Representations=[rep])

    slab_overrides = {
        "Pset_SlabCommon": {
            "Material": slab.material,
            "Thickness": slab_thickness * 1000   # stored in mm per IFC convention
        }
    }
    assign_default_ifc_properties(model, owner_h, ifc_slab, "Slab", props_module,
                                   custom_overrides=slab_overrides, debug=debug)
    assign_material(model, owner_h, ifc_slab, slab.material)
    elements.append(ifc_slab)
```

---

### Step 4 — Tell Gemini to extract slabs (optional)

Add this line to `_build_extraction_prompt()` if you want the AI to detect the floor boundary:

```python
"5. If the plan shows a clear outer boundary, extract it as a slab outline polygon "
"under 'slabs' with slab_type=FLOOR, thickness=0.15, elevation=0.0.\n"
```

If you skip this step, the slab builder in Step 3 will **auto-generate a bounding box** from the wall extents with a 0.25 m margin — so a floor slab will still be created even without AI extraction.

---

### Slab Properties (already in `ifc_properties.py`)

No changes needed to `ifc_properties.py`. The `Slab` entry already covers:

| Property | Default |
|---|---|
| Material | RCC |
| Thickness | 150 mm |
| FireRating | None |
| Finish | Smooth |

---

## Related Documents

- `BIM_ENGINE_OVERVIEW.md` — Pipeline, IFC hierarchy, CLI, design decisions
- `BIM_DATA_MODELS.md` — Pydantic schemas, AI extraction logic, asset library
