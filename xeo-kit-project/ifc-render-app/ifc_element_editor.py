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

try:
    import ifcopenshell
    import ifcopenshell.util.element
    import ifcopenshell.api
except ImportError:
    print(json.dumps({
        "error": "ifcopenshell is not installed on this server. Run: pip install ifcopenshell"
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


# 2. ADD THIS ENTIRE BLOCK: Without this, Python just reads the file and exits without doing anything!
def main():
    parser = argparse.ArgumentParser(description="Server-side IFC element editor")
    parser.add_argument("mode", choices=["inspect", "resize", "isolate", "rescale"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    parser.add_argument("--global-id", dest="global_id")
    parser.add_argument("--height", type=float)
    parser.add_argument("--width", type=float)
    parser.add_argument("--length", type=float)
    parser.add_argument("--factor", type=float, default=1.0)
    parser.add_argument("--axis", choices=["uniform", "y"], default="uniform")
    
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
    except Exception as e:
        logger.error(f"Error during execution: {str(e)}")
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()