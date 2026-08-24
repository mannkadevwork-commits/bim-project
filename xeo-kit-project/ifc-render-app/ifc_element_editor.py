#!/usr/bin/env python3
"""
ifc_element_editor.py

Server-side IFC element editor, invoked by server.js via child_process.spawn.
Requires: pip install ifcopenshell

Four operations:

  inspect  --input <ifc> --global-id <id>
      Reads back the element's current extrusion dimensions (height/width/
      length) so the frontend can populate slider defaults accurately.

  resize   --input <ifc> --global-id <id> --output <ifc>
            [--height H] [--width W] [--length L]
      Edits the element's IfcExtrudedAreaSolid depth (height) and, if its
      swept profile is an IfcRectangleProfileDef, its XDim/YDim (width /
      length). Writes a full copy of the IFC with just that one element
      changed.

  isolate  --input <ifc> --global-id <id> --output <ifc>
      Produces a minimal standalone IFC containing ONLY the target element
      plus the spatial structure it needs to remain valid (project, site,
      building, storey, units, geometric context). This lets the frontend
      load just that one wall as its own xeokit model — same mechanism
      already used for furniture assets — so it can be given a model-level
      transform independently of the rest of the building.

  rescale  --input <ifc> --output <ifc> --factor <f> [--axis uniform|y]
      Global, backend-authoritative geometric rescale of the ENTIRE IFC
      file. This is the "proper" Coohom-style calibration: rather than
      only scaling the WebGL mesh client-side (which desyncs the
      frontend's visual scale from this file's actual dimensions, so any
      later inspect/resize call on an individual element reads the WRONG
      size), we rewrite the real IFC geometry once, so the file on disk
      and the 3D view always agree.
        - --axis uniform : scales X, Y, and Z together. Fixes a wrong
                            import unit (e.g. a file authored in
                            millimeters loaded as if it were meters).
        - --axis y       : scales ONLY the vertical (height) axis, for
                            "set ceiling height for the whole floor plan".
                            X/Y floor-plan layout is untouched.

LIMITATIONS (v1, flagged honestly rather than failing silently):
  - Only IfcExtrudedAreaSolid representations are supported for resize.
    Swept solids, B-reps, or curved walls will return a clear error.
  - Only IfcRectangleProfileDef is handled for width/length edits.
    Arbitrary/poly-line profiles are not supported yet.
  - rescale assumes walls/columns/floors are extruded along the model's
    global Z axis, which is standard for IFC authored by Revit / ArchiCAD
    / BlenderBIM and matches this app's 3_BHK.ifc. A wall extruded along
    a tilted local axis will scale its height incorrectly under --axis y.
  - rescale updates the uniform Scale factor on IfcMappedItem instances
    (shared/instanced geometry); the non-uniform transform operator
    variant is not handled — flagged, not silently mis-scaled.
  - rescale does not touch curved/B-rep geometry (IfcBSplineSurface etc).
"""

import sys
import argparse
import json
import logging
from pathlib import Path

# Configure logger to output to stderr. 
# CRITICAL: This ensures logs don't corrupt the JSON output on stdout that Node.js expects.
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

import math

try:
    import ifcopenshell
    import ifcopenshell.util.element
    from ifcopenshell.util.placement import get_local_placement, get_axis2placement
    import ifcopenshell.api
    import ifcopenshell.api.root
    import ifcopenshell.api.geometry
    import ifcopenshell.api.feature
except ImportError:
    print(json.dumps({
        "error": "ifcopenshell is not installed on this server. Run: pip install ifcopenshell"
    }))
    sys.exit(1)

try:
    import numpy as np
except ImportError:
    print(json.dumps({
        "error": "numpy is not installed on this server. Run: pip install numpy"
    }))
    sys.exit(1)


def find_element(ifc_file, global_id):
    element = ifc_file.by_guid(global_id)
    if element is None:
        raise ValueError(f"No element found with GlobalId '{global_id}'")
    return element


def get_extruded_solid(element):
    """Walks the element's Representation to find an IfcExtrudedAreaSolid.
    Returns (representation_item, body_representation) or (None, None)."""
    if not getattr(element, "Representation", None):
        return None, None

    for rep in element.Representation.Representations:
        if rep.RepresentationIdentifier not in ("Body", "Box"):
            continue
        for item in rep.Items:
            if item.is_a("IfcExtrudedAreaSolid"):
                return item, rep
    return None, None


def _pset_number(psets, names):
    lowered = {str(name).lower(): value for group in psets.values() if isinstance(group, dict) for name, value in group.items()}
    for name in names:
        value = lowered.get(name.lower())
        if isinstance(value, (int, float)) and math.isfinite(value):
            return float(value)
        if isinstance(value, str):
            try:
                parsed = float(value)
                if math.isfinite(parsed):
                    return parsed
            except ValueError:
                pass
    return 0.0


def cmd_inspect(args):
    source = ifcopenshell.open(args.input)
    element = find_element(source, args.global_id)

    # Prefer exact parametric dimensions where the representation supports them.
    reps = getattr(element, "Representation", None)
    reps = getattr(reps, "Representations", []) if reps else []
    for rep in reps:
        if rep.RepresentationIdentifier not in ("Body", "SweptSolid", "Box"):
            continue
        for item in rep.Items:
            if item.is_a("IfcExtrudedAreaSolid"):
                height = float(item.Depth or 0)
                width = 0.0
                length = 0.0
                profile = item.SweptArea
                if profile.is_a("IfcRectangleProfileDef"):
                    width = float(profile.XDim or 0)
                    length = float(profile.YDim or 0)
                elif profile.is_a("IfcArbitraryClosedProfileDef") and profile.OuterCurve.is_a("IfcPolyline"):
                    pts = [p.Coordinates for p in profile.OuterCurve.Points]
                    xs = [float(p[0]) for p in pts]
                    ys = [float(p[1]) for p in pts]
                    width = max(xs) - min(xs) if xs else 0.0
                    length = max(ys) - min(ys) if ys else 0.0
                print(json.dumps({"height": height, "width": width, "length": length, "supported": True}))
                return

    # Many IFC walls are not represented as IfcExtrudedAreaSolid. For those,
    # fall back to common wall property sets so selecting the element never
    # becomes an HTTP error. This is inspection-only; resize remains disabled
    # unless a parametric extrusion is available.
    try:
        psets = ifcopenshell.util.element.get_psets(element)
    except Exception:
        psets = {}

    height = _pset_number(psets, ["OverallHeight", "Height", "NetHeight"])
    width = _pset_number(psets, ["Width", "Thickness", "OverallWidth"])
    length = _pset_number(psets, ["Length", "OverallLength"])

    print(json.dumps({
        "height": height or None,
        "width": width or None,
        "length": length or None,
        "supported": False,
        "source": "property-set-fallback"
    }))


def cmd_resize(args):
    source = ifcopenshell.open(args.input)
    element = find_element(source, args.global_id)

    logger.info(f"Initiating resize for element GlobalId: {args.global_id}")

    rep = next((r for r in element.Representation.Representations if r.RepresentationIdentifier in ["Body", "SweptSolid"]), None)
    solid = rep.Items[0]

    # 1. Update Height (Depth of extrusion)
    if args.height is not None:
        old_height = solid.Depth
        solid.Depth = args.height
        logger.info(f"Element {args.global_id} - Height (Depth) modified: {old_height} -> {args.height}")

    profile = solid.SweptArea
    
    # 2a. Resize if Rectangle
    if profile.is_a("IfcRectangleProfileDef"):
        if args.width is not None: 
            old_width = profile.XDim
            profile.XDim = args.width
            logger.info(f"Element {args.global_id} - Width (XDim) modified: {old_width} -> {args.width}")
            
        if args.length is not None: 
            old_length = profile.YDim
            profile.YDim = args.length
            logger.info(f"Element {args.global_id} - Length (YDim) modified: {old_length} -> {args.length}")
        
    # 2b. Resize if Polygon
    elif profile.is_a("IfcArbitraryClosedProfileDef"):
        curve = profile.OuterCurve
        if curve.is_a("IfcPolyline"):
            # Calculate current dimensions
            pts = [p.Coordinates for p in curve.Points]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            current_w = max(xs) - min(xs)
            current_l = max(ys) - min(ys)

            # Calculate scale ratios
            scale_x = (args.width / current_w) if (args.width and current_w > 0) else 1.0
            scale_y = (args.length / current_l) if (args.length and current_l > 0) else 1.0
            
            if scale_x != 1.0 or scale_y != 1.0:
                logger.info(f"Element {args.global_id} - Scaling Polygon Profile: scale_x={scale_x:.4f}, scale_y={scale_y:.4f}")

            # Multiply every point in the polygon by the new scale
            for pt in curve.Points:
                coords = list(pt.Coordinates)
                coords[0] *= scale_x
                coords[1] *= scale_y
                pt.Coordinates = tuple(coords)

    # 3. Save the isolated, resized element
    logger.info(f"Writing resized output to: {args.output}")
    target = ifcopenshell.file(schema=source.schema)
    for project in source.by_type("IfcProject"):
        target.add(project)
    target.add(element)
    target.write(args.output)

    print(json.dumps({
        "success": True,
        "globalId": args.global_id,
        "outputPath": args.output,
    }))

def cmd_isolate(args):
    """Builds a minimal standalone IFC containing ONLY the target element
    and the foundational IfcProject context required for web-ifc to parse it."""
    source = ifcopenshell.open(args.input)
    element = find_element(source, args.global_id)
    
    target = ifcopenshell.file(schema=source.schema)

    # 1. Bring over the Project root and its basic contexts (Units, Geometries)
    # target.add() only follows forward references, so this safely copies the project 
    # WITHOUT pulling in the Site, Building, or other architectural elements.
    for project in source.by_type("IfcProject"):
        target.add(project)

    # 2. Bring over the actual element and its geometry
    target.add(element)

    target.write(args.output)
    
    print(json.dumps({
        "success": True,
        "globalId": args.global_id,
        "outputPath": args.output,
    }))


def cmd_rescale(args):
    """Global, backend-authoritative geometric rescale of the ENTIRE IFC
    file. This is the 'proper' Coohom-style calibration: instead of only
    scaling the WebGL mesh client-side (which desyncs the frontend's
    visual scale from this file's actual dimensions — so any later
    inspect/resize call on an individual element reads the WRONG size),
    we rewrite the real IFC geometry once, so the file on disk and the
    3D view always agree.

    Two modes, chosen with --axis:
      uniform : scales X, Y, and Z together. Use this to fix a wrong
                import unit (e.g. a file authored in millimeters that
                got loaded as if it were meters).
      y       : scales ONLY the vertical (height) axis. Use this for
                "set ceiling height for the whole floor plan" — X/Y
                floor-plan layout is completely untouched.

    See module docstring for full limitations.
    """
    if not args.factor or args.factor <= 0:
        raise ValueError("--factor must be a positive number")

    axis = args.axis or "uniform"
    if axis not in ("uniform", "y"):
        raise ValueError("--axis must be 'uniform' or 'y'")

    ratio = args.factor
    source = ifcopenshell.open(args.input)
    
    logger.info(f"Initiating global rescale. Factor: {ratio}, Axis: {axis}")

    # 1. Scale every cartesian point in the file. One pass covers
    #    placement translations (IfcAxis2Placement3D.Location), profile
    #    outline points (IfcArbitraryClosedProfileDef polylines), and any
    #    explicit point-based geometry.
    for pt in source.by_type("IfcCartesianPoint"):
        coords = list(pt.Coordinates)
        if axis == "uniform":
            coords = [c * ratio for c in coords]
        elif len(coords) >= 3:
            coords[2] = coords[2] * ratio  # Z (up) only
        pt.Coordinates = tuple(coords)

    # 2. Scale extrusion depths. For a vertically-extruded wall/column,
    #    Depth IS the height, so under --axis y this is what actually
    #    makes every wall taller/shorter in lockstep.
    for solid in source.by_type("IfcExtrudedAreaSolid"):
        solid.Depth = solid.Depth * ratio

        # Under uniform scale the profile's own extents need scaling too —
        # XDim/YDim are raw scalars, not points, so pass 1 doesn't touch them.
        if axis == "uniform":
            profile = solid.SweptArea
            if profile.is_a("IfcRectangleProfileDef"):
                profile.XDim = profile.XDim * ratio
                profile.YDim = profile.YDim * ratio

    # 3. IfcMappedItem instances carry their own scale factor, separate
    #    from their target geometry's points.
    for mapped in source.by_type("IfcMappedItem"):
        transform = mapped.MappingTarget
        if transform.is_a("IfcCartesianTransformationOperator3D"):
            current_scale = transform.Scale if transform.Scale is not None else 1.0
            if axis == "uniform":
                transform.Scale = current_scale * ratio

    target_path = args.output or args.input
    source.write(target_path)
    
    # 1. ADD THIS: We must print a JSON response so your Node.js server doesn't crash!
    print(json.dumps({
        "success": True,
        "outputPath": target_path,
        "factor": args.factor,
        "axis": axis
    }))


# ── Door insertion (Phase 3) ──────────────────────────────────────────
# Tunable defaults. Width/height fall back to a standard door size until
# asset_registry.json is wired up to look these dimensions up by
# assetId (matches the existing furniture asset_registry pattern).
DEFAULT_DOOR_WIDTH = 0.9
DEFAULT_DOOR_HEIGHT = 2.1
DEFAULT_WALL_THICKNESS_FALLBACK = 0.2
# Extra overshoot added to EACH side of the void's thickness, beyond the
# wall's real thickness, so the boolean cut fully punctures both faces
# despite floating-point/alignment slop. Mirrored in the official
# ifcopenshell api.feature.add_feature docstring example, which uses the
# same trick.
VOID_THICKNESS_MARGIN = 0.05


def _parse_vec3(raw, label):
    """Parses server.js's comma-joined 'x,y,z' string args into 3 floats."""
    try:
        parts = [float(p) for p in raw.split(",")]
    except (ValueError, AttributeError):
        raise ValueError(f"--{label} must be a comma-separated 'x,y,z' string, got: {raw!r}")
    if len(parts) != 3:
        raise ValueError(f"--{label} must have exactly 3 components, got: {raw!r}")
    return tuple(parts)


def _frontend_to_ifc_point(x, y, z):
    """
    !!! UNVERIFIED — flag per this project's recurring Z-up/Y-up history !!!

    Frontend (xeokit) world space is Y-up, right-handed: (X, Y_up, Z).
    IFC world space is Z-up, right-handed: (X, Y, Z_up).

    Assumed mapping (the standard Y-up -> Z-up change of basis, a +90°
    rotation about the shared X axis):
        IFC_x =  frontend_x
        IFC_y = -frontend_z
        IFC_z =  frontend_y

    This has NOT been cross-checked against whatever convention
    scene_merger.py / aps-pipeline.js already use elsewhere in this same
    pipeline for the same Z-up/Y-up bridge. If those files use a
    different sign or axis pairing, use THAT one here instead of
    guessing a second, possibly-inconsistent convention — two different
    Y-up<->Z-up mappings coexisting in one pipeline is exactly the kind
    of bug this project has hit before. Verify with one real door
    placement before trusting this in production.
    """
    return (x, -z, y)


def _ifc_to_frontend_point(x, y, z):
    """Exact inverse of _frontend_to_ifc_point — same unverified caveat
    applies. Used to hand the void's TRUE computed center back to the
    frontend, so it can place the visual door mesh at the exact same
    point Python used for the cut, instead of the frontend re-deriving
    (and potentially double-counting) its own centering offset."""
    return (x, z, -y)


def _estimate_wall_thickness(wall):
    """Rough wall-thickness heuristic: for a standard wall profile,
    thickness is virtually always the SHORTER side (walls run much
    longer than they are thick). Handles both profile shapes already
    supported elsewhere in this file (see cmd_inspect/cmd_resize) — a
    plain IfcRectangleProfileDef, or the IfcArbitraryClosedProfileDef
    polyline that ifcopenshell's own add_wall_representation() helper
    produces. Falls back to a fixed default otherwise (see module
    LIMITATIONS)."""
    solid, _ = get_extruded_solid(wall)
    if solid is None:
        logger.warning(f"Wall {wall.GlobalId} has no IfcExtrudedAreaSolid — using fallback thickness {DEFAULT_WALL_THICKNESS_FALLBACK}m")
        return DEFAULT_WALL_THICKNESS_FALLBACK

    profile = solid.SweptArea

    if profile.is_a("IfcRectangleProfileDef"):
        return min(profile.XDim, profile.YDim)

    if profile.is_a("IfcArbitraryClosedProfileDef"):
        curve = profile.OuterCurve
        if curve.is_a("IfcPolyline"):
            pts = [p.Coordinates for p in curve.Points]
        elif curve.is_a("IfcIndexedPolyCurve"):
            pts = curve.Points.CoordList
        else:
            logger.warning(f"Wall {wall.GlobalId} has an unsupported curve type on its profile — using fallback thickness {DEFAULT_WALL_THICKNESS_FALLBACK}m")
            return DEFAULT_WALL_THICKNESS_FALLBACK
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        width, length = max(xs) - min(xs), max(ys) - min(ys)
        if width > 0 and length > 0:
            return min(width, length)

    logger.warning(f"Wall {wall.GlobalId} has an unsupported profile type ({profile.is_a()}) — using fallback thickness {DEFAULT_WALL_THICKNESS_FALLBACK}m")
    return DEFAULT_WALL_THICKNESS_FALLBACK


def _normalize_vec3(values, name):
    vec = np.asarray(values, dtype=float).reshape(3)
    norm = float(np.linalg.norm(vec))
    if norm < 1e-9:
        raise ValueError(f"{name} is degenerate")
    return vec / norm


def _profile_bounds(profile):
    """Return min/max bounds of an extruded profile in its own 2D plane."""
    if profile.is_a("IfcRectangleProfileDef"):
        x = float(profile.XDim)
        y = float(profile.YDim)
        return (-x / 2.0, x / 2.0, -y / 2.0, y / 2.0)

    if profile.is_a("IfcArbitraryClosedProfileDef"):
        curve = profile.OuterCurve
        if curve.is_a("IfcPolyline"):
            points = [tuple(p.Coordinates) for p in curve.Points]
        elif curve.is_a("IfcIndexedPolyCurve"):
            points = [tuple(p) for p in curve.Points.CoordList]
        else:
            raise ValueError(
                f"Wall profile {profile.is_a()} is not supported for hosted door placement."
            )

        xs = [float(p[0]) for p in points]
        ys = [float(p[1]) for p in points]
        if not xs or not ys:
            raise ValueError("Wall profile contains no usable points.")
        return (min(xs), max(xs), min(ys), max(ys))

    raise ValueError(
        f"Wall profile {profile.is_a()} is not supported for hosted door placement."
    )


def _get_host_wall_frame(wall):
    """
    Derive the wall frame from the ACTUAL IFC wall placement and swept solid.

    The returned frame is in IFC world space and consists of:
      - body_matrix: solid local -> IFC world
      - run_axis: long profile axis, in world space
      - thickness_axis: short profile axis, in world space
      - up_axis: extrusion axis, in world space
      - profile bounds in the solid's local XY plane
      - wall height / thickness / run length
    """
    solid, _ = get_extruded_solid(wall)
    if solid is None:
        raise ValueError(
            f"Wall {wall.GlobalId} has no IfcExtrudedAreaSolid Body representation."
        )

    if wall.ObjectPlacement is None:
        raise ValueError(f"Wall {wall.GlobalId} has no IfcLocalPlacement.")

    def _placement_matrix(placement):
        if placement is None:
            return np.eye(4)
        if placement.is_a("IfcLocalPlacement"):
            return np.asarray(get_local_placement(placement), dtype=float)
        if placement.is_a("IfcAxis2Placement3D"):
            return np.asarray(get_axis2placement(placement), dtype=float)
        raise ValueError(
            f"Unsupported placement type for hosted wall geometry: {placement.is_a()}"
        )

    # IMPORTANT: wall.ObjectPlacement is typically IfcLocalPlacement, while
    # IfcExtrudedAreaSolid.Position is an IfcAxis2Placement3D. Passing the
    # latter into get_local_placement() causes: "IfcAxis2Placement3D has no
    # attribute PlacementRelTo". Resolve each placement type explicitly.
    wall_matrix = _placement_matrix(wall.ObjectPlacement)
    solid_matrix = _placement_matrix(getattr(solid, "Position", None))

    # Solid/profile space -> IFC world space.
    body_matrix = wall_matrix @ solid_matrix

    profile = solid.SweptArea
    min_x, max_x, min_y, max_y = _profile_bounds(profile)
    span_x = max_x - min_x
    span_y = max_y - min_y
    if span_x <= 1e-9 or span_y <= 1e-9:
        raise ValueError(f"Wall {wall.GlobalId} has invalid profile bounds.")

    # Walls run along their longer profile axis. This is intentionally based on
    # the actual profile dimensions, not on the picked surface normal or a yaw
    # reconstructed in the frontend.
    if span_x >= span_y:
        run_axis_index = 0
        thickness_axis_index = 1
        run_min, run_max = min_x, max_x
        thickness_min, thickness_max = min_y, max_y
        wall_run = span_x
        wall_thickness = span_y
    else:
        run_axis_index = 1
        thickness_axis_index = 0
        run_min, run_max = min_y, max_y
        thickness_min, thickness_max = min_x, max_x
        wall_run = span_y
        wall_thickness = span_x

    run_axis = _normalize_vec3(body_matrix[:3, run_axis_index], "wall run axis")
    thickness_axis = _normalize_vec3(body_matrix[:3, thickness_axis_index], "wall thickness axis")
    up_axis = _normalize_vec3(body_matrix[:3, 2], "wall up axis")

    return {
        "bodyMatrix": body_matrix,
        "runAxis": run_axis,
        "runAxisIndex": run_axis_index,
        "thicknessAxis": thickness_axis,
        "upAxis": up_axis,
        "runMin": float(run_min),
        "runMax": float(run_max),
        "thicknessMin": float(thickness_min),
        "thicknessMax": float(thickness_max),
        "wallRun": float(wall_run),
        "wallThickness": float(wall_thickness),
        "wallHeight": float(solid.Depth),
    }


def _world_point_to_wall_local(body_matrix, ifc_point):
    inverse = np.linalg.inv(body_matrix)
    local = inverse @ np.array([ifc_point[0], ifc_point[1], ifc_point[2], 1.0], dtype=float)
    return local[:3]


def _ifc_horizontal_to_frontend_yaw(axis):
    """Convert an IFC Z-up horizontal tangent to a Three/xeokit Y-up yaw.

    Frontend basis is X-right, Y-up, Z-forward. IFC horizontal tangent is
    (X, Y, 0). IFC +Y maps to frontend -Z, therefore a positive frontend Y
    rotation maps door-local +X onto IFC +Y.
    """
    return math.degrees(math.atan2(float(axis[1]), float(axis[0])))


def _write_isolated_wall_preview(source, wall, opening, output_path):
    """Write only the edited host wall + its opening relationship.

    The main output remains a full IFC for downstream compilation/history.
    The preview is intentionally wall-only so the frontend never loads another
    complete copy of the building and pollutes Xeokit picking.
    """
    target = ifcopenshell.file(schema=source.schema)

    projects = source.by_type("IfcProject")
    for project in projects:
        target.add(project)

    target_wall = target.add(wall)
    target_opening = target.add(opening)

    relation = None
    for rel in source.by_type("IfcRelVoidsElement"):
        if rel.RelatingBuildingElement == wall and rel.RelatedOpeningElement == opening:
            relation = rel
            break

    if relation is not None:
        owner_history = target.add(relation.OwnerHistory) if relation.OwnerHistory else None
        kwargs = {
            "GlobalId": relation.GlobalId,
        }
        if owner_history is not None:
            kwargs["OwnerHistory"] = owner_history
        target.create_entity(
            "IfcRelVoidsElement",
            **kwargs,
            RelatingBuildingElement=target_wall,
            RelatedOpeningElement=target_opening,
        )

    target.write(output_path)
    return output_path


def cmd_insert_door(args):
    """
    Insert a semantic IFC opening hosted by the selected wall.

    Placement is wall-host driven:
      1. frontend supplies only the actual picked world point + host wall id;
      2. this function reads the wall's real IFC placement/profile;
      3. the click is projected into the wall's local run/thickness frame;
      4. the door is clamped so its full width stays inside the wall;
      5. the opening is centered on the wall's measured thickness centerline;
      6. the door base is aligned with the host wall's actual extrusion base;
      7. the returned visual transform uses the same host frame.

    The existing IfcOpeningElement + IfcRelVoidsElement mechanism is preserved.
    """
    source = ifcopenshell.open(args.input)
    wall = find_element(source, args.global_id)

    logger.info(
        f"[DoorHost] Inserting hosted door into wall {args.global_id} "
        f"(asset {args.asset_id})"
    )

    fx, fy, fz = _parse_vec3(args.position, "position")
    frontend_point = (fx, fy, fz)
    ifc_point = _frontend_to_ifc_point(fx, fy, fz)

    # Rotation is deliberately ignored for hosted placement. The wall's IFC
    # frame is the authoritative orientation; the frontend value remains in
    # the request only for backwards compatibility with the existing route.
    _, requested_yaw = _parse_vec3(args.rotation, "rotation")[:2]
    logger.info(f"[DoorHost] Ignoring frontend yaw {requested_yaw:.3f}°; using IFC wall frame.")

    frame = _get_host_wall_frame(wall)
    body_matrix = frame["bodyMatrix"]
    logger.info(
        "[DoorHost] Wall frame resolved: run=%s thickness=%s height=%s runAxis=%s",
        frame["wallRun"], frame["wallThickness"], frame["wallHeight"],
        [round(float(v), 6) for v in frame["runAxis"]],
    )
    local_hit = _world_point_to_wall_local(body_matrix, ifc_point)

    width = float(args.width if args.width is not None else DEFAULT_DOOR_WIDTH)
    height = float(args.height if args.height is not None else DEFAULT_DOOR_HEIGHT)
    if width <= 0 or height <= 0:
        raise ValueError("Door width and height must be positive.")

    if frame["wallRun"] + 1e-9 < width:
        raise ValueError(
            f"Door width {width:.3f}m is larger than host wall run {frame['wallRun']:.3f}m."
        )
    if frame["wallHeight"] + 1e-9 < height:
        raise ValueError(
            f"Door height {height:.3f}m is larger than host wall height {frame['wallHeight']:.3f}m."
        )

    # Project the click onto the wall's run axis, then clamp the CENTER so the
    # entire opening remains inside the wall profile.
    run_center_min = frame["runMin"] + width / 2.0
    run_center_max = frame["runMax"] - width / 2.0
    clicked_along = float(local_hit[frame["runAxisIndex"]]) if "runAxisIndex" in frame else float(
        local_hit[0] if frame["wallRun"] == frame["runMax"] - frame["runMin"] else local_hit[1]
    )
    center_along = min(max(clicked_along, run_center_min), run_center_max)

    # The opening is always centered through the real wall thickness. The
    # vertical click coordinate is intentionally ignored: standard door
    # placement starts at the host wall's extrusion base.
    center_through = (frame["thicknessMin"] + frame["thicknessMax"]) / 2.0
    base_height = 0.0
    center_local = np.array([local_hit[0], local_hit[1], base_height], dtype=float)
    if frame["runAxisIndex"] == 0:
        center_local[0] = center_along
        center_local[1] = center_through
    else:
        center_local[0] = center_through
        center_local[1] = center_along

    world_center_h = body_matrix @ np.array(
        [center_local[0], center_local[1], center_local[2], 1.0], dtype=float
    )
    center_x, center_y, center_z = [float(v) for v in world_center_h[:3]]

    run_axis = frame["runAxis"]
    thickness_axis = frame["thicknessAxis"]
    up_axis = frame["upAxis"]
    # add_wall_representation creates a local box from X=0..width, Y centered
    # by offset, and extrudes along +Z. Shift the local X origin back by half
    # the requested width so the resulting opening is centered on our host point.
    origin = np.array([center_x, center_y, center_z], dtype=float) - (width / 2.0) * run_axis

    wall_thickness = frame["wallThickness"]
    if args.thickness is not None:
        logger.info(
            f"--thickness={args.thickness} received (door leaf thickness only); "
            f"using measured wall thickness {wall_thickness:.4f}m."
        )
    void_thickness = wall_thickness + (2 * VOID_THICKNESS_MARGIN)

    _, wall_body_rep = get_extruded_solid(wall)
    if wall_body_rep is None:
        raise ValueError(
            f"Wall {args.global_id} has no Body representation to attach the opening geometry to."
        )

    context = wall_body_rep.ContextOfItems

    opening = ifcopenshell.api.root.create_entity(
        source,
        ifc_class="IfcOpeningElement",
        name=f"Door Opening ({args.asset_id})",
    )

    opening_rep = ifcopenshell.api.geometry.add_wall_representation(
        source,
        context=context,
        length=width,
        height=height,
        thickness=void_thickness,
        offset=-void_thickness / 2.0,
    )
    ifcopenshell.api.geometry.assign_representation(
        source, product=opening, representation=opening_rep
    )

    world_matrix = np.array([
        [run_axis[0], thickness_axis[0], up_axis[0], origin[0]],
        [run_axis[1], thickness_axis[1], up_axis[1], origin[1]],
        [run_axis[2], thickness_axis[2], up_axis[2], origin[2]],
        [0.0,         0.0,              0.0,         1.0],
    ])
    ifcopenshell.api.geometry.edit_object_placement(
        source, product=opening, matrix=world_matrix
    )

    # Preserve the semantic IFC hosting model.
    ifcopenshell.api.feature.add_feature(
        source, feature=opening, element=wall
    )

    source.write(args.output)
    logger.info(f"[DoorHost] Door void written to: {args.output}")

    preview_path = str(Path(args.output).with_name(Path(args.output).stem + "_preview.ifc"))
    _write_isolated_wall_preview(source, wall, opening, preview_path)
    logger.info(f"[DoorHost] Wall-only preview written to: {preview_path}")

    placement_fx, placement_fy, placement_fz = _ifc_to_frontend_point(
        center_x, center_y, center_z
    )
    yaw_deg = _ifc_horizontal_to_frontend_yaw(run_axis)

    host_offset = center_along - frame["runMin"]
    host_offset = max(0.0, min(host_offset, frame["wallRun"]))

    print(json.dumps({
        "success": True,
        "globalId": args.global_id,
        "openingGlobalId": opening.GlobalId,
        "assetId": args.asset_id,
        "outputPath": args.output,
        "voidDimensions": {
            "width": width,
            "height": height,
            "thickness": void_thickness,
        },
        "previewFileName": Path(preview_path).name,
        "hostPlacement": {
            "wallGlobalId": args.global_id,
            "offsetAlongWall": host_offset,
            "wallRun": frame["wallRun"],
            "wallThickness": wall_thickness,
            "wallHeight": frame["wallHeight"],
            "baseElevation": center_z,
            "runAxis": [float(v) for v in run_axis],
            "thicknessAxis": [float(v) for v in thickness_axis],
            "upAxis": [float(v) for v in up_axis],
        },
        "doorPlacement": {
            "position": [placement_fx, placement_fy, placement_fz],
            "rotation": [0, yaw_deg, 0],
        },
    }))


# 2. ADD THIS ENTIRE BLOCK: Without this, Python just reads the file and exits without doing anything!
def main():
    parser = argparse.ArgumentParser(description="Server-side IFC element editor")
    parser.add_argument("mode", choices=["inspect", "resize", "isolate", "rescale", "insert-door"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    parser.add_argument("--global-id", dest="global_id")
    parser.add_argument("--height", type=float)
    parser.add_argument("--width", type=float)
    parser.add_argument("--length", type=float)
    parser.add_argument("--factor", type=float, default=1.0)
    parser.add_argument("--axis", choices=["uniform", "y"], default="uniform")
    parser.add_argument("--asset-id", dest="asset_id")
    parser.add_argument("--position")
    parser.add_argument("--rotation")
    parser.add_argument("--thickness", type=float)

    args = parser.parse_args()

    try:
        if args.mode == "inspect":
            cmd_inspect(args)
        elif args.mode == "resize":
            cmd_resize(args)
        elif args.mode == "isolate":
            cmd_isolate(args)
        elif args.mode == "rescale":
            cmd_rescale(args)
        elif args.mode == "insert-door":
            cmd_insert_door(args)
    except Exception as e:
        logger.error(f"Error during execution: {str(e)}")
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()