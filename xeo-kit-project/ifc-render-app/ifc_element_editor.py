#!/usr/bin/env python3
"""
ifc_element_editor.py

Server-side IFC element editor, invoked by server.js via child_process.spawn.
Requires: pip install ifcopenshell

Two operations:

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

LIMITATIONS (v1, flagged honestly rather than failing silently):
  - Only IfcExtrudedAreaSolid representations are supported for resize.
    Swept solids, B-reps, or curved walls will return a clear error.
  - Only IfcRectangleProfileDef is handled for width/length edits.
    Arbitrary/poly-line profiles are not supported yet.
"""

import sys
import argparse
import json

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
    ifc_file = ifcopenshell.open(args.input)
    element = find_element(ifc_file, args.global_id)
    solid, _ = get_extruded_solid(element)

    if solid is None:
        print(json.dumps({
            "error": "This element has no IfcExtrudedAreaSolid representation — "
                     "resize is not supported for curved/complex geometry.",
            "globalId": args.global_id,
            "ifcClass": element.is_a(),
        }))
        return

    profile = solid.SweptArea
    result = {
        "globalId": args.global_id,
        "ifcClass": element.is_a(),
        "name": element.Name or "Unnamed",
        "height": solid.Depth,  # extrusion depth — for a vertical wall, this is its height
        "profileType": profile.is_a(),
    }

    if profile.is_a("IfcRectangleProfileDef"):
        result["width"] = profile.XDim
        result["length"] = profile.YDim
    else:
        result["note"] = (
            f"Profile type '{profile.is_a()}' is not a simple rectangle — "
            "width/length editing is not supported for this element yet."
        )

    print(json.dumps(result))


def cmd_resize(args):
    ifc_file = ifcopenshell.open(args.input)
    element = find_element(ifc_file, args.global_id)
    solid, _ = get_extruded_solid(element)

    if solid is None:
        print(json.dumps({
            "error": "This element has no IfcExtrudedAreaSolid representation — "
                     "resize is not supported for curved/complex geometry."
        }))
        sys.exit(1)

    changed = {}

    if args.height is not None:
        solid.Depth = args.height
        changed["height"] = args.height

    if args.width is not None or args.length is not None:
        profile = solid.SweptArea
        if not profile.is_a("IfcRectangleProfileDef"):
            print(json.dumps({
                "error": f"Profile type '{profile.is_a()}' does not support "
                         "width/length editing yet (only IfcRectangleProfileDef is)."
            }))
            sys.exit(1)
        if args.width is not None:
            profile.XDim = args.width
            changed["width"] = args.width
        if args.length is not None:
            profile.YDim = args.length
            changed["length"] = args.length

    ifc_file.write(args.output)
    print(json.dumps({
        "success": True,
        "globalId": args.global_id,
        "changed": changed,
        "outputPath": args.output,
    }))


def cmd_isolate(args):
    """Builds a minimal standalone IFC containing only the target element
    and the spatial ancestors it needs (project/site/building/storey),
    plus shared units and geometric context. This mirrors how furniture
    assets are already loaded as independent models in the frontend, so
    the same model-level position/scale/rotation transform machinery can
    be reused for a single isolated wall."""
    source = ifcopenshell.open(args.input)
    element = find_element(source, args.global_id)

    # Create a fresh IFC file of the same schema version as the source.
    target = ifcopenshell.file(schema=source.schema)

    # add_element pulls in the element plus everything it inversely/directly
    # depends on (representations, placements, materials). We still need to
    # walk up and add its spatial container chain (storey -> building -> site
    # -> project) ourselves so the model remains spatially valid.
    new_element = target.add(element)

    container = ifcopenshell.util.element.get_container(element)
    while container is not None:
        target.add(container)
        container = ifcopenshell.util.element.get_container(container)

    # Pull in the project's unit assignment so dimensions render at the
    # correct real-world scale (a model with no units defaults to unitless,
    # which would make the wall appear at the wrong size in xeokit).
    project = next(iter(source.by_type("IfcProject")), None)
    if project is not None and getattr(project, "UnitsInContext", None):
        target.add(project.UnitsInContext)

    target.write(args.output)
    print(json.dumps({
        "success": True,
        "globalId": args.global_id,
        "outputPath": args.output,
    }))


def main():
    parser = argparse.ArgumentParser(description="Server-side IFC element editor")
    parser.add_argument("mode", choices=["inspect", "resize", "isolate"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    parser.add_argument("--global-id", required=True, dest="global_id")
    parser.add_argument("--height", type=float)
    parser.add_argument("--width", type=float)
    parser.add_argument("--length", type=float)
    args = parser.parse_args()

    try:
        if args.mode == "inspect":
            cmd_inspect(args)
        elif args.mode == "resize":
            if not args.output:
                raise ValueError("--output is required for resize")
            cmd_resize(args)
        elif args.mode == "isolate":
            if not args.output:
                raise ValueError("--output is required for isolate")
            cmd_isolate(args)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
