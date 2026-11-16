#!/usr/bin/env python3
"""Independent IFC hosted-window opening engine.

This module deliberately does not add or alter the legacy insert-door endpoint.
It reuses only the existing IFC wall-frame and door-opening primitives so that
mixed wall openings can be rebuilt cumulatively for a wall preview. Window
openings are authored as IfcOpeningElement + IfcWindow + IfcRelFillsElement.

Requires the same server-side IfcOpenShell and NumPy installation as the IFC
editor. The output is JSON on stdout; diagnostics are written to stderr.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from pathlib import Path

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='[WindowOpening] %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)

try:
    import ifcopenshell
    import ifcopenshell.api
    import ifcopenshell.api.root
    import ifcopenshell.api.geometry
    import ifcopenshell.api.feature
    import numpy as np
    import ifc_element_editor as editor
except ImportError as exc:
    print(json.dumps({
        "error": f"Window opening dependencies are unavailable: {exc}. Install ifcopenshell and numpy in the backend Python environment."
    }))
    sys.exit(1)


DEFAULT_WINDOW_WIDTH = 1.2
DEFAULT_WINDOW_HEIGHT = 1.2
DEFAULT_WINDOW_SILL_HEIGHT = 0.9
DEFAULT_WINDOW_THICKNESS = 0.08
VOID_THICKNESS_MARGIN = 0.05
MIN_WINDOW_WIDTH = 0.25
MAX_WINDOW_WIDTH = 4.5
MIN_WINDOW_HEIGHT = 0.25
MAX_WINDOW_HEIGHT = 3.5
MAX_SILL_HEIGHT = 3.0


def _positive_number(value, fallback, label):
    try:
        result = float(value)
    except (TypeError, ValueError):
        result = float(fallback)
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{label} must be a finite positive number.")
    return result


def _window_dimensions(raw):
    raw = raw if isinstance(raw, dict) else {}
    width = _positive_number(raw.get("width"), DEFAULT_WINDOW_WIDTH, "Window width")
    height = _positive_number(raw.get("height"), DEFAULT_WINDOW_HEIGHT, "Window height")
    thickness = _positive_number(raw.get("thickness"), DEFAULT_WINDOW_THICKNESS, "Window thickness")
    try:
        sill_height = float(raw.get("sillHeight", raw.get("sill_height", DEFAULT_WINDOW_SILL_HEIGHT)))
    except (TypeError, ValueError):
        raise ValueError("Window sill height must be numeric.")
    if not math.isfinite(sill_height) or sill_height < 0 or sill_height > MAX_SILL_HEIGHT:
        raise ValueError(f"Window sill height must be between 0 and {MAX_SILL_HEIGHT:.2f}m.")
    if width < MIN_WINDOW_WIDTH or width > MAX_WINDOW_WIDTH:
        raise ValueError(f"Window width must be between {MIN_WINDOW_WIDTH:.2f}m and {MAX_WINDOW_WIDTH:.2f}m.")
    if height < MIN_WINDOW_HEIGHT or height > MAX_WINDOW_HEIGHT:
        raise ValueError(f"Window height must be between {MIN_WINDOW_HEIGHT:.2f}m and {MAX_WINDOW_HEIGHT:.2f}m.")
    return {
        "width": width,
        "height": height,
        "thickness": thickness,
        "sillHeight": sill_height,
    }


def _is_supported_wall(wall):
    return bool(wall) and any(
        wall.is_a(ifc_class)
        for ifc_class in ("IfcWall", "IfcWallStandardCase", "IfcCurtainWall")
    )


def _create_hosted_window_opening(source, wall, spec):
    """Create a real opening and semantic IfcWindow in the selected IFC wall.

    ``position`` is the surface click point in the editor's Y-up coordinate
    system. ``sillHeight`` is measured from the host wall's local base, not from
    world zero. The returned visual placement is the opening centre.
    """
    if not _is_supported_wall(wall):
        raise ValueError(f"Host {getattr(wall, 'GlobalId', 'unknown')} is not a supported IFC wall.")

    asset_id = str(spec.get("assetId") or spec.get("id") or "hosted-window")[:128]
    instance_id = str(spec.get("instanceId") or asset_id)[:160]
    dimensions = _window_dimensions(spec.get("dimensions"))
    requested_width = dimensions["width"]
    requested_height = dimensions["height"]
    sill_height = dimensions["sillHeight"]

    fx, fy, fz = editor._parse_vec3(spec.get("position"), "position")
    ifc_point = editor._frontend_to_ifc_point(fx, fy, fz)
    frame = editor._get_host_wall_frame(wall)
    body_matrix = frame["bodyMatrix"]

    if frame["wallRun"] + 1e-9 < requested_width:
        raise ValueError(
            f"Window width {requested_width:.3f}m is larger than host wall run {frame['wallRun']:.3f}m."
        )
    if sill_height + requested_height > frame["wallHeight"] + 1e-9:
        raise ValueError(
            f"Window sill ({sill_height:.3f}m) plus height ({requested_height:.3f}m) exceeds host wall height ({frame['wallHeight']:.3f}m)."
        )

    local_hit = editor._world_point_to_wall_local(body_matrix, ifc_point)
    run_min = frame["runMin"]
    run_max = frame["runMax"]
    run_center_min = run_min + requested_width / 2.0
    run_center_max = run_max - requested_width / 2.0
    clicked_along = float(local_hit[frame["runAxisIndex"]])
    center_along = min(max(clicked_along, run_center_min), run_center_max)
    center_through = (frame["thicknessMin"] + frame["thicknessMax"]) / 2.0
    center_height = sill_height + requested_height / 2.0

    center_local = np.array([local_hit[0], local_hit[1], center_height], dtype=float)
    if frame["runAxisIndex"] == 0:
        center_local[0] = center_along
        center_local[1] = center_through
    else:
        center_local[0] = center_through
        center_local[1] = center_along

    center_world_h = body_matrix @ np.array(
        [center_local[0], center_local[1], center_local[2], 1.0], dtype=float
    )
    center_world = np.asarray(center_world_h[:3], dtype=float)

    run_axis = frame["runAxis"]
    thickness_axis = frame["thicknessAxis"]
    up_axis = frame["upAxis"]
    origin = center_world - (requested_width / 2.0) * run_axis - (requested_height / 2.0) * up_axis

    wall_thickness = float(frame["wallThickness"])
    void_thickness = wall_thickness + (2.0 * VOID_THICKNESS_MARGIN)
    _, wall_body_rep = editor.get_extruded_solid(wall)
    if wall_body_rep is None:
        raise ValueError(f"Wall {wall.GlobalId} has no Body representation to host a window opening.")

    opening = ifcopenshell.api.root.create_entity(
        source,
        ifc_class="IfcOpeningElement",
        name=f"Window Opening ({asset_id})",
    )
    opening_rep = ifcopenshell.api.geometry.add_wall_representation(
        source,
        context=wall_body_rep.ContextOfItems,
        length=requested_width,
        height=requested_height,
        thickness=void_thickness,
        offset=-void_thickness / 2.0,
    )
    ifcopenshell.api.geometry.assign_representation(source, product=opening, representation=opening_rep)

    world_matrix = np.array([
        [run_axis[0], thickness_axis[0], up_axis[0], origin[0]],
        [run_axis[1], thickness_axis[1], up_axis[1], origin[1]],
        [run_axis[2], thickness_axis[2], up_axis[2], origin[2]],
        [0.0,         0.0,              0.0,         1.0],
    ], dtype=float)
    ifcopenshell.api.geometry.edit_object_placement(source, product=opening, matrix=world_matrix)
    ifcopenshell.api.feature.add_feature(source, feature=opening, element=wall)

    # The catalog GLB/IFC remains the visible editor object. This semantic IFC
    # window intentionally has no duplicate placeholder geometry.
    window = ifcopenshell.api.root.create_entity(
        source,
        ifc_class="IfcWindow",
        name=str(spec.get("name") or f"Window ({asset_id})")[:255],
    )
    window.OverallHeight = requested_height
    window.OverallWidth = requested_width
    if hasattr(window, "PredefinedType"):
        try:
            window.PredefinedType = "WINDOW"
        except Exception:
            logger.warning("Could not set IfcWindow.PredefinedType for %s; retaining schema default.", instance_id)
    if hasattr(window, "Tag"):
        window.Tag = instance_id[:255]
    ifcopenshell.api.geometry.edit_object_placement(source, product=window, matrix=world_matrix)

    # Create the filling relationship explicitly. This keeps the semantic
    # relationship unambiguous across IfcOpenShell API version differences.
    source.create_entity(
        "IfcRelFillsElement",
        GlobalId=ifcopenshell.guid.new(),
        RelatingOpeningElement=opening,
        RelatedBuildingElement=window,
    )

    center_fx, center_fy, center_fz = editor._ifc_to_frontend_point(*center_world.tolist())
    yaw_deg = editor._ifc_horizontal_to_frontend_yaw(run_axis)
    host_offset = max(0.0, min(center_along - run_min, frame["wallRun"]))

    return {
        "success": True,
        "instanceId": instance_id,
        "assetId": asset_id,
        "wallGlobalId": wall.GlobalId,
        "openingGlobalId": opening.GlobalId,
        "windowGlobalId": window.GlobalId,
        "dimensions": dimensions,
        "voidDimensions": {
            "width": requested_width,
            "height": requested_height,
            "thickness": void_thickness,
        },
        "hostPlacement": {
            "wallGlobalId": wall.GlobalId,
            "offsetAlongWall": host_offset,
            "wallRun": frame["wallRun"],
            "wallThickness": wall_thickness,
            "wallHeight": frame["wallHeight"],
            "sillHeight": sill_height,
            "baseElevation": float(center_world[2]),
            "runAxis": [float(v) for v in run_axis],
            "thicknessAxis": [float(v) for v in thickness_axis],
            "upAxis": [float(v) for v in up_axis],
        },
        "windowPlacement": {
            "position": [float(center_fx), float(center_fy), float(center_fz)],
            "rotation": [0.0, float(yaw_deg), 0.0],
        },
    }


def _write_isolated_wall_preview_with_fillings(preview_model, wall, output_path):
    """Write a one-wall preview without copying entities between IFC files.

    Older code created a second IFC file and recursively copied IfcProject,
    wall, opening, filling and OwnerHistory entities with ``file.add``. That
    operation can fail with ``RuntimeError: Unable to map instance to file``
    when the source IFC uses a schema addendum (e.g. IFC4X3_ADD2) or contains a
    malformed reference anywhere in the project graph.

    The caller now re-opens the already-written modified IFC. We prune that
    independent in-memory copy in place, so every retained entity and reference
    remains in the same IfcOpenShell file. This preserves the complete project
    header, units, contexts, placements, materials and representation graph
    without crossing file boundaries.
    """
    wall_global_id = str(getattr(wall, "GlobalId", "") or "")
    if not wall_global_id:
        raise ValueError("Cannot create a wall preview without a host wall GlobalId.")

    # Resolve the wall in this exact preview file. The passed entity must belong
    # to preview_model; resolving by GlobalId also protects callers from passing
    # an entity from the original, separately opened IFC handle.
    preview_wall = editor.find_element(preview_model, wall_global_id)
    if not _is_supported_wall(preview_wall):
        raise ValueError(f"Preview host {wall_global_id} is not a supported IFC wall.")

    source_void_relations = [
        relation for relation in preview_model.by_type("IfcRelVoidsElement")
        if relation.RelatingBuildingElement == preview_wall
    ]

    keep_product_ids = {preview_wall.id()}
    for void_relation in source_void_relations:
        opening = void_relation.RelatedOpeningElement
        if opening is None:
            continue
        keep_product_ids.add(opening.id())
        for fill_relation in preview_model.by_type("IfcRelFillsElement"):
            if fill_relation.RelatingOpeningElement == opening and fill_relation.RelatedBuildingElement:
                # Keep semantic IfcWindow / IfcDoor fillings for the hosted
                # openings. The visible catalogue GLB remains a separate editor
                # asset, so the semantic filling intentionally has no geometry.
                keep_product_ids.add(fill_relation.RelatedBuildingElement.id())

    # Spatial containers are needed because an element's ObjectPlacement may
    # be relative to its storey/building placement. Keep their hierarchy but
    # strip their optional shape representations so the preview remains visually
    # limited to the selected wall and its cumulative openings.
    products = list(preview_model.by_type("IfcProduct"))
    for product in products:
        if product.id() in keep_product_ids:
            continue

        if product.is_a("IfcSpatialStructureElement"):
            if getattr(product, "Representation", None) is not None:
                product.Representation = None
            continue

        # Use the official cleanup API so containment, aggregation, material,
        # type, property and representation relationships are removed safely.
        ifcopenshell.api.root.remove_product(preview_model, product=product)

    # Guard the exact relationships that the preview is meant to display.
    remaining_wall = editor.find_element(preview_model, wall_global_id)
    remaining_void_count = sum(
        1 for relation in preview_model.by_type("IfcRelVoidsElement")
        if relation.RelatingBuildingElement == remaining_wall
    )
    if remaining_void_count != len(source_void_relations):
        raise RuntimeError(
            "Wall preview pruning changed the number of hosted openings "
            f"({len(source_void_relations)} expected, {remaining_void_count} retained)."
        )

    preview_model.write(output_path)
    return output_path


def _read_specs(specs_path):
    payload = json.loads(Path(specs_path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Opening specs must be a JSON object.")
    doors = payload.get("doors", [])
    windows = payload.get("windows", [])
    if not isinstance(doors, list) or not isinstance(windows, list):
        raise ValueError("Opening specs 'doors' and 'windows' must be arrays.")
    return doors, windows, payload.get("previewWallGlobalId")


def cmd_apply_hosted_wall_openings(args):
    source = ifcopenshell.open(args.input)
    door_specs, window_specs, payload_preview_wall_id = _read_specs(args.opening_specs)
    results = {"success": True, "doors": [], "windows": []}

    for index, spec in enumerate(door_specs, start=1):
        if not isinstance(spec, dict):
            raise ValueError(f"Door spec {index} must be an object.")
        wall_global_id = spec.get("wallGlobalId") or spec.get("hostWallId")
        if not wall_global_id:
            raise ValueError(f"Door spec {index} is missing wallGlobalId.")
        wall = editor.find_element(source, str(wall_global_id))
        if not _is_supported_wall(wall):
            raise ValueError(f"Door host {wall_global_id} is not a supported IFC wall.")
        result = editor._create_hosted_door_opening(
            source,
            wall,
            spec.get("assetId") or spec.get("id") or f"hosted-door-{index}",
            spec.get("position"),
            (spec.get("dimensions") or {}).get("width"),
            (spec.get("dimensions") or {}).get("height"),
            (spec.get("dimensions") or {}).get("thickness"),
        )
        result["instanceId"] = str(spec.get("instanceId") or result.get("assetId"))
        results["doors"].append(result)

    for index, spec in enumerate(window_specs, start=1):
        if not isinstance(spec, dict):
            raise ValueError(f"Window spec {index} must be an object.")
        wall_global_id = spec.get("wallGlobalId") or spec.get("hostWallId")
        if not wall_global_id:
            raise ValueError(f"Window spec {index} is missing wallGlobalId.")
        wall = editor.find_element(source, str(wall_global_id))
        results["windows"].append(_create_hosted_window_opening(source, wall, spec))

    source.write(args.output)

    preview_wall_id = args.preview_wall_id or payload_preview_wall_id
    preview_path = args.preview_output
    if preview_wall_id and preview_path:
        preview_wall = editor.find_element(source, str(preview_wall_id))
        if not _is_supported_wall(preview_wall):
            raise ValueError(f"Preview host {preview_wall_id} is not a supported IFC wall.")
        # Re-open the successfully written edited IFC as the preview model.
        # Do not copy entities into a newly-created file: cross-file file.add()
        # can fail on schema addenda or invalid nested project references.
        preview_model = ifcopenshell.open(args.output)
        preview_wall = editor.find_element(preview_model, str(preview_wall_id))
        _write_isolated_wall_preview_with_fillings(preview_model, preview_wall, preview_path)
        results["previewFileName"] = Path(preview_path).name
        logger.info("Wrote cumulative wall preview with %s opening(s).", len([
            relation for relation in preview_model.by_type("IfcRelVoidsElement")
            if relation.RelatingBuildingElement == preview_wall
        ]))

    results["inputPath"] = args.input
    results["outputPath"] = args.output
    print(json.dumps(results))


def main():
    parser = argparse.ArgumentParser(description="Independent IFC hosted-window opening engine")
    parser.add_argument("mode", choices=["apply-hosted-wall-openings"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--opening-specs", required=True)
    parser.add_argument("--preview-wall-id")
    parser.add_argument("--preview-output")
    args = parser.parse_args()
    try:
        cmd_apply_hosted_wall_openings(args)
    except Exception as exc:
        logger.exception("Hosted wall opening operation failed")
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
