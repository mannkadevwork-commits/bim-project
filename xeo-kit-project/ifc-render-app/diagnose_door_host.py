#!/usr/bin/env python3
"""
HCI door-host geometry diagnostic.

Read-only: never writes or modifies an IFC.
Designed to run in the backend environment where ifcopenshell is installed.

Goals:
  1. Inspect a host wall's IFC placement and extrusion/profile dimensions.
  2. Report the wall-local tangent/thickness/up axes.
  3. Compare those axes with the CURRENT frontend yaw-based placement model.
  4. Convert a supplied Xeokit Y-up click point to the current IFC mapping.
  5. Project that point into the wall-local horizontal frame.
  6. Inspect a door asset's local bounding box / placements.

This is a diagnostic only. It does not alter PlacementController, BIMViewer,
server.js, ifc_element_editor.py, project state, or any production IFC.
"""

import argparse
import json
import math
import sys
from pathlib import Path

try:
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.util.placement
except ImportError as exc:
    print("ERROR: ifcopenshell is required in the backend environment:", exc, file=sys.stderr)
    raise SystemExit(2)


def fmt_vec(v):
    return [round(float(x), 6) for x in v]


def norm(v):
    return math.sqrt(sum(x * x for x in v))


def normalize(v):
    n = norm(v)
    if n <= 1e-12:
        raise ValueError(f"Cannot normalize near-zero vector: {v}")
    return tuple(x / n for x in v)


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def mat_apply(m, p):
    return (
        float(m[0][0]) * p[0] + float(m[0][1]) * p[1] + float(m[0][2]) * p[2] + float(m[0][3]),
        float(m[1][0]) * p[0] + float(m[1][1]) * p[1] + float(m[1][2]) * p[2] + float(m[1][3]),
        float(m[2][0]) * p[0] + float(m[2][1]) * p[1] + float(m[2][2]) * p[2] + float(m[2][3]),
    )


def mat_axes(m):
    # IFC placement matrix columns are local X/Y/Z axes expressed in parent space.
    x = (float(m[0][0]), float(m[1][0]), float(m[2][0]))
    y = (float(m[0][1]), float(m[1][1]), float(m[2][1]))
    z = (float(m[0][2]), float(m[1][2]), float(m[2][2]))
    return normalize(x), normalize(y), normalize(z)


def find_body_solid(element):
    rep = getattr(element, "Representation", None)
    if not rep:
        return None
    preferred = {"Body", "Box", "SweptSolid"}
    for representation in rep.Representations:
        if representation.RepresentationIdentifier not in preferred:
            continue
        for item in representation.Items:
            if item.is_a("IfcExtrudedAreaSolid"):
                return item
    return None


def profile_dims(solid):
    profile = solid.SweptArea
    if profile.is_a("IfcRectangleProfileDef"):
        return {
            "type": profile.is_a(),
            "xDim": float(profile.XDim),
            "yDim": float(profile.YDim),
        }
    if profile.is_a("IfcArbitraryClosedProfileDef"):
        curve = profile.OuterCurve
        points = None
        if curve.is_a("IfcPolyline"):
            points = [p.Coordinates for p in curve.Points]
        elif curve.is_a("IfcIndexedPolyCurve"):
            points = curve.Points.CoordList
        if points:
            xs = [float(p[0]) for p in points]
            ys = [float(p[1]) for p in points]
            return {
                "type": profile.is_a(),
                "xDim": max(xs) - min(xs),
                "yDim": max(ys) - min(ys),
                "source": "polyline bounds",
            }
    return {"type": profile.is_a()}


def inspect_wall(model, global_id):
    wall = model.by_guid(global_id)
    if wall is None:
        raise ValueError(f"Wall GlobalId not found: {global_id}")
    if wall.is_a() not in {"IfcWall", "IfcWallStandardCase", "IfcCurtainWall"}:
        raise ValueError(f"{global_id} is {wall.is_a()}, not a supported wall class")

    placement = ifcopenshell.util.placement.get_local_placement(wall.ObjectPlacement)
    m = [[float(c) for c in row] for row in placement]
    local_x, local_y, local_z = mat_axes(m)
    solid = find_body_solid(wall)

    result = {
        "globalId": wall.GlobalId,
        "type": wall.is_a(),
        "name": wall.Name,
        "placementMatrix": [[round(c, 9) for c in row] for row in m],
        "worldOrigin": fmt_vec((m[0][3], m[1][3], m[2][3])),
        "worldAxes": {
            "localX": fmt_vec(local_x),
            "localY": fmt_vec(local_y),
            "localZ": fmt_vec(local_z),
        },
    }

    if solid is not None:
        result["extrusionDepth"] = float(solid.Depth)
        result["profile"] = profile_dims(solid)
        pd = result["profile"]
        if "xDim" in pd and "yDim" in pd:
            result["estimatedWallThickness"] = min(pd["xDim"], pd["yDim"])
            result["estimatedWallRun"] = max(pd["xDim"], pd["yDim"])
    else:
        result["warning"] = "No IfcExtrudedAreaSolid found in Body/Box/SweptSolid."

    return result


def current_frontend_frame_from_yaw(yaw_deg):
    r = math.radians(yaw_deg)
    tangent = (math.cos(r), math.sin(r), 0.0)
    thickness = (-math.sin(r), math.cos(r), 0.0)
    return tangent, thickness, (0.0, 0.0, 1.0)


def frontend_to_ifc(p):
    # Exact mapping currently implemented in ifc_element_editor.py.
    x, y, z = p
    return (x, -z, y)


def project_world_point_to_wall_ifc(point_ifc, wall_result):
    origin = tuple(wall_result["worldOrigin"])
    tangent = tuple(wall_result["worldAxes"]["localX"])
    thickness = tuple(wall_result["worldAxes"]["localY"])
    up = tuple(wall_result["worldAxes"]["localZ"])
    rel = tuple(point_ifc[i] - origin[i] for i in range(3))
    return {
        "localAlongWall": dot(rel, tangent),
        "localThroughWall": dot(rel, thickness),
        "localVertical": dot(rel, up),
        "wallOriginToPoint": fmt_vec(rel),
    }


def inspect_door_asset(path):
    model = ifcopenshell.open(path)
    products = []
    for p in model.by_type("IfcProduct"):
        if not getattr(p, "Representation", None):
            continue
        placement = None
        try:
            placement = ifcopenshell.util.placement.get_local_placement(p.ObjectPlacement)
        except Exception:
            pass
        products.append({
            "globalId": getattr(p, "GlobalId", None),
            "type": p.is_a(),
            "name": getattr(p, "Name", None),
            "placement": [[round(float(c), 9) for c in row] for row in placement] if placement is not None else None,
        })

    # Geometry extraction is intentionally optional; some server installs may
    # have ifcopenshell but not OCC-backed geometry support.
    aabb = None
    try:
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)
        mins = [math.inf, math.inf, math.inf]
        maxs = [-math.inf, -math.inf, -math.inf]
        count = 0
        for element in model.by_type("IfcProduct"):
            if not getattr(element, "Representation", None):
                continue
            shape = ifcopenshell.geom.create_shape(settings, element)
            verts = shape.geometry.verts
            for i in range(0, len(verts), 3):
                mins[0] = min(mins[0], verts[i])
                mins[1] = min(mins[1], verts[i + 1])
                mins[2] = min(mins[2], verts[i + 2])
                maxs[0] = max(maxs[0], verts[i])
                maxs[1] = max(maxs[1], verts[i + 1])
                maxs[2] = max(maxs[2], verts[i + 2])
                count += 1
        if count:
            aabb = {"min": fmt_vec(mins), "max": fmt_vec(maxs), "vertexCount": count}
    except Exception as exc:
        aabb = {"warning": f"Geometry AABB unavailable: {exc}"}

    return {"file": str(path), "products": products, "worldAABB": aabb}


def main():
    parser = argparse.ArgumentParser(description="Read-only HCI door host geometry diagnostic")
    parser.add_argument("--floor-ifc", required=True, help="Current project/floor-plan IFC")
    parser.add_argument("--wall-global-id", help="Host wall GlobalId. If omitted, list first supported walls.")
    parser.add_argument("--door-ifc", help="Door asset IFC to inspect")
    parser.add_argument("--frontend-point", nargs=3, type=float, metavar=("X", "Y", "Z"), help="Xeokit Y-up world point")
    parser.add_argument("--frontend-yaw", type=float, help="Current frontend yaw in degrees")
    args = parser.parse_args()

    model = ifcopenshell.open(args.floor_ifc)
    walls = [
        w for w in (model.by_type("IfcWall") + model.by_type("IfcWallStandardCase") + model.by_type("IfcCurtainWall"))
        if w.GlobalId
    ]

    report = {
        "floorIfc": str(Path(args.floor_ifc).resolve()),
        "schema": model.schema,
        "supportedWallCount": len(walls),
    }

    if not args.wall_global_id:
        report["wallSample"] = [
            {"globalId": w.GlobalId, "type": w.is_a(), "name": w.Name}
            for w in walls[:25]
        ]
    else:
        wall_report = inspect_wall(model, args.wall_global_id)
        report["wall"] = wall_report

        if args.frontend_point:
            p_front = tuple(args.frontend_point)
            p_ifc = frontend_to_ifc(p_front)
            report["clickAnalysis"] = {
                "frontendWorldPoint": fmt_vec(p_front),
                "currentFrontendToIfcPoint": fmt_vec(p_ifc),
                "wallLocalProjection": project_world_point_to_wall_ifc(p_ifc, wall_report),
            }

        if args.frontend_yaw is not None:
            current_t, current_n, current_u = current_frontend_frame_from_yaw(args.frontend_yaw)
            wall_x = tuple(wall_report["worldAxes"]["localX"])
            wall_y = tuple(wall_report["worldAxes"]["localY"])
            wall_z = tuple(wall_report["worldAxes"]["localZ"])
            report["frameComparison"] = {
                "frontendYawDeg": args.frontend_yaw,
                "currentFrontendFrame": {
                    "tangent": fmt_vec(current_t),
                    "thicknessAxis": fmt_vec(current_n),
                    "up": fmt_vec(current_u),
                },
                "actualWallFrame": {
                    "tangent": fmt_vec(wall_x),
                    "thicknessAxis": fmt_vec(wall_y),
                    "up": fmt_vec(wall_z),
                },
                "alignmentDotProducts": {
                    "tangentVsWallX": round(dot(current_t, wall_x), 6),
                    "thicknessVsWallY": round(dot(current_n, wall_y), 6),
                    "upVsWallZ": round(dot(current_u, wall_z), 6),
                },
            }

    if args.door_ifc:
        report["doorAsset"] = inspect_door_asset(args.door_ifc)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
