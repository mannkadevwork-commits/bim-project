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


def cmd_inspect(args):
    source = ifcopenshell.open(args.input)
    element = find_element(source, args.global_id)

    rep = next((r for r in element.Representation.Representations if r.RepresentationIdentifier in ["Body", "SweptSolid"]), None)
    if not rep:
        raise ValueError("No Body/SweptSolid representation found.")

    solid = rep.Items[0]
    if not solid.is_a("IfcExtrudedAreaSolid"):
        raise ValueError("This element has no IfcExtrudedAreaSolid representation.")

    height = solid.Depth
    width = 0.0
    length = 0.0

    profile = solid.SweptArea
    
    # Handle standard rectangles
    if profile.is_a("IfcRectangleProfileDef"):
        width = profile.XDim
        length = profile.YDim
        
    # Handle custom polygons (ArchiCAD/Revit standard walls)
    elif profile.is_a("IfcArbitraryClosedProfileDef"):
        curve = profile.OuterCurve
        if curve.is_a("IfcPolyline"):
            pts = [p.Coordinates for p in curve.Points]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            width = max(xs) - min(xs)
            length = max(ys) - min(ys)

    print(json.dumps({
        "height": height,
        "width": width,
        "length": length
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


def cmd_insert_door(args):
    """
    Cuts a rectangular door void into a host wall.

    DESIGN CHOICE — flagged explicitly, since it's a real fork from what
    "boolean difference" could mean: this creates an IfcOpeningElement
    related to the wall via IfcRelVoidsElement (ifcopenshell.api.feature.
    add_feature) — the exact mechanism Revit/ArchiCAD/BlenderBIM use for
    every door and window in every IFC file you've ever loaded — rather
    than literally rewriting the wall's own IfcExtrudedAreaSolid into an
    IfcBooleanResult/IfcBooleanClippingResult.

    Verified locally before writing this: ifcopenshell.geom resolves
    IfcRelVoidsElement openings into a real boolean-cut mesh AUTOMATICALLY
    by default (tested against a synthetic wall — vertex count went from
    8 to 18 once the opening relationship existed, confirming the cut is
    actually applied, not just semantically declared). So:
      1. Anywhere downstream that already calls ifcopenshell.geom on this
         wall — per your architecture, that's scene_merger.py's
         structural-geometry pass — sees the hole for free.
      2. No solid-modeling kernel beyond ifcopenshell itself is needed —
         no pythonocc-core / trimesh boolean dependency.
      3. The wall's own GlobalId and base solid are untouched, so your
         GlobalId-keyed material dictionary lookup in scene_merger.py
         keeps working with zero changes.
    If scene_merger.py's own ifcopenshell.geom.settings() call has
    disabled opening subtraction (worth a grep for
    DISABLE_OPENING_SUBTRACTIONS or settings.set), this will silently
    produce a wall with no visible hole — that's the first thing to
    check if Phase 4 renders a solid wall.

    VERTICAL POSITION — per your explicit instruction, this uses the
    passed Z EXACTLY as the void's base; it does NOT snap to floor
    level. Phase 1 currently passes the raw wall-click point
    (wallPick.worldPos), not a floor-level point — if a user clicks at
    wall-height 1.2m, the void's floor sits at 1.2m and the door will
    look like it's floating. Confirm Phase 1 / the calling UI will
    pre-adjust the Y component to floor level before this ships; this
    function will not silently "fix" that by assuming floor level,
    since you asked for the exact passed position.

    UNITS — like every other command in this file (cmd_inspect,
    cmd_resize, cmd_rescale all read/write raw IFC values with no unit
    conversion), this assumes the project's IFC units are already
    meters. If input.ifc is authored in millimeters, args.position /
    args.width / args.height all need scaling first — same assumption,
    same blind spot, as the rest of the script already has.
    """
    source = ifcopenshell.open(args.input)
    wall = find_element(source, args.global_id)

    if not wall.is_a("IfcWall") and not wall.is_a("IfcWallStandardCase"):
        raise ValueError(f"Element {args.global_id} is an {wall.is_a()}, not an IfcWall/IfcWallStandardCase.")

    logger.info(f"Inserting door void into wall {args.global_id} (asset {args.asset_id})")

    # ── Parse + convert the frontend's world-space position/rotation ──
    fx, fy, fz = _parse_vec3(args.position, "position")
    _, yaw_deg, _ = _parse_vec3(args.rotation, "rotation")  # only the Y-axis (yaw) component is used

    loc_x, loc_y, loc_z = _frontend_to_ifc_point(fx, fy, fz)
    yaw_rad = math.radians(yaw_deg)

    # Wall-relative axes in IFC (Z-up) world space, derived purely from
    # yaw — the same atan2(normal.x, normal.z) convention Phase 1 used
    # for orientation, carried through the Y-up -> Z-up mapping above.
    tangent = (math.cos(yaw_rad), math.sin(yaw_rad), 0.0)          # along the wall run (door width axis)
    thickness_axis = (-math.sin(yaw_rad), math.cos(yaw_rad), 0.0)  # through the wall (door thickness axis)
    up = (0.0, 0.0, 1.0)

    # ── Dimensions ──
    width = args.width if args.width is not None else DEFAULT_DOOR_WIDTH
    height = args.height if args.height is not None else DEFAULT_DOOR_HEIGHT
    # TODO(Phase 4): look these up from asset_registry.json by
    # args.asset_id instead of hardcoded defaults, once that registry is
    # wired up for door assets the way it already is for furniture.

    # BUGFIX: --thickness used to be treated as an override for the
    # WALL's thickness. In practice the frontend sends each door
    # catalog item's own LEAF thickness here (e.g. 0.04-0.1m for a
    # slab door) — a completely different number from a real wall's
    # thickness (typically 0.1-0.25m). Trusting it as "wall thickness"
    # made the inward-centering push far too shallow and the void far
    # too narrow to fully punch through a real wall, which is what was
    # producing partial/off-center cuts. The wall's thickness is
    # something only Python can reliably know (it's reading the actual
    # wall geometry) — always measure it, never take it from the
    # frontend.
    if args.thickness is not None:
        logger.info(f"--thickness={args.thickness} received (this is the door leaf's own thickness) — not used for the wall cut; wall thickness is always measured from the wall's own geometry.")
    wall_thickness = _estimate_wall_thickness(wall)
    void_thickness = wall_thickness + (2 * VOID_THICKNESS_MARGIN)

    # The click point Phase 1 gives us lands on the wall's near SURFACE,
    # not its mid-plane. Push the origin inward by half the wall's real
    # thickness along the thickness axis so the void is centered on the
    # wall's centerline — otherwise only half of void_thickness reaches
    # inward from the surface, which for a small margin won't reach the
    # far face and leaves an uncut sliver of wall.
    #
    # IMPORTANT: this is the ONLY place that should push the position
    # inward. If the frontend also nudges the click point toward the
    # wall's center before sending it here (e.g. using a guessed/
    # hardcoded half-thickness), the two pushes stack and the actual
    # void ends up off-center from wherever the visual door asset gets
    # placed. The frontend should send the raw wall-surface click point,
    # unmodified on X/Z, and let this be the single source of truth for
    # centering.
    inward = wall_thickness / 2.0
    center_x = loc_x + inward * thickness_axis[0]
    center_y = loc_y + inward * thickness_axis[1]
    center_z = loc_z  # exact passed Z, per your instruction — see docstring caveat above

    # ── Geometry: reuse ifcopenshell's own add_wall_representation()
    # helper (the same one that would author a real wall) rather than
    # hand-building IfcExtrudedAreaSolid/IfcShapeRepresentation entities.
    # It builds a box from local (0,0) to (length,thickness) in its XY
    # plane, extruded up by `height` — i.e. width runs from the
    # placement origin along local X, not centered on it. `offset`
    # handles Y-centering for us (shifts the box by half the added
    # thickness margin so it's symmetric on the wall's real thickness);
    # X-centering for width is done by shifting the placement origin
    # back by half the width below, same trick. ──
    _, wall_body_rep = get_extruded_solid(wall)
    if wall_body_rep is None:
        raise ValueError(f"Wall {args.global_id} has no Body representation to attach the opening's geometry context to.")

    context = wall_body_rep.ContextOfItems

    opening = ifcopenshell.api.root.create_entity(
        source, ifc_class="IfcOpeningElement", name=f"Door Opening ({args.asset_id})"
    )

    opening_rep = ifcopenshell.api.geometry.add_wall_representation(
        source,
        context=context,
        length=width,
        height=height,
        thickness=void_thickness,
        offset=-void_thickness / 2.0,  # centers the thickness span on the wall's real centerline
    )
    ifcopenshell.api.geometry.assign_representation(source, product=opening, representation=opening_rep)

    # Shift the placement origin back by half the width so the box (which
    # add_wall_representation draws from local X=0 to X=width) ends up
    # centered on center_x/center_y rather than starting there.
    origin_x = center_x - (width / 2.0) * tangent[0]
    origin_y = center_y - (width / 2.0) * tangent[1]

    world_matrix = np.array([
        [tangent[0], thickness_axis[0], up[0], origin_x],
        [tangent[1], thickness_axis[1], up[1], origin_y],
        [tangent[2], thickness_axis[2], up[2], center_z],
        [0.0,        0.0,               0.0,   1.0],
    ])
    ifcopenshell.api.geometry.edit_object_placement(source, product=opening, matrix=world_matrix)

    # ── Relate the opening to the wall. This IS the boolean difference
    # from the geometry pipeline's perspective — see docstring. ──
    rel_voids = ifcopenshell.api.feature.add_feature(source, feature=opening, element=wall)

    # ── Write a minimal standalone file: project context + the wall +
    # the new opening + the relationship — same "isolated copy" pattern
    # cmd_isolate/cmd_resize already use above. ──
    target = ifcopenshell.file(schema=source.schema)
    for project in source.by_type("IfcProject"):
        target.add(project)
    target.add(wall)
    target.add(opening)
    target.add(rel_voids)
    target.write(args.output)

    logger.info(f"Door void written to: {args.output}")

    # Hand back the EXACT center this void was cut at, converted back to
    # frontend Y-up space. This is the single source of truth for where
    # the visual door asset should be placed — the frontend should use
    # this instead of re-deriving its own centering, or the visual door
    # and the actual hole can drift apart (see the inward-push note
    # above for exactly this failure mode).
    placement_fx, placement_fy, placement_fz = _ifc_to_frontend_point(center_x, center_y, center_z)

    print(json.dumps({
        "success": True,
        "globalId": args.global_id,
        "openingGlobalId": opening.GlobalId,
        "assetId": args.asset_id,
        "outputPath": args.output,
        "voidDimensions": {"width": width, "height": height, "thickness": void_thickness},
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