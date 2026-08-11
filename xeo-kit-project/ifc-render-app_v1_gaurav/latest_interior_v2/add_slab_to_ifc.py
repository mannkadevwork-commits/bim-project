"""
add_slab_to_ifc.py
------------------
Patches an existing IFC4 file by injecting IfcSlab elements.
Works generically — can be adapted to inject any IFC element into any file.

Usage:
    python add_slab_to_ifc.py --input assets/1_BHK_Detailed.ifc --output assets/1_BHK_With_Slab.ifc
    python add_slab_to_ifc.py --input assets/1_BHK_Detailed.ifc --output assets/1_BHK_With_Slab.ifc --thickness 0.15 --margin 0.25
"""

import argparse
import time
import ifcopenshell
import ifcopenshell.guid


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _get_storey(model):
    """Return the first IfcBuildingStorey found in the model."""
    storeys = model.by_type("IfcBuildingStorey")
    if not storeys:
        raise RuntimeError("No IfcBuildingStorey found in the IFC file.")
    return storeys[0]


def _get_context(model):
    """Return the 3D geometric representation context."""
    for ctx in model.by_type("IfcGeometricRepresentationContext"):
        if ctx.CoordinateSpaceDimension == 3:
            return ctx
    raise RuntimeError("No 3D IfcGeometricRepresentationContext found.")


def _get_owner_history(model):
    """Return the first IfcOwnerHistory or create a minimal one."""
    histories = model.by_type("IfcOwnerHistory")
    if histories:
        return histories[0]
    raise RuntimeError("No IfcOwnerHistory found in the IFC file.")


def _get_storey_placement(model, storey):
    """Return the IfcLocalPlacement of the storey."""
    return storey.ObjectPlacement


def _world_placement(model):
    """Return a shared world-origin IfcAxis2Placement3D."""
    origin = model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    return model.create_entity("IfcAxis2Placement3D", Location=origin)


def _derive_floor_boundary(model, margin: float = 0.25):
    """
    Derive a rectangular floor boundary from all IfcCartesianPoint coordinates
    that belong to wall geometry (SweptSolid representations).
    Falls back to all 3D points if no walls are found.
    """
    walls = model.by_type("IfcWallStandardCase") + model.by_type("IfcWall")
    xs, ys = [], []

    for wall in walls:
        placement = wall.ObjectPlacement
        if not placement:
            continue
        ax = placement.RelativePlacement
        if ax and ax.Location:
            loc = ax.Location.Coordinates
            xs.append(loc[0])
            ys.append(loc[1])

    # Also scan all 3D cartesian points for a tighter bounding box
    for pt in model.by_type("IfcCartesianPoint"):
        if len(pt.Coordinates) >= 2:
            xs.append(pt.Coordinates[0])
            ys.append(pt.Coordinates[1])

    if not xs:
        raise RuntimeError("Cannot derive floor boundary — no geometry found.")

    minx, maxx = min(xs) - margin, max(xs) + margin
    miny, maxy = min(ys) - margin, max(ys) + margin
    print(f"[Slab] Derived boundary: ({minx:.2f}, {miny:.2f}) → ({maxx:.2f}, {maxy:.2f})")
    return [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]]


def _add_surface_style(model, solid, r: float, g: float, b: float, style_name: str):
    """Attach an IfcSurfaceStyle colour to a geometry solid."""
    colour = model.create_entity("IfcColourRgb", Name=None, Red=r, Green=g, Blue=b)
    try:
        surface = model.create_entity(
            "IfcSurfaceStyleRendering",
            SurfaceColour=colour,
            Transparency=0.0,
            ReflectanceMethod="NOTDEFINED",
        )
    except Exception:
        surface = model.create_entity("IfcSurfaceStyleShading", SurfaceColour=colour, Transparency=0.0)

    style = model.create_entity("IfcSurfaceStyle", Name=style_name, Side="BOTH", Styles=[surface])
    try:
        model.create_entity("IfcStyledItem", Item=solid, Styles=[style], Name=style_name)
    except Exception:
        assignment = model.create_entity("IfcPresentationStyleAssignment", Styles=[style])
        model.create_entity("IfcStyledItem", Item=solid, Styles=[assignment], Name=style_name)


# ─────────────────────────────────────────────
# Core: inject one slab
# ─────────────────────────────────────────────

def inject_slab(
    model,
    slab_id: str = "slab_ground",
    slab_type: str = "FLOOR",
    thickness: float = 0.15,
    elevation: float = -0.15,
    outline_pts=None,
    material_name: str = "RCC",
    finish: str = "Smooth",
    margin: float = 0.25,
    color=(0.75, 0.75, 0.72),
):
    """
    Inject a single IfcSlab into an already-open ifcopenshell model.

    Parameters
    ----------
    model        : ifcopenshell.file  — the open IFC model
    slab_id      : name / id for the slab
    slab_type    : IFC predefined type string (FLOOR, ROOF, LANDING, BASESLAB)
    thickness    : slab thickness in metres
    elevation    : Z offset from storey level (negative = below floor finish)
    outline_pts  : list of [x, y] points; auto-derived from walls if None
    material_name: material label
    finish       : surface finish label
    margin       : extra margin around auto-derived bounding box (metres)
    color        : RGB tuple (0-1 range) for visual style
    """
    storey      = _get_storey(model)
    context     = _get_context(model)
    owner_h     = _get_owner_history(model)
    storey_pl   = _get_storey_placement(model, storey)
    world_pl    = _world_placement(model)

    # ── Placement ──────────────────────────────────────────────────────
    slab_origin = model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, elevation))
    slab_ax     = model.create_entity("IfcAxis2Placement3D", Location=slab_origin)
    slab_loc    = model.create_entity(
        "IfcLocalPlacement",
        PlacementRelTo=storey_pl,
        RelativePlacement=slab_ax,
    )

    # ── Outline ────────────────────────────────────────────────────────
    if not outline_pts:
        outline_pts = _derive_floor_boundary(model, margin=margin)

    ifc_pts = [
        model.create_entity("IfcCartesianPoint", Coordinates=(float(p[0]), float(p[1])))
        for p in outline_pts
    ]
    ifc_pts.append(ifc_pts[0])  # close the polygon

    profile = model.create_entity(
        "IfcArbitraryClosedProfileDef",
        ProfileType="AREA",
        OuterCurve=model.create_entity("IfcPolyline", Points=ifc_pts),
    )

    # ── Geometry ───────────────────────────────────────────────────────
    slab_solid = model.create_entity(
        "IfcExtrudedAreaSolid",
        SweptArea=profile,
        Position=world_pl,
        ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=thickness,
    )
    _add_surface_style(model, slab_solid, *color, style_name=f"{slab_id}_Style")

    slab_rep = model.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=context,
        RepresentationIdentifier="Body",
        RepresentationType="SweptSolid",
        Items=[slab_solid],
    )

    # ── IfcSlab entity ─────────────────────────────────────────────────
    ifc_slab = model.create_entity(
        "IfcSlab",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_h,
        Name=slab_id,
        ObjectPlacement=slab_loc,
        PredefinedType=slab_type,
    )
    ifc_slab.Representation = model.create_entity(
        "IfcProductDefinitionShape",
        Representations=[slab_rep],
    )

    # ── Properties ─────────────────────────────────────────────────────
    props = [
        model.create_entity("IfcPropertySingleValue", "Material",  None, model.create_entity("IfcLabel", material_name)),
        model.create_entity("IfcPropertySingleValue", "Thickness", None, model.create_entity("IfcLengthMeasure", thickness * 1000.0)),
        model.create_entity("IfcPropertySingleValue", "Finish",    None, model.create_entity("IfcLabel", finish)),
        model.create_entity("IfcPropertySingleValue", "IsExternal",None, model.create_entity("IfcBoolean", False)),
        model.create_entity("IfcPropertySingleValue", "LoadBearing",None,model.create_entity("IfcBoolean", True)),
    ]
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_h,
        Name="Pset_SlabCommon",
        HasProperties=props,
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_h,
        Name=None,
        Description=None,
        RelatedObjects=[ifc_slab],
        RelatingPropertyDefinition=pset,
    )

    # ── Material ───────────────────────────────────────────────────────
    mat = model.create_entity("IfcMaterial", Name=material_name)
    model.create_entity(
        "IfcRelAssociatesMaterial",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_h,
        RelatedObjects=[ifc_slab],
        RelatingMaterial=mat,
    )

    # ── Attach to storey via IfcRelContainedInSpatialStructure ─────────
    # Try to reuse the existing containment relationship for the storey
    existing_rel = None
    for rel in model.by_type("IfcRelContainedInSpatialStructure"):
        if rel.RelatingStructure == storey:
            existing_rel = rel
            break

    if existing_rel:
        existing_rel.RelatedElements = list(existing_rel.RelatedElements) + [ifc_slab]
        print(f"[Slab] Appended {slab_id} to existing IfcRelContainedInSpatialStructure.")
    else:
        model.create_entity(
            "IfcRelContainedInSpatialStructure",
            GlobalId=ifcopenshell.guid.new(),
            OwnerHistory=owner_h,
            RelatingStructure=storey,
            RelatedElements=[ifc_slab],
        )
        print(f"[Slab] Created new IfcRelContainedInSpatialStructure for {slab_id}.")

    print(f"[Slab] Injected '{slab_id}' — type={slab_type}, thickness={thickness*1000:.0f}mm, elevation={elevation}m, material={material_name}")
    return ifc_slab


# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Inject IfcSlab into an existing IFC file.")
    parser.add_argument("--input",     required=True,  help="Path to the source IFC file")
    parser.add_argument("--output",    required=True,  help="Path for the patched output IFC file")
    parser.add_argument("--thickness", type=float, default=0.15,  help="Slab thickness in metres (default 0.15)")
    parser.add_argument("--elevation", type=float, default=-0.15, help="Z offset from storey level (default -0.15)")
    parser.add_argument("--margin",    type=float, default=0.25,  help="Extra margin around auto-derived boundary (default 0.25)")
    parser.add_argument("--material",  default="RCC",    help="Slab material label (default RCC)")
    parser.add_argument("--finish",    default="Smooth", help="Surface finish label (default Smooth)")
    parser.add_argument("--slab-type", default="FLOOR",  help="IFC slab type: FLOOR, ROOF, LANDING, BASESLAB (default FLOOR)")
    parser.add_argument("--slab-id",   default="slab_ground", help="Name/ID for the slab (default slab_ground)")
    args = parser.parse_args()

    print(f"[Info] Opening: {args.input}")
    model = ifcopenshell.open(args.input)

    # Check if slabs already exist
    existing_slabs = model.by_type("IfcSlab")
    if existing_slabs:
        print(f"[Warn] File already contains {len(existing_slabs)} slab(s): {[s.Name for s in existing_slabs]}")
        print("[Warn] Adding another slab anyway. Use --slab-id to give it a unique name.")

    inject_slab(
        model,
        slab_id=args.slab_id,
        slab_type=args.slab_type,
        thickness=args.thickness,
        elevation=args.elevation,
        material_name=args.material,
        finish=args.finish,
        margin=args.margin,
    )

    model.write(args.output)
    print(f"[Success] Patched IFC saved to: {args.output}")


if __name__ == "__main__":
    main()
