#!/usr/bin/env python3
"""
Pure-AI floor-plan -> IFC compiler.

Design goals:
- Gemini is the only source for what exists in the floor plan.
- No legacy furniture/wall/door/window IFC assets are consulted.
- IFC geometry is generated parametrically from Gemini's coordinates,
  dimensions and rotations.
- Wall openings are represented as real gaps in the wall geometry and as
  IFC IfcOpeningElement / IfcDoor / IfcWindow relationships.
- Interior objects are generated with type-aware procedural geometry.
- The file remains compatible with the existing backend CLI contract,
  including --assets (accepted but intentionally ignored).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import ifcopenshell
import ifcopenshell.guid
from google import genai
from google.genai import types
from google.genai.errors import APIError, ClientError, ServerError
from pydantic import BaseModel, Field, field_validator

PIPELINE_VERSION = 6
MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")


# ============================================================================
# 1. AI DATA MODEL
# ============================================================================


def _as_property_rows(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        return []
    rows = []
    for key, val in value.items():
        rows.append({
            "name": str(key),
            "value": str(val).lower() if isinstance(val, bool) else str(val),
            "pset": None,
        })
    return rows


class ElementProperty(BaseModel):
    name: str
    value: str
    pset: Optional[str] = None


class OpeningComponent(BaseModel):
    id: str
    type: str = Field(description="door or window")
    location_pt: List[float] = Field(description="[x,y] center point on host wall")
    width: float = 0.9
    height: float = 2.1
    parent_wall_id: str
    position_on_wall: Optional[float] = Field(default=None, description="Normalized 0..1 position of opening center along the host wall from wall start to wall end")
    sill_height: Optional[float] = Field(default=None, description="Window sill height above finished floor in metres")
    operation_type: Optional[str] = None
    material: Optional[str] = None
    color: Optional[List[float]] = None
    properties: List[ElementProperty] = Field(default_factory=list)
    unit: str = "m"

    @field_validator("properties", mode="before")
    @classmethod
    def normalize_properties(cls, value):
        return _as_property_rows(value)


class RoomData(BaseModel):
    room_id: str
    name: str
    polygon: List[List[float]] = Field(default_factory=list, description="Closed or open 2D room boundary polygon in the same metric plan coordinate system")
    boundary_wall_ids: List[str] = Field(default_factory=list)
    confidence: Optional[float] = None
    unit: str = "m"


class InteriorComponent(BaseModel):
    id: str
    category: str = Field(description="furnishing, sanitary, or appliance")
    type: Optional[str] = None
    location_pt: List[float] = Field(description="[x,y] center of footprint")
    dimensions: List[float] = Field(default=[0.8, 0.8, 0.5], description="[width, depth, height]")
    rotation: float = 0.0
    material: Optional[str] = None
    color: Optional[List[float]] = None
    properties: List[ElementProperty] = Field(default_factory=list)
    unit: str = "m"
    room_hint: Optional[str] = None
    room_id: Optional[str] = None
    confidence: Optional[float] = None
    shape_hint: Optional[str] = None
    anchor_hint: Optional[str] = None
    anchor_wall_id: Optional[str] = None

    @field_validator("properties", mode="before")
    @classmethod
    def normalize_properties(cls, value):
        return _as_property_rows(value)


class WallData(BaseModel):
    wall_id: str
    start_pt: List[float]
    end_pt: List[float]
    thickness: float = 0.23
    height: float = 3.0
    unit: str = "m"


class SlabData(BaseModel):
    slab_id: str = "floor_slab_01"
    slab_type: str = "FLOOR"
    thickness: float = 0.15
    elevation: float = -0.15
    outline_pts: List[List[float]] = Field(default_factory=list)
    material: str = "RCC"
    finish: str = "Smooth"
    unit: str = "m"


class BuildingAnalysis(BaseModel):
    building_name: str = "AI Floor Plan"
    walls: List[WallData]
    openings: List[OpeningComponent] = Field(default_factory=list)
    rooms: List[RoomData] = Field(default_factory=list)
    interiors: List[InteriorComponent] = Field(default_factory=list)
    slabs: List[SlabData] = Field(default_factory=list)


# ============================================================================
# 2. NORMALIZATION / BASIC IFC HELPERS
# ============================================================================


def normalize_key(value: object) -> str:
    if value is None:
        return ""
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(value).strip())
    return re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()


def to_m(value: float, unit: str) -> float:
    unit = (unit or "m").strip().lower()
    if unit in {"m", "meter", "meters", "metre", "metres"}:
        return float(value)
    if unit == "mm":
        return float(value) / 1000.0
    if unit == "cm":
        return float(value) / 100.0
    if unit in {"in", "inch", "inches"}:
        return float(value) * 0.0254
    if unit in {"ft", "foot", "feet"}:
        return float(value) * 0.3048
    return float(value)


def clean_positive(value: float, default: float, minimum: float = 0.01) -> float:
    try:
        v = float(value)
    except Exception:
        return default
    if not math.isfinite(v) or v <= 0:
        return default
    return max(v, minimum)


def clamp_color(rgb: Optional[Sequence[float]], fallback=(0.72, 0.72, 0.72)) -> Tuple[float, float, float]:
    if not rgb or len(rgb) < 3:
        return tuple(float(x) for x in fallback)
    return tuple(max(0.0, min(1.0, float(x))) for x in rgb[:3])


def make_point(model, xyz: Sequence[float]):
    return model.create_entity("IfcCartesianPoint", Coordinates=tuple(float(x) for x in xyz))


def make_axis3(model, x: float, y: float, z: float = 0.0, angle_deg: float = 0.0):
    location = make_point(model, (x, y, z))
    direction = model.create_entity(
        "IfcDirection",
        DirectionRatios=(math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg)), 0.0),
    )
    return model.create_entity("IfcAxis2Placement3D", Location=location, RefDirection=direction)


def make_local_placement(model, parent, x: float, y: float, z: float = 0.0, angle_deg: float = 0.0):
    return model.create_entity(
        "IfcLocalPlacement",
        PlacementRelTo=parent,
        RelativePlacement=make_axis3(model, x, y, z, angle_deg),
    )


def create_rect_profile(model, width: float, depth: float, cx: float = 0.0, cy: float = 0.0):
    hw, hd = width / 2.0, depth / 2.0
    pts = [
        make_point(model, (cx - hw, cy - hd, 0.0)),
        make_point(model, (cx + hw, cy - hd, 0.0)),
        make_point(model, (cx + hw, cy + hd, 0.0)),
        make_point(model, (cx - hw, cy + hd, 0.0)),
        make_point(model, (cx - hw, cy - hd, 0.0)),
    ]
    polyline = model.create_entity("IfcPolyline", Points=pts)
    return model.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=polyline)


def create_box_solid(model, width: float, depth: float, height: float,
                     x: float = 0.0, y: float = 0.0, z: float = 0.0):
    profile = create_rect_profile(model, width, depth, x, y)
    position = make_axis3(model, 0.0, 0.0, z)
    return model.create_entity(
        "IfcExtrudedAreaSolid",
        SweptArea=profile,
        Position=position,
        ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=height,
    )


def create_cylinder_solid(model, radius: float, height: float,
                          x: float = 0.0, y: float = 0.0, z: float = 0.0):
    circle = model.create_entity(
        "IfcCircleProfileDef",
        ProfileType="AREA",
        Radius=radius,
        Position=model.create_entity("IfcAxis2Placement2D", Location=make_point(model, (x, y, 0.0))),
    )
    position = make_axis3(model, 0.0, 0.0, z)
    return model.create_entity(
        "IfcExtrudedAreaSolid",
        SweptArea=circle,
        Position=position,
        ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=height,
    )


def make_shape_rep(model, context, solids: List[object]):
    return model.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=context,
        RepresentationIdentifier="Body",
        RepresentationType="SweptSolid",
        Items=solids,
    )


def attach_representation(model, element, context, solids: List[object]):
    element.Representation = model.create_entity(
        "IfcProductDefinitionShape",
        Representations=[make_shape_rep(model, context, solids)],
    )


def create_material(model, cache: Dict[str, object], name: str):
    key = normalize_key(name) or "default"
    if key not in cache:
        cache[key] = model.create_entity("IfcMaterial", Name=str(name or "Default"))
    return cache[key]


def assign_material(model, owner_history, element, material_cache, name: str):
    material = create_material(model, material_cache, name)
    model.create_entity(
        "IfcRelAssociatesMaterial",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatedObjects=[element],
        RelatingMaterial=material,
    )


def add_property_set(model, owner_history, element, pset_name: str, values: Dict[str, object]):
    props = []
    for name, value in values.items():
        if value is None:
            continue
        if isinstance(value, bool):
            nominal = model.create_entity("IfcBoolean", value)
        elif isinstance(value, int) and not isinstance(value, bool):
            nominal = model.create_entity("IfcInteger", value)
        elif isinstance(value, float):
            nominal = model.create_entity("IfcReal", value)
        else:
            nominal = model.create_entity("IfcLabel", str(value))
        props.append(model.create_entity("IfcPropertySingleValue", Name=str(name), NominalValue=nominal))
    if not props:
        return
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        Name=pset_name,
        HasProperties=props,
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatedObjects=[element],
        RelatingPropertyDefinition=pset,
    )


def add_quantity_set(model, owner_history, element, values: Dict[str, float]):
    quantities = []
    for name, value in values.items():
        quantities.append(
            model.create_entity(
                "IfcQuantityLength",
                Name=name,
                LengthValue=float(value),
            )
        )
    if not quantities:
        return
    qset = model.create_entity(
        "IfcElementQuantity",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        Name="BaseQuantities",
        Quantities=quantities,
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatedObjects=[element],
        RelatingPropertyDefinition=qset,
    )


def style_solid(model, solid, color: Tuple[float, float, float], style_name: str):
    rgb = model.create_entity("IfcColourRgb", Name=style_name, Red=color[0], Green=color[1], Blue=color[2])
    rendering = model.create_entity("IfcSurfaceStyleRendering", SurfaceColour=rgb, Transparency=0.0)
    style = model.create_entity("IfcSurfaceStyle", Name=style_name, Side="BOTH", Styles=[rendering])
    model.create_entity("IfcStyledItem", Item=solid, Styles=[style])


def _normalize_polygon(points, unit):
    out = []
    for p in points or []:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            out.append([to_m(p[0], unit), to_m(p[1], unit)])
    return out


def _xy_distance_to_segment(point, a, b):
    t = project_to_wall(a, b, point)
    px = a[0] + (b[0] - a[0]) * t
    py = a[1] + (b[1] - a[1]) * t
    return math.hypot(point[0] - px, point[1] - py), t, (px, py)


def _wall_group(wall_id: str) -> str:
    key = normalize_key(wall_id)
    if key.startswith("wall_ext"):
        return "ext"
    if key.startswith("wall_int"):
        return "int"
    return "other"


def _segments_overlap_collinear(a, b, c, d, angle_tol_deg=2.0, distance_tol=0.06):
    ux, uy, length = wall_direction(a, b)
    if length <= 1e-6:
        return False, 0.0
    vx, vy, length2 = wall_direction(c, d)
    if length2 <= 1e-6:
        return False, 0.0
    dot = ux * vx + uy * vy
    if abs(abs(dot) - 1.0) > math.sin(math.radians(angle_tol_deg)):
        return False, 0.0

    # perpendicular distance from c,d to the first line
    dc = abs((c[0] - a[0]) * uy - (c[1] - a[1]) * ux)
    dd = abs((d[0] - a[0]) * uy - (d[1] - a[1]) * ux)
    if max(dc, dd) > distance_tol:
        return False, 0.0

    tc = (c[0] - a[0]) * ux + (c[1] - a[1]) * uy
    td = (d[0] - a[0]) * ux + (d[1] - a[1]) * uy
    lo = max(0.0, min(tc, td))
    hi = min(length, max(tc, td))
    overlap = max(0.0, hi - lo)
    return overlap > 0.02, overlap / max(min(length, length2), 1e-6)


def _polygon_bbox(poly):
    if not poly:
        return None
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def _polygon_centroid(poly):
    if not poly:
        return (0.0, 0.0)
    if len(poly) < 3:
        return (
            sum(p[0] for p in poly) / len(poly),
            sum(p[1] for p in poly) / len(poly),
        )
    area2 = 0.0
    cx = 0.0
    cy = 0.0
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        cross = p[0] * q[1] - q[0] * p[1]
        area2 += cross
        cx += (p[0] + q[0]) * cross
        cy += (p[1] + q[1]) * cross
    if abs(area2) < 1e-9:
        return (
            sum(p[0] for p in poly) / len(poly),
            sum(p[1] for p in poly) / len(poly),
        )
    return cx / (3.0 * area2), cy / (3.0 * area2)


def _point_in_polygon(point, poly):
    if len(poly) < 3:
        return False
    x, y = point
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        intersects = ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def _rect_corners(cx, cy, w, d, rotation_deg):
    r = math.radians(rotation_deg)
    c, s = math.cos(r), math.sin(r)
    hw, hd = w / 2.0, d / 2.0
    local = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
    return [
        (cx + x * c - y * s, cy + x * s + y * c)
        for x, y in local
    ]


def _footprint_inside_room(cx, cy, w, d, rotation_deg, poly, margin=0.03):
    if not poly:
        return True
    pts = _rect_corners(cx, cy, w + margin * 2, d + margin * 2, rotation_deg)
    return all(_point_in_polygon(p, poly) for p in pts)


def _effective_xy(w, d, rotation_deg):
    snapped = (round(rotation_deg / 90.0) * 90.0) % 360.0
    if abs((rotation_deg - snapped) % 180.0) < 1e-6:
        if snapped in (90.0, 270.0):
            return d, w
    return w, d


def _oriented_rect_overlap(a, b, clearance=0.03):
    def axes(points):
        out = []
        for i in range(4):
            p = points[i]
            q = points[(i + 1) % 4]
            dx = q[0] - p[0]
            dy = q[1] - p[1]
            length = math.hypot(dx, dy) or 1.0
            out.append((-dy / length, dx / length))
        return out[:2]

    def project(poly, axis):
        values = [p[0] * axis[0] + p[1] * axis[1] for p in poly]
        return min(values), max(values)

    pa = _rect_corners(*a)
    pb = _rect_corners(*b)
    for axis in axes(pa) + axes(pb):
        amin, amax = project(pa, axis)
        bmin, bmax = project(pb, axis)
        if amax + clearance <= bmin or bmax + clearance <= amin:
            return False
    return True


def _nearest_room_wall(item, room, walls_by_id):
    candidate_ids = [x for x in room.boundary_wall_ids if x in walls_by_id]
    if not candidate_ids:
        candidate_ids = list(walls_by_id.keys())
    best = None
    for wid in candidate_ids:
        wall = walls_by_id[wid]
        dist, t, point = _xy_distance_to_segment(item.location_pt, wall.start_pt, wall.end_pt)
        if best is None or dist < best[0]:
            best = (dist, wid, wall, t, point)
    return best


_WALL_HUGGING_TYPES = {
    "wardrobe", "almirah", "closet", "cabinet", "kitchen_cabinet",
    "tv_unit", "shelf", "bookshelf", "open_bookshelf", "sideboard",
    "shoe_rack", "dresser", "dressing_table", "filecabinet", "bedside_table",
}


def _align_wall_hugging_item(item, room, walls_by_id):
    best = _nearest_room_wall(item, room, walls_by_id)
    if not best or best[0] > 1.10:
        return
    wall = best[2]
    angle = math.degrees(math.atan2(
        wall.end_pt[1] - wall.start_pt[1],
        wall.end_pt[0] - wall.start_pt[0],
    ))
    # Preserve Gemini's center point. Only fix orientation/semantic anchoring.
    if item.dimensions[1] > item.dimensions[0]:
        item.rotation = (angle - 90.0) % 360.0
    else:
        item.rotation = angle % 360.0
    item.anchor_hint = item.anchor_hint or "WALL"
    item.anchor_wall_id = item.anchor_wall_id or best[1]




def _choose_linear_orientation(item, room, walls_by_id):
    """Correct long-axis orientation for elongated linear furniture using geometry."""
    key = normalize_key(item.type)
    linear_types = _WALL_HUGGING_TYPES | {"desk", "study_desk"}
    ratio = max(item.dimensions[0], item.dimensions[1]) / max(min(item.dimensions[0], item.dimensions[1]), 0.05)
    if key not in linear_types or ratio < 2.2 or not room:
        return

    best = _nearest_room_wall(item, room, walls_by_id)
    if best and best[0] <= 1.10:
        wall = best[2]
        angle = math.degrees(math.atan2(
            wall.end_pt[1] - wall.start_pt[1],
            wall.end_pt[0] - wall.start_pt[0],
        ))
        item.rotation = (angle - 90.0) % 360.0 if item.dimensions[1] > item.dimensions[0] else angle % 360.0
        item.anchor_wall_id = item.anchor_wall_id or best[1]
        return

    bbox = _polygon_bbox(room.polygon)
    if not bbox:
        return
    rw, rd = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if abs(rw - rd) < 0.5:
        return
    long_is_depth = item.dimensions[1] >= item.dimensions[0]
    if long_is_depth:
        item.rotation = 0.0 if rd >= rw else 90.0
    else:
        item.rotation = 0.0 if rw >= rd else 90.0


def _infer_orientation_from_companions(item, all_items):
    """Use nearby related objects as weak orientation evidence; never move centers."""
    key = normalize_key(item.type)
    if key not in {"desk", "study_desk", "bed", "table", "dining_table"}:
        return
    w, d, _h = item.dimensions
    if max(w, d) / max(min(w, d), 0.05) < 2.0:
        return

    related_types = {
        "bed": {"chair", "cabinet"},
        "desk": {"chair"},
        "study_desk": {"chair"},
        "table": {"chair"},
        "dining_table": {"chair"},
    }.get(key, {"chair"})
    candidates = []
    for other in all_items:
        if other is item:
            continue
        if item.room_id and other.room_id and item.room_id != other.room_id:
            continue
        other_key = normalize_key(other.type)
        ident = normalize_key(other.id or "")
        related = other_key in related_types or (
            key == "bed" and ("nightstand" in ident or "bedside" in ident)
        )
        if not related:
            continue
        dx = other.location_pt[0] - item.location_pt[0]
        dy = other.location_pt[1] - item.location_pt[1]
        if math.hypot(dx, dy) <= max(w, d) * 1.9 + 1.0:
            candidates.append((dx, dy))
    if len(candidates) < 2:
        return
    spread_x = sum(abs(dx) for dx, _ in candidates) / len(candidates)
    spread_y = sum(abs(dy) for _, dy in candidates) / len(candidates)
    if spread_y > spread_x * 1.10:
        item.rotation = 0.0 if d >= w else 90.0
    elif spread_x > spread_y * 1.10:
        item.rotation = 90.0 if d >= w else 0.0


def _mark_semantic_anchors(data: BuildingAnalysis):
    for item in data.interiors:
        ident = normalize_key(item.id or "")
        typ = normalize_key(item.type)
        if "nightstand" in ident or "bedside" in ident:
            item.anchor_hint = "OBJECT"
            item.anchor_wall_id = None
        elif typ in _WALL_HUGGING_TYPES and not item.anchor_hint:
            item.anchor_hint = "EDGE"


def _room_for_item(item, rooms_by_id):
    if item.room_id and item.room_id in rooms_by_id:
        return rooms_by_id[item.room_id]
    # No semantic room: leave coordinate unchanged rather than inventing one.
    return None


def _fit_item_to_room(item, room):
    if not room or not room.polygon:
        return
    bbox = _polygon_bbox(room.polygon)
    if not bbox:
        return
    room_w = bbox[2] - bbox[0]
    room_d = bbox[3] - bbox[1]
    if room_w <= 0.1 or room_d <= 0.1:
        return

    # The room polygon is guidance, not a hard clipping mask. The source can
    # show fixtures extending into open/circulation areas or simplified room
    # polygons. We therefore resize obviously oversized footprints, but NEVER
    # relocate an AI point merely because a simplified polygon is too small.
    max_fx = room_w * 0.86
    max_fy = room_d * 0.86
    ew, ed = _effective_xy(item.dimensions[0], item.dimensions[1], item.rotation)
    scale = 1.0
    if ew > max_fx:
        scale = min(scale, max_fx / ew)
    if ed > max_fy:
        scale = min(scale, max_fy / ed)
    if scale < 0.999:
        item.dimensions[0] *= scale
        item.dimensions[1] *= scale
        print(f"[AI-FIT] {item.id}: footprint scaled {scale:.2f} for room proportion")

    key = normalize_key(item.type)
    height_caps = {
        "wardrobe": 2.35, "cabinet": 2.35, "kitchen_cabinet": 2.35,
        "shelf": 2.35, "bookshelf": 2.35,
        "desk": 0.90, "table": 0.95, "dining_table": 0.95,
        "round_table": 0.95, "oval_table": 0.95,
        "chair": 1.10, "sofa": 1.05, "l_shape_sofa": 1.05,
        "bed": 0.75, "bathtub": 0.75, "wc": 0.90, "washbasin": 1.10,
    }
    cap = height_caps.get(key)
    if cap:
        item.dimensions[2] = min(item.dimensions[2], cap)



def _separate_room_objects(items, room):
    # Do not move source objects automatically. Furniture relationships in a
    # floor plan (chair+desk, nightstand+bed, sink+counter) can look like
    # overlaps in bounding boxes. Report significant overlaps for diagnostics.
    if not room or len(items) < 2:
        return
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if _oriented_rect_overlap(
                (*a.location_pt, a.dimensions[0], a.dimensions[1], a.rotation),
                (*b.location_pt, b.dimensions[0], b.dimensions[1], b.rotation),
                clearance=0.03,
            ):
                print(f"[AI-SPACING-WARN] {a.id} overlaps {b.id}; preserving AI coordinates.")


def _dedupe_walls_and_rehost(data: BuildingAnalysis):
    if not data.walls:
        return
    survivors = []
    alias = {}
    for wall in data.walls:
        merged_into = None
        for kept in survivors:
            if _wall_group(wall.wall_id) != _wall_group(kept.wall_id):
                continue
            overlaps, ratio = _segments_overlap_collinear(
                wall.start_pt, wall.end_pt, kept.start_pt, kept.end_pt
            )
            if overlaps and ratio >= 0.80:
                kept_len = distance_2d(kept.start_pt, kept.end_pt)
                wall_len = distance_2d(wall.start_pt, wall.end_pt)
                if wall_len > kept_len:
                    alias[kept.wall_id] = wall.wall_id
                    survivors.remove(kept)
                    survivors.append(wall)
                    merged_into = wall
                else:
                    alias[wall.wall_id] = kept.wall_id
                    merged_into = kept
                break
        if merged_into is None:
            survivors.append(wall)
    if alias:
        print(f"[AI-GRAPH] Removed {len(alias)} overlapping/duplicate wall segment(s): {alias}")
        for op in data.openings:
            if op.parent_wall_id in alias:
                op.parent_wall_id = alias[op.parent_wall_id]
        for room in data.rooms:
            room.boundary_wall_ids = [alias.get(wid, wid) for wid in room.boundary_wall_ids]
    data.walls = survivors


def _derive_exterior_outline(walls):
    ext = [w for w in walls if _wall_group(w.wall_id) == "ext"]
    if len(ext) < 3:
        return []
    unused = set(range(len(ext)))
    first = 0
    current_end = ext[first].end_pt
    outline = [ext[first].start_pt, ext[first].end_pt]
    unused.remove(first)
    for _ in range(len(ext) + 2):
        if not unused:
            break
        match = None
        best_d = 0.10
        for idx in unused:
            w = ext[idx]
            for reverse in (False, True):
                s, e = (w.start_pt, w.end_pt) if not reverse else (w.end_pt, w.start_pt)
                d = math.hypot(s[0] - current_end[0], s[1] - current_end[1])
                if d < best_d:
                    match = (idx, reverse, e)
                    best_d = d
        if match is None:
            break
        idx, reverse, new_end = match
        unused.remove(idx)
        outline.append(new_end)
        current_end = new_end
        if math.hypot(current_end[0] - outline[0][0], current_end[1] - outline[0][1]) < 0.10:
            break
    if len(outline) >= 4:
        if math.hypot(outline[-1][0] - outline[0][0], outline[-1][1] - outline[0][1]) < 0.10:
            outline[-1] = outline[0]
        return outline
    return []


def _spatial_reasoning_cleanup(data: BuildingAnalysis):
    _dedupe_walls_and_rehost(data)
    rooms_by_id = {r.room_id: r for r in data.rooms}
    walls_by_id = {w.wall_id: w for w in data.walls}

    _mark_semantic_anchors(data)

    # Derive the floor plate from the actual exterior wall graph. This preserves
    # notches/angled foyer geometry instead of using a bounding rectangle.
    derived_outline = _derive_exterior_outline(data.walls)
    if derived_outline:
        if not data.slabs:
            data.slabs = [SlabData(outline_pts=derived_outline)]
        else:
            data.slabs[0].outline_pts = derived_outline
        if data.slabs[0].slab_type == "FLOOR" and data.slabs[0].elevation >= 0.0:
            data.slabs[0].elevation = -0.05
        print(
            f"[AI-GRAPH] Derived slab outline from "
            f"{len([w for w in data.walls if _wall_group(w.wall_id) == 'ext'])} exterior wall segments."
        )

    # Apply only high-confidence orientation and dimension corrections.
    for item in data.interiors:
        room = _room_for_item(item, rooms_by_id)
        if room:
            key = normalize_key(item.type)
            if key in _WALL_HUGGING_TYPES and item.anchor_hint != "OBJECT":
                _align_wall_hugging_item(item, room, walls_by_id)
            _choose_linear_orientation(item, room, walls_by_id)
            _infer_orientation_from_companions(item, data.interiors)
            _fit_item_to_room(item, room)

    for room_id, room in rooms_by_id.items():
        _separate_room_objects(
            [x for x in data.interiors if x.room_id == room_id],
            room,
        )

    # Re-host/snap openings after duplicate-wall cleanup and constrain only the
    # physically valid part of the opening dimensions.
    walls_by_id = {w.wall_id: w for w in data.walls}
    for op in data.openings:
        wall = walls_by_id.get(op.parent_wall_id)
        if wall is None:
            continue
        t = op.position_on_wall if op.position_on_wall is not None else project_to_wall(
            wall.start_pt, wall.end_pt, op.location_pt
        )
        t = max(0.03, min(0.97, float(t)))
        op.position_on_wall = t
        op.location_pt = [
            wall.start_pt[0] + (wall.end_pt[0] - wall.start_pt[0]) * t,
            wall.start_pt[1] + (wall.end_pt[1] - wall.start_pt[1]) * t,
        ]
        wall_len = distance_2d(wall.start_pt, wall.end_pt)
        if normalize_key(op.type) == "window":
            op.sill_height = 0.9 if op.sill_height is None else max(0.3, float(op.sill_height))
            max_h = max(0.8, min(wall.height - op.sill_height - 0.08, wall.height * 0.60))
            op.height = min(op.height, max_h)
            op.width = min(max(op.width, 0.45), wall_len * 0.72)
        else:
            op.height = min(max(op.height, 1.90), max(1.90, wall.height - 0.05))
            op.width = min(max(op.width, 0.70), min(1.20, wall_len * 0.70))

    for item in data.interiors:
        item.dimensions = [max(0.05, float(v)) for v in item.dimensions]
        item.rotation = float(item.rotation or 0.0) % 360.0


def normalize_analysis(data: BuildingAnalysis) -> BuildingAnalysis:
    """Normalize units, repair graph topology, and apply deterministic spatial reasoning."""
    seen = set()
    for idx, wall in enumerate(data.walls, 1):
        wall.wall_id = (wall.wall_id or f"W{idx:03d}").strip()
        if wall.wall_id in seen:
            wall.wall_id = f"W{idx:03d}"
        seen.add(wall.wall_id)
        wall.start_pt = [to_m(v, wall.unit) for v in wall.start_pt[:2]]
        wall.end_pt = [to_m(v, wall.unit) for v in wall.end_pt[:2]]
        wall.thickness = clean_positive(to_m(wall.thickness, wall.unit), 0.15, 0.05)
        wall.height = clean_positive(to_m(wall.height, wall.unit), 2.8, 1.5)
        wall.unit = "m"

    wall_ids = {w.wall_id for w in data.walls}
    valid_openings = []
    for op in data.openings:
        op.location_pt = [to_m(v, op.unit) for v in op.location_pt[:2]]
        op.width = clean_positive(to_m(op.width, op.unit), 0.9, 0.3)
        op.height = clean_positive(to_m(op.height, op.unit), 2.1, 0.5)
        op.sill_height = None if op.sill_height is None else max(0.0, to_m(op.sill_height, op.unit))
        if op.position_on_wall is not None:
            try:
                op.position_on_wall = max(0.0, min(1.0, float(op.position_on_wall)))
            except Exception:
                op.position_on_wall = None
        op.unit = "m"
        op.type = normalize_key(op.type) or "door"
        if op.parent_wall_id not in wall_ids:
            print(f"[Opening-WARN] {op.id}: host wall '{op.parent_wall_id}' does not exist in AI wall graph; attempting nearest-wall repair.")
        valid_openings.append(op)
    data.openings = valid_openings

    room_ids = set()
    for idx, room in enumerate(data.rooms, 1):
        room.room_id = (room.room_id or f"ROOM_{idx:03d}").strip()
        if room.room_id in room_ids:
            room.room_id = f"ROOM_{idx:03d}"
        room_ids.add(room.room_id)
        room.polygon = _normalize_polygon(room.polygon, room.unit)
        room.unit = "m"

    for slab in data.slabs:
        slab.thickness = clean_positive(to_m(slab.thickness, slab.unit), 0.15, 0.05)
        slab.elevation = float(to_m(slab.elevation, slab.unit))
        slab.outline_pts = _normalize_polygon(slab.outline_pts, slab.unit)
        slab.unit = "m"

    # Normalize details before spatial reasoning.
    for item in data.interiors:
        item.location_pt = [to_m(v, item.unit) for v in item.location_pt[:2]]
        dims = list(item.dimensions or [])[:3]
        while len(dims) < 3:
            dims.append(0.8 if len(dims) < 2 else 0.5)
        item.dimensions = [clean_positive(to_m(v, item.unit), 0.8, 0.05) for v in dims]
        item.rotation = float(item.rotation or 0.0) % 360.0
        item.unit = "m"
        item.type = (item.type or "GENERIC_FURNITURE").strip()
        item.category = normalize_key(item.category) or "furnishing"
        if item.room_id and item.room_id not in room_ids:
            item.room_id = None
        item.shape_hint = (item.shape_hint or "").strip() or None
        item.anchor_hint = (item.anchor_hint or "").strip().upper() or None
        item.anchor_wall_id = (item.anchor_wall_id or "").strip() or None

    _spatial_reasoning_cleanup(data)

    # Restore valid room boundary ids after wall dedupe.
    wall_ids = {w.wall_id for w in data.walls}
    for room in data.rooms:
        room.boundary_wall_ids = [wid for wid in room.boundary_wall_ids if wid in wall_ids]

    return data


# ============================================================================
# 3. GEMINI EXTRACTION
# ============================================================================


def _image_part(image_path: str):
    ext = os.path.splitext(image_path)[1].lower()
    mime_type = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(ext, "application/octet-stream")
    with open(image_path, "rb") as f:
        return types.Part.from_bytes(data=f.read(), mime_type=mime_type)


def build_architecture_prompt() -> str:
    return r"""
You are the ARCHITECTURAL GRAPH pass of a professional AI floor-plan reconstruction system.
The supplied floor-plan image is the ONLY source of truth. Reconstruct the drawing that is visibly present;
do not invent a generic apartment and do not redesign the layout.

PRIMARY GOAL
Create a topologically correct 2D building graph that can be extruded into BIM with minimal correction.
The graph must preserve the actual footprint, room proportions, openings, and circulation.

GLOBAL SCALE
- Establish ONE global metric scale for the entire image.
- Infer scale from the clearest human-scale door/window/furniture proportions and the overall building footprint.
- Never choose a separate scale independently for each room.
- Keep coordinates internally consistent across walls, openings, rooms, slab, and details.

WALL GRAPH — HIGHEST PRIORITY
1. Trace the complete exterior perimeter exactly as drawn, including every notch, step, projection, foyer/entry shape,
   balcony return and angled segment.
2. Trace every true interior partition that forms a room boundary.
3. Use CENTERLINE coordinates for every wall.
4. A single physical wall run should be represented once. If a wall contains a door/window, keep it as one continuous wall.
5. Split a wall only at an actual architectural corner or direction change, not merely because an opening symbol exists.
6. NEVER emit overlapping/duplicate collinear walls. If two detected wall segments represent the same physical wall,
   merge them into one longer segment.
7. Do not turn cabinet fronts, beds, desks, rugs, dimension lines, decorative outlines, shadows, hatch patterns,
   door swings, or text into walls.
8. Exterior walls may be thicker than interior walls only when supported visually.
9. Preserve angled walls when the source actually contains them. Do not orthogonalize a visibly angled segment.

OPENINGS
10. Detect every visible door and window.
11. Every opening MUST reference the physical wall segment that contains it.
12. location_pt is the CENTER of the opening projected onto the host wall centerline.
13. position_on_wall is the normalized 0..1 position of that center measured from wall.start_pt.
14. Opening width is measured ALONG the host wall, and the opening must remain clear of both wall ends.
15. A doorway at a foyer/entry notch must be hosted by the actual wall segment containing the door.
16. Door swing arcs are orientation evidence only.
17. For windows, provide sill_height only when visually supported.
18. Do not place an opening in the middle of a room just because a door symbol is nearby.

ROOMS
19. Identify the major spaces actually present in the plan.
20. Distinguish enclosed rooms from open-plan zones. An open-plan zone may be a semantic room without inventing walls.
21. Room polygons must follow the usable interior boundary created by the wall graph.
22. Room polygons must not overlap substantially except where the source explicitly depicts an open-plan shared zone.
23. boundary_wall_ids must reference real walls and should describe the room perimeter.

FLOOR / SLAB
24. Trace the actual floor footprint from the exterior wall graph, including non-rectangular projections and recesses.
25. Do not replace an irregular footprint with a simple bounding rectangle.

FINAL ARCHITECTURAL QA
Before returning JSON, verify:
- no duplicate/overlapping collinear wall segments;
- all exterior wall segments form the visible perimeter;
- every opening host exists;
- every opening center lies on its host wall;
- opening position_on_wall agrees with the geometry;
- room polygons lie inside the building footprint;
- the slab follows the architectural footprint;
- no furniture or decorative line has been mistaken for a wall.

Return ONLY structured JSON matching ArchitectureAnalysis.
""".strip()

def build_details_prompt(architecture: BuildingAnalysis) -> str:
    arch_payload = {
        "walls": [w.model_dump() for w in architecture.walls],
        "openings": [o.model_dump() for o in architecture.openings],
        "rooms": [r.model_dump() for r in architecture.rooms],
    }
    return r"""
You are the INTERIOR INVENTORY pass of a professional AI floor-plan reconstruction system.
The same floor-plan image is supplied together with an architectural graph extracted first.

The IMAGE remains the visual authority.
The architectural graph is the coordinate and room authority.

OBJECT INVENTORY
1. Inspect every major visible interior element room-by-room:
   beds, wardrobes, desks, chairs, sofas, tables, TV units, cabinets, kitchen counters,
   sinks, basins, WC, bathtub, shower, refrigerator, stove, chimney and clearly visible appliances.
2. Do NOT invent objects from decorative lines, textures, labels, shadows, rugs or cabinet seams.
3. Keep repeated physical objects as separate instances.
4. For a clearly visible built-in, report it as one coherent object rather than fragmenting every panel.

PLACEMENT
5. location_pt is the CENTER of the object's full visible footprint.
6. Use the same coordinate system as the architectural graph.
7. Every object must have a room_id when it can be assigned reliably.
8. room_id must agree with the object's actual footprint, not just the nearest label.
9. Use anchor_hint:
   - WALL when the object is visibly attached/aligned to a wall,
   - CENTER when it is intentionally free-standing near the room center,
   - EDGE when it is placed against a room edge/boundary,
   - NONE when unclear.
10. If a wall-hugging object is clearly aligned to a wall, provide anchor_wall_id.

DIMENSIONS — CRITICAL
11. dimensions=[width, depth, height] describe the object's LOCAL, unrotated width/depth footprint.
12. rotation is stored separately and rotates that footprint in plan view; never pre-rotate dimensions and then also encode that rotation.
13. Estimate dimensions from the SAME GLOBAL SCALE as the architecture, using the visible object footprint, room proportions, and nearby objects as reference.
14. Never guess an extreme catalogue-sized dimension.
15. A freestanding object should normally occupy no more than about 75% of the room's usable width/depth.
16. A built-in linear object may occupy more, but its footprint must match the visible run in the drawing.
17. If uncertain between two sizes, choose the smaller visually supported size.
18. Do not use a dimension larger than the visible object footprint. The room polygon is guidance, not a reason to move the object.

ORIENTATION
19. rotation is plan-view orientation.
20. For wall-aligned wardrobes/cabinets/counters/TV units, align the LONG face parallel to the host wall.
21. For desks/tables, use the visible long axis from the drawing rather than an arbitrary 90-degree rotation.
22. Do not rotate an object merely to make it fit if the drawing provides clear orientation evidence.

SHAPE
23. Provide shape_hint where visually supported:
    RECTANGULAR, ROUND, OVAL, L_SHAPE, WALL_MOUNTED, BUILT_IN, or FREEFORM.
24. Use ROUND/OVAL for clearly circular or oval tables and fixtures.
25. Use L_SHAPE for clearly L-shaped sofas/counters.
26. Shape_hint is not allowed to invent hidden geometry.

SEMANTIC TYPES
BED, SOFA, L_SHAPE_SOFA, CHAIR, TABLE, ROUND_TABLE, OVAL_TABLE, DESK, WARDROBE, TV_UNIT,
SHELF, CABINET, WC, WASHBASIN, SINK, BATHTUB, SHOWER,
REFRIGERATOR, WASHINGMACHINE, DISHWASHER, MICROWAVE, GAS_STOVE, CHIMNEY, SPLIT_AC,
CEILING_FAN, EXHAUST_FAN, TELEVISION, WATER_HEATER, WATER_PURIFIER, GENERIC_FURNITURE.

ROOM-BY-ROOM CONSISTENCY CHECK
27. Verify every object's footprint against its room before returning.
28. Avoid overlapping major objects unless the source drawing clearly shows nesting (for example a sink in a counter).
29. Keep realistic circulation clearance around doors, beds, desks, and main seating groups.
30. For paired furniture, preserve the visual relationship shown in the source (e.g. nightstands on both sides of a bed).
31. Distinguish bedside/nightstand furniture from full-height wall cabinets.
32. In a study, use the desk long axis visible in the source and keep chairs around the desk.
33. Distinguish fixed kitchen counters from freestanding islands; use L-shaped geometry when clearly visible.
34. For a circular/oval meeting or living table, use ROUND_TABLE or OVAL_TABLE.

Return ONLY structured JSON matching DetailsAnalysis.

ARCHITECTURE REFERENCE:
""" + json.dumps(arch_payload, separators=(",", ":"))

def build_gemini_client():
    key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("[!] GOOGLE_API_KEY (or GEMINI_API_KEY) is not set.")
    return genai.Client(api_key=key)


class ArchitectureAnalysis(BaseModel):
    building_name: str = "AI Floor Plan"
    walls: List[WallData]
    openings: List[OpeningComponent] = Field(default_factory=list)
    rooms: List[RoomData] = Field(default_factory=list)
    slabs: List[SlabData] = Field(default_factory=list)


class DetailsAnalysis(BaseModel):
    interiors: List[InteriorComponent] = Field(default_factory=list)


def _generate_structured(client, image_part, prompt: str, schema):
    response = client.models.generate_content(
        model=MODEL_NAME,
        contents=[image_part, prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0.0,
            max_output_tokens=65535,
        ),
    )
    parsed = response.parsed
    if parsed is None:
        raise RuntimeError("Gemini returned no structured parsed response.")
    return parsed


def _merge_ai_passes(architecture: ArchitectureAnalysis, details: DetailsAnalysis) -> BuildingAnalysis:
    data = BuildingAnalysis(
        building_name=architecture.building_name,
        walls=architecture.walls,
        openings=architecture.openings,
        rooms=architecture.rooms,
        interiors=details.interiors,
        slabs=architecture.slabs,
    )
    return normalize_analysis(data)


def analyze_floor_plan(image_path: str) -> BuildingAnalysis:
    client = build_gemini_client()
    image_part = _image_part(image_path)

    print(f"[AI] Model: {MODEL_NAME}")
    print("[AI] Pass 1/2: architectural graph (walls + openings + rooms + slab)")
    architecture_raw = _generate_structured(client, image_part, build_architecture_prompt(), ArchitectureAnalysis)
    architecture = normalize_analysis(BuildingAnalysis(
        building_name=architecture_raw.building_name,
        walls=architecture_raw.walls,
        openings=architecture_raw.openings,
        rooms=architecture_raw.rooms,
        interiors=[],
        slabs=architecture_raw.slabs,
    ))
    if not architecture.walls:
        raise RuntimeError("Gemini returned zero architectural walls; refusing to create a misleading IFC.")
    print(f"[AI] Architecture pass: walls={len(architecture.walls)} openings={len(architecture.openings)} rooms={len(architecture.rooms)} slabs={len(architecture.slabs)}")

    print("[AI] Pass 2/2: room-by-room detail inventory")
    details_raw = _generate_structured(client, image_part, build_details_prompt(architecture), DetailsAnalysis)
    data = _merge_ai_passes(
        ArchitectureAnalysis(
            building_name=architecture.building_name,
            walls=architecture.walls,
            openings=architecture.openings,
            rooms=architecture.rooms,
            slabs=architecture.slabs,
        ),
        details_raw,
    )
    print(f"[AI] Detail pass: interiors={len(data.interiors)}")
    print(f"[AI] Final extraction: walls={len(data.walls)} openings={len(data.openings)} rooms={len(data.rooms)} interiors={len(data.interiors)} slabs={len(data.slabs)}")
    return data


# ============================================================================
# 4. WALL + OPENING GEOMETRY
# ============================================================================


def distance_2d(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def project_to_wall(start, end, point):
    dx, dy = end[0] - start[0], end[1] - start[1]
    length2 = dx * dx + dy * dy
    if length2 <= 1e-12:
        return 0.0
    t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length2
    return max(0.0, min(1.0, t))


def wall_direction(start, end):
    length = distance_2d(start, end)
    if length <= 1e-9:
        return 1.0, 0.0, 0.0
    return (end[0] - start[0]) / length, (end[1] - start[1]) / length, length


def wall_intervals(wall: WallData, openings: Iterable[OpeningComponent]):
    start, end = wall.start_pt, wall.end_pt
    ux, uy, length = wall_direction(start, end)
    if length <= 1e-9:
        return ux, uy, length, []
    intervals = []
    for op in openings:
        if op.position_on_wall is not None:
            t = max(0.0, min(1.0, float(op.position_on_wall)))
        else:
            t = project_to_wall(start, end, op.location_pt)
        half = min(0.49, max(0.01, op.width / 2.0 / length))
        a = max(0.0, t - half)
        b = min(1.0, t + half)
        if b > a:
            intervals.append((a, b, op, t))
    intervals.sort(key=lambda x: x[0])
    # Merge overlapping openings deterministically so wall segments never overlap.
    merged = []
    for entry in intervals:
        if not merged or entry[0] > merged[-1][1] + 1e-6:
            merged.append(list(entry))
        else:
            merged[-1][1] = max(merged[-1][1], entry[1])
    return ux, uy, length, [tuple(x) for x in merged]


def create_wall_segment(model, context, storey_pl, material_cache, owner_history,
                        wall_id: str, start, end, thickness, z0, height,
                        color=(0.82, 0.82, 0.82), props=None):
    if height <= 0.02:
        return None, 0.0
    length = distance_2d(start, end)
    if length <= 0.02:
        return None, 0.0
    angle = math.degrees(math.atan2(end[1] - start[1], end[0] - start[0]))
    placement = make_local_placement(model, storey_pl, start[0], start[1], z0, angle)
    wall = model.create_entity(
        "IfcWallStandardCase",
        GlobalId=ifcopenshell.guid.new(),
        Name=wall_id,
        OwnerHistory=owner_history,
        ObjectPlacement=placement,
    )
    solid = create_box_solid(model, length, thickness, height, x=length / 2.0, y=0.0, z=0.0)
    style_solid(model, solid, color, f"{wall_id}_Style")
    attach_representation(model, wall, context, [solid])
    assign_material(model, owner_history, wall, material_cache, "Plaster")
    if props:
        add_property_set(model, owner_history, wall, "Pset_WallCommon", props)
    add_quantity_set(model, owner_history, wall, {
        "Length": length,
        "Width": thickness,
        "Height": height,
        "GrossVolume": length * thickness * height,
    })
    return wall, length


def opening_center_on_wall(wall: WallData, op: OpeningComponent):
    ux, uy, length = wall_direction(wall.start_pt, wall.end_pt)
    if length <= 1e-9:
        return wall.start_pt[0], wall.start_pt[1], ux, uy, length, 0.0
    if op.position_on_wall is not None:
        t = max(0.0, min(1.0, float(op.position_on_wall)))
    else:
        t = project_to_wall(wall.start_pt, wall.end_pt, op.location_pt)
    # Deterministic repair: the BIM opening must physically lie on its host wall.
    cx = wall.start_pt[0] + ux * length * t
    cy = wall.start_pt[1] + uy * length * t
    return cx, cy, ux, uy, length, t


def _find_nearest_wall(opening: OpeningComponent, walls: Dict[str, WallData]):
    best_id = None
    best_dist = float("inf")
    for wall_id, wall in walls.items():
        t = project_to_wall(wall.start_pt, wall.end_pt, opening.location_pt)
        ux, uy, length = wall_direction(wall.start_pt, wall.end_pt)
        px = wall.start_pt[0] + ux * length * t
        py = wall.start_pt[1] + uy * length * t
        d = math.hypot(opening.location_pt[0] - px, opening.location_pt[1] - py)
        if d < best_dist:
            best_id, best_dist = wall_id, d
    return best_id, best_dist


def create_opening_products(model, context, storey_pl, owner_history, material_cache,
                            wall_map, wall_lookup, elements, op: OpeningComponent):
    wall = wall_lookup.get(op.parent_wall_id)
    if wall is None:
        print(f"[Opening-WARN] {op.id}: parent wall '{op.parent_wall_id}' not found; skipped")
        return

    cx, cy, ux, uy, _, t = opening_center_on_wall(wall, op)
    angle = math.degrees(math.atan2(uy, ux))
    opening_z = 0.0
    opening_placement = make_local_placement(model, storey_pl, cx, cy, opening_z, angle)
    opening_elem = model.create_entity(
        "IfcOpeningElement",
        GlobalId=ifcopenshell.guid.new(),
        Name=f"Opening_{op.id}",
        OwnerHistory=owner_history,
        ObjectPlacement=opening_placement,
    )
    # The opening element is intentionally non-rendering. The wall itself is
    # already split around the opening, so adding a visible "void box" would
    # create an extra solid in WebIFC/Xeokit. The IFC relationship carries the
    # semantic opening while the segmented wall carries the visual void.
    model.create_entity(
        "IfcRelVoidsElement",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatingBuildingElement=wall_map[op.parent_wall_id],
        RelatedOpeningElement=opening_elem,
    )

    normalized_type = normalize_key(op.type)
    if normalized_type == "window":
        sill = float(op.sill_height if op.sill_height is not None else 0.9)
        frame_w = 0.06
        frame_d = min(0.12, wall.thickness)
        frame = []
        frame.extend([
            create_box_solid(model, op.width, frame_d, frame_w, y=0, z=sill),
            create_box_solid(model, op.width, frame_d, frame_w, y=0, z=sill + op.height - frame_w),
            create_box_solid(model, frame_w, frame_d, max(0.1, op.height - 2 * frame_w), x=-op.width / 2 + frame_w / 2, z=sill + frame_w),
            create_box_solid(model, frame_w, frame_d, max(0.1, op.height - 2 * frame_w), x=op.width / 2 - frame_w / 2, z=sill + frame_w),
        ])
        glass = create_box_solid(model, max(0.05, op.width - 2 * frame_w), frame_d * 0.35, max(0.05, op.height - 2 * frame_w), z=sill + frame_w)
        frame.append(glass)
        window = model.create_entity(
            "IfcWindow", GlobalId=ifcopenshell.guid.new(), Name=op.id,
            OwnerHistory=owner_history, ObjectPlacement=opening_placement,
            OverallHeight=op.height, OverallWidth=op.width,
        )
        for solid in frame:
            style_solid(model, solid, clamp_color(op.color, (0.78, 0.82, 0.86)), f"{op.id}_WindowStyle")
        attach_representation(model, window, context, frame)
        assign_material(model, owner_history, window, material_cache, op.material or "Aluminium and Glass")
        add_property_set(model, owner_history, window, "Pset_WindowCommon", {
            "OverallWidth": op.width,
            "OverallHeight": op.height,
            "OperationType": op.operation_type or "NOTDEFINED",
            "SourceWall": op.parent_wall_id,
            "AIConfidence": op.properties[0].value if op.properties and op.properties[0].name.lower() == "confidence" else None,
        })
        elements.extend([opening_elem, window])
    else:
        frame_w = 0.07
        depth = min(0.08, wall.thickness)
        panel_w = max(0.05, op.width - 2 * frame_w)
        door_solids = [
            create_box_solid(model, frame_w, depth, op.height, x=-op.width / 2 + frame_w / 2),
            create_box_solid(model, frame_w, depth, op.height, x=op.width / 2 - frame_w / 2),
            create_box_solid(model, panel_w, depth, frame_w, y=0, z=op.height - frame_w),
            create_box_solid(model, panel_w, max(0.025, depth * 0.55), max(0.04, op.height - 2 * frame_w), y=0.015, z=frame_w),
        ]
        door = model.create_entity(
            "IfcDoor", GlobalId=ifcopenshell.guid.new(), Name=op.id,
            OwnerHistory=owner_history, ObjectPlacement=opening_placement,
            OverallHeight=op.height, OverallWidth=op.width,
        )
        for solid in door_solids:
            style_solid(model, solid, clamp_color(op.color, (0.58, 0.38, 0.20)), f"{op.id}_DoorStyle")
        attach_representation(model, door, context, door_solids)
        assign_material(model, owner_history, door, material_cache, op.material or "Wood")
        add_property_set(model, owner_history, door, "Pset_DoorCommon", {
            "OverallWidth": op.width,
            "OverallHeight": op.height,
            "OperationType": op.operation_type or "NOTDEFINED",
            "SourceWall": op.parent_wall_id,
        })
        elements.extend([opening_elem, door])

    add_property_set(model, owner_history, opening_elem, "Pset_AIOpening", {
        "SourceId": op.id,
        "HostWall": op.parent_wall_id,
        "CenterX": cx,
        "CenterY": cy,
        "Width": op.width,
        "Height": op.height,
        "NormalizedT": t,
    })


# ============================================================================
# 5. TYPE-AWARE AI-DRIVEN INTERIOR GEOMETRY
# ============================================================================


def create_interior_solids(model, item_type: str, w: float, d: float, h: float):
    key = normalize_key(item_type)
    solids = []

    # Furniture --------------------------------------------------------------
    if key in {"bed", "double_bed", "queen_bed", "king_bed"}:
        base_h = min(0.35, h * 0.55)
        mattress_h = max(0.12, h - base_h)
        solids += [
            create_box_solid(model, w, d, base_h, z=0.0),
            create_box_solid(model, w * 0.96, d * 0.92, mattress_h, z=base_h),
            create_box_solid(model, w * 0.96, 0.10, max(h, 0.9), y=d / 2 - 0.05, z=0.0),
        ]
    elif key in {"l_shape_sofa"}:
        seat_h = min(0.42, h * 0.55)
        back_h = max(0.25, h - 0.18)
        arm = min(0.12, min(w, d) * 0.10)
        leg_a = create_box_solid(model, max(0.2, w), d * 0.42, seat_h, y=-d * 0.29, z=0.18)
        leg_b = create_box_solid(model, w * 0.42, max(0.2, d), seat_h, x=-w * 0.29, z=0.18)
        back_a = create_box_solid(model, max(0.2, w), d * 0.10, back_h, y=-d * 0.02, z=0.18)
        back_b = create_box_solid(model, w * 0.10, max(0.2, d * 0.86), back_h, x=-w * 0.02, z=0.18)
        solids += [leg_a, leg_b, back_a, back_b]
    elif key in {"sofa", "couch", "settee", "armchair", "recliner"}:
        seat_h = min(0.42, h * 0.55)
        back_h = max(0.25, h - 0.18)
        arm_w = min(0.12, w * 0.10)
        solids += [
            create_box_solid(model, max(0.2, w - 2 * arm_w), d * 0.82, seat_h, z=0.18),
            create_box_solid(model, max(0.2, w - 2 * arm_w), d * 0.12, back_h, y=d * 0.44, z=0.18),
            create_box_solid(model, arm_w, d * 0.86, h * 0.75, x=-w / 2 + arm_w / 2, z=0.18),
            create_box_solid(model, arm_w, d * 0.86, h * 0.75, x=w / 2 - arm_w / 2, z=0.18),
        ]
    elif key in {"chair", "dining_chair", "bar_stool", "stool"}:
        seat_h = min(0.50, h * 0.55)
        leg_h = max(0.20, seat_h)
        leg = max(0.04, min(0.08, min(w, d) * 0.18))
        solids += [create_box_solid(model, w * 0.88, d * 0.88, leg, z=0.0),
                   create_box_solid(model, w * 0.90, d * 0.90, max(0.06, h - leg_h), z=leg_h)]
        solids += [
            create_box_solid(model, leg, leg, leg_h, x=-(w / 2 - leg), y=-(d / 2 - leg)),
            create_box_solid(model, leg, leg, leg_h, x=(w / 2 - leg), y=-(d / 2 - leg)),
            create_box_solid(model, leg, leg, leg_h, x=-(w / 2 - leg), y=(d / 2 - leg)),
            create_box_solid(model, leg, leg, leg_h, x=(w / 2 - leg), y=(d / 2 - leg)),
        ]
    elif key in {"round_table", "oval_table"}:
        radius = max(0.20, min(w, d) / 2.0)
        solids.append(create_cylinder_solid(model, radius, min(0.10, h * 0.18), z=max(0.20, h * 0.72)))
        leg_h = max(0.20, h - min(0.10, h * 0.18))
        solids.append(create_cylinder_solid(model, max(0.05, min(w, d) * 0.12), leg_h * 0.65, z=0.0))
    elif key in {"table", "dining_table", "coffee_table", "centre_table", "side_table", "desk", "study_desk"}:
        top_t = min(0.10, h * 0.18)
        leg_h = max(0.20, h - top_t)
        leg = max(0.045, min(0.08, min(w, d) * 0.12))
        solids.append(create_box_solid(model, w, d, top_t, z=leg_h))
        for sx in (-1, 1):
            for sy in (-1, 1):
                solids.append(create_box_solid(model, leg, leg, leg_h,
                                               x=sx * (w / 2 - leg), y=sy * (d / 2 - leg)))
    elif key in {"wardrobe", "almirah", "closet", "cabinet", "kitchen_cabinet", "tv_unit", "shelf", "bookshelf", "open_bookshelf"}:
        solids.append(create_box_solid(model, w, d, h))
        # Front shelf/door articulation.
        if h > 0.7:
            shelves = max(1, min(5, round(h / 0.45)))
            gap = h / (shelves + 1)
            for i in range(1, shelves + 1):
                solids.append(create_box_solid(model, w * 0.92, min(0.05, d * 0.12), 0.035,
                                               y=-d / 2 + 0.035, z=i * gap))
    elif key in {"tv", "television", "tv_screen"}:
        stand_h = min(0.45, h * 0.30)
        solids += [
            create_box_solid(model, w, 0.06, max(0.05, h - stand_h), z=stand_h),
            create_box_solid(model, w * 0.80, d * 0.55, stand_h, z=0.0),
        ]

    # Sanitary ----------------------------------------------------------------
    elif key in {"wc", "toilet", "commode", "urinal"}:
        bowl_h = min(0.38, h * 0.75)
        solids += [
            create_cylinder_solid(model, max(0.12, min(w, d) * 0.34), bowl_h, z=0.02),
            create_box_solid(model, min(w * 0.65, 0.28), min(d * 0.30, 0.22), h * 0.85, y=d * 0.26, z=0.0),
        ]
    elif key in {"washbasin", "basin", "sink", "kitchen_sink"}:
        solids += [
            create_box_solid(model, w, d, min(0.12, h * 0.30), z=max(0.15, h * 0.70)),
            create_cylinder_solid(model, max(0.08, min(w, d) * 0.28), min(0.10, h * 0.20), z=max(0.20, h * 0.55)),
        ]
    elif key in {"bathtub", "bath", "shower"}:
        rim = min(0.12, h * 0.30)
        solids += [create_box_solid(model, w, d, max(0.10, h * 0.55), z=0.0),
                   create_box_solid(model, w, 0.08, rim, y=-d / 2 + 0.04, z=max(0.25, h * 0.55)),
                   create_box_solid(model, w, 0.08, rim, y=d / 2 - 0.04, z=max(0.25, h * 0.55)),
                   create_box_solid(model, 0.08, max(0.10, d - 0.16), rim, x=-w / 2 + 0.04, z=max(0.25, h * 0.55)),
                   create_box_solid(model, 0.08, max(0.10, d - 0.16), rim, x=w / 2 - 0.04, z=max(0.25, h * 0.55))]

    # Appliances --------------------------------------------------------------
    elif key in {"refrigerator", "fridge", "fridge_freezer"}:
        solids += [create_box_solid(model, w, d, h),
                   create_box_solid(model, w * 0.45, 0.025, h * 0.86, x=-w * 0.23, y=-d / 2 - 0.012),
                   create_box_solid(model, w * 0.45, 0.025, h * 0.86, x=w * 0.23, y=-d / 2 - 0.012)]
    elif key in {"washingmachine", "washing_machine", "dishwasher"}:
        solids += [create_box_solid(model, w, d, h),
                   create_cylinder_solid(model, min(w, d) * 0.30, 0.03, y=-d / 2 - 0.015, z=h * 0.45)]
    elif key in {"microwave", "otg", "oven"}:
        solids += [create_box_solid(model, w, d, h),
                   create_box_solid(model, w * 0.78, 0.025, h * 0.58, y=-d / 2 - 0.012, z=h * 0.24)]
    elif key in {"gas_stove", "induction_cooktop", "cooking_range", "stove"}:
        solids.append(create_box_solid(model, w, d, h))
        burner_r = max(0.04, min(w, d) * 0.13)
        xs = (-w * 0.22, w * 0.22)
        ys = (-d * 0.18, d * 0.18)
        for x in xs:
            for y in ys:
                solids.append(create_cylinder_solid(model, burner_r, max(0.01, h * 0.22), x=x, y=y, z=h))
    elif key in {"chimney", "split_ac", "window_ac", "air_conditioner", "air_purifier", "water_heater", "water_purifier"}:
        solids += [create_box_solid(model, w, d, h),
                   create_box_solid(model, w * 0.80, 0.03, min(0.05, h * 0.25), y=-d / 2 - 0.015, z=h * 0.45)]
    elif key in {"ceiling_fan", "fan", "exhaust_fan"}:
        hub_r = max(0.04, min(w, d) * 0.10)
        solids.append(create_cylinder_solid(model, hub_r, max(0.05, h), z=max(0.0, h * 0.40)))
        blade_len = max(0.15, min(w, d) * 0.45)
        blade_w = max(0.03, min(w, d) * 0.10)
        blade_z = h * 0.30
        for a in (0, 90, 180, 270):
            # Four slim blades using an XY box; local direction is handled by a tiny
            # offset rotation at the solid level through geometry orientation.
            x = math.cos(math.radians(a)) * blade_len / 2
            y = math.sin(math.radians(a)) * blade_len / 2
            solids.append(create_box_solid(model, blade_len, blade_w, max(0.02, h * 0.18), x=x, y=y, z=blade_z))
    elif key in {"bedside_table", "nightstand", "filecabinet", "shoe_rack", "dresser", "dressing_table", "sideboard"}:
        solids += [create_box_solid(model, w, d, h),
                   create_box_solid(model, w * 0.88, 0.03, 0.04, y=-d / 2 - 0.015, z=h * 0.5)]
    else:
        # Generic object: still fully driven by Gemini type/dimensions.
        solids.append(create_box_solid(model, w, d, h))

    return solids or [create_box_solid(model, w, d, h)]


def build_interior_element(model, context, storey_pl, owner_history, material_cache,
                           elements, item: InteriorComponent):
    w, d, h = item.dimensions
    cx, cy = item.location_pt
    key = normalize_key(item.type)
    shape_hint = normalize_key(item.shape_hint or "")
    if shape_hint == "round" and key in {"table", "dining_table", "coffee_table", "centre_table", "side_table"}:
        key = "round_table"
    elif shape_hint == "oval" and key in {"table", "dining_table", "coffee_table", "centre_table", "side_table"}:
        key = "oval_table"
    elif shape_hint == "l_shape" and key in {"sofa", "couch", "settee"}:
        key = "l_shape_sofa"
    placement = make_local_placement(model, storey_pl, cx, cy, 0.0, item.rotation)

    class_by_category = {
        "furnishing": "IfcFurniture",
        "sanitary": "IfcSanitaryTerminal",
        "appliance": "IfcElectricAppliance",
    }
    cls = class_by_category.get(normalize_key(item.category), "IfcFurniture")
    element = model.create_entity(
        cls,
        GlobalId=ifcopenshell.guid.new(),
        Name=item.id,
        OwnerHistory=owner_history,
        ObjectPlacement=placement,
    )
    solids = create_interior_solids(model, key, w, d, h)
    color = clamp_color(item.color, {
        "bed": (0.55, 0.27, 0.07),
        "sofa": (0.55, 0.55, 0.70),
        "chair": (0.55, 0.55, 0.70),
        "table": (0.45, 0.23, 0.08),
        "desk": (0.45, 0.23, 0.08),
        "wc": (0.90, 0.90, 0.90),
        "washbasin": (0.92, 0.92, 0.92),
        "sink": (0.70, 0.72, 0.74),
        "bathtub": (0.90, 0.90, 0.90),
        "refrigerator": (0.78, 0.80, 0.82),
        "gas_stove": (0.40, 0.40, 0.42),
        "split_ac": (0.93, 0.94, 0.96),
        "television": (0.05, 0.05, 0.06),
    }.get(key, (0.68, 0.68, 0.68)))
    for solid in solids:
        style_solid(model, solid, color, f"{item.id}_Style")
    attach_representation(model, element, context, solids)
    assign_material(model, owner_history, element, material_cache, item.material or "AI Assigned Material")

    add_property_set(model, owner_history, element, "Pset_AIReconstruction", {
        "AIType": item.type,
        "Category": item.category,
        "RoomHint": item.room_hint,
        "RoomId": item.room_id,
        "ShapeHint": item.shape_hint,
        "AnchorHint": item.anchor_hint,
        "AnchorWallId": item.anchor_wall_id,
        "RotationDegrees": item.rotation,
        "CenterX": cx,
        "CenterY": cy,
        "Width": w,
        "Depth": d,
        "Height": h,
        "AIConfidence": item.confidence,
    })
    if item.properties:
        add_property_set(model, owner_history, element, "Pset_AIExtractedProperties", {
            prop.name: prop.value for prop in item.properties[:12]
        })
    add_quantity_set(model, owner_history, element, {
        "Width": w,
        "Depth": d,
        "Height": h,
    })
    elements.append(element)


# ============================================================================
# 6. IFC BUILD
# ============================================================================


def build_ifc(data: BuildingAnalysis, output_path: str, debug: bool = False):
    model = ifcopenshell.file(schema="IFC4")
    material_cache: Dict[str, object] = {}

    person = model.create_entity("IfcPerson", Identification="AI", FamilyName="Reconstruction")
    org = model.create_entity("IfcOrganization", Name="High Creation Interior")
    person_org = model.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
    app = model.create_entity(
        "IfcApplication",
        ApplicationDeveloper=org,
        Version=str(PIPELINE_VERSION),
        ApplicationFullName="HCI Pure AI Floorplan Compiler",
        ApplicationIdentifier="HCI-AI",
    )
    owner_history = model.create_entity(
        "IfcOwnerHistory",
        OwningUser=person_org,
        OwningApplication=app,
        ChangeAction="ADDED",
        CreationDate=int(time.time()),
    )
    units = model.create_entity(
        "IfcUnitAssignment",
        Units=[model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")],
    )
    origin = make_point(model, (0.0, 0.0, 0.0))
    world = model.create_entity("IfcAxis2Placement3D", Location=origin)
    context = model.create_entity(
        "IfcGeometricRepresentationContext",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=world,
    )
    project = model.create_entity(
        "IfcProject", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name=data.building_name, RepresentationContexts=[context], UnitsInContext=units,
    )
    site = model.create_entity(
        "IfcSite", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name="Site", ObjectPlacement=model.create_entity("IfcLocalPlacement", RelativePlacement=world),
    )
    building = model.create_entity(
        "IfcBuilding", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name="AI Building", ObjectPlacement=model.create_entity("IfcLocalPlacement", PlacementRelTo=site.ObjectPlacement, RelativePlacement=world),
    )
    storey_pl = model.create_entity("IfcLocalPlacement", PlacementRelTo=building.ObjectPlacement, RelativePlacement=world)
    storey = model.create_entity(
        "IfcBuildingStorey", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name="Ground Floor", ObjectPlacement=storey_pl,
    )
    model.create_entity("IfcRelAggregates", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
                        RelatingObject=project, RelatedObjects=[site])
    model.create_entity("IfcRelAggregates", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
                        RelatingObject=site, RelatedObjects=[building])
    model.create_entity("IfcRelAggregates", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
                        RelatingObject=building, RelatedObjects=[storey])

    elements = []
    wall_map: Dict[str, object] = {}
    wall_lookup: Dict[str, WallData] = {w.wall_id: w for w in data.walls}
    openings_by_wall: Dict[str, List[OpeningComponent]] = {}
    for op in data.openings:
        if op.parent_wall_id not in wall_lookup:
            nearest_id, nearest_dist = _find_nearest_wall(op, wall_lookup)
            if nearest_id is not None and nearest_dist <= 0.9:
                print(f"[Opening-REPAIR] {op.id}: re-hosting from '{op.parent_wall_id}' to nearest wall '{nearest_id}' (distance={nearest_dist:.2f}m)")
                op.parent_wall_id = nearest_id
            else:
                print(f"[Opening-WARN] {op.id}: no reliable host wall found; skipping")
                continue
        # Snap the opening center onto the authoritative host wall immediately.
        cx, cy, ux, uy, length, t = opening_center_on_wall(wall_lookup[op.parent_wall_id], op)
        op.location_pt = [cx, cy]
        op.position_on_wall = t
        openings_by_wall.setdefault(op.parent_wall_id, []).append(op)

    # Walls are constructed with true openings; no wall assets are consulted.
    for wall in data.walls:
        start, end = wall.start_pt, wall.end_pt
        ux, uy, length, intervals = wall_intervals(wall, openings_by_wall.get(wall.wall_id, []))
        if length <= 0.02:
            continue

        cursor = 0.0
        created_for_id = []
        for a, b, op, _t in intervals:
            if a > cursor + 1e-6:
                seg_start = [start[0] + ux * length * cursor, start[1] + uy * length * cursor]
                seg_end = [start[0] + ux * length * a, start[1] + uy * length * a]
                wall_elem, _ = create_wall_segment(
                    model, context, storey_pl, material_cache, owner_history,
                    f"{wall.wall_id}_A{len(created_for_id)+1}", seg_start, seg_end,
                    wall.thickness, 0.0, wall.height,
                    props={"SourceWallId": wall.wall_id, "IsOpeningSegment": False},
                )
                if wall_elem:
                    created_for_id.append(wall_elem)
                    elements.append(wall_elem)
            if normalize_key(op.type) == "window":
                # Window opening: retain wall below sill and above head.
                sill = max(0.0, float(op.sill_height if op.sill_height is not None else 0.9))
                t0, t1 = a, b
                seg_start = [start[0] + ux * length * t0, start[1] + uy * length * t0]
                seg_end = [start[0] + ux * length * t1, start[1] + uy * length * t1]
                low_elem, _ = create_wall_segment(
                    model, context, storey_pl, material_cache, owner_history,
                    f"{wall.wall_id}_{op.id}_LOW", seg_start, seg_end,
                    wall.thickness, 0.0, min(sill, wall.height),
                    props={"SourceWallId": wall.wall_id, "WindowId": op.id, "Zone": "BelowSill"},
                )
                if low_elem:
                    created_for_id.append(low_elem); elements.append(low_elem)
                top_z = sill + op.height
                if top_z < wall.height - 0.02:
                    high_elem, _ = create_wall_segment(
                        model, context, storey_pl, material_cache, owner_history,
                        f"{wall.wall_id}_{op.id}_HIGH", seg_start, seg_end,
                        wall.thickness, top_z, wall.height - top_z,
                        props={"SourceWallId": wall.wall_id, "WindowId": op.id, "Zone": "AboveHead"},
                    )
                    if high_elem:
                        created_for_id.append(high_elem); elements.append(high_elem)
            cursor = max(cursor, b)

        if cursor < 1.0 - 1e-6:
            seg_start = [start[0] + ux * length * cursor, start[1] + uy * length * cursor]
            seg_end = [end[0], end[1]]
            wall_elem, _ = create_wall_segment(
                model, context, storey_pl, material_cache, owner_history,
                f"{wall.wall_id}_Z{len(created_for_id)+1}", seg_start, seg_end,
                wall.thickness, 0.0, wall.height,
                props={"SourceWallId": wall.wall_id, "IsOpeningSegment": False},
            )
            if wall_elem:
                created_for_id.append(wall_elem)
                elements.append(wall_elem)

        # The canonical wall id is represented by the first created segment for
        # semantic host lookup. Openings use that first segment relationship;
        # wall IDs remain traceable through SourceWallId.
        if created_for_id:
            wall_map[wall.wall_id] = created_for_id[0]

    # Slab: use AI boundary only, with a wall-bbox fallback if AI omitted it.
    if data.slabs and data.slabs[0].outline_pts:
        slab = data.slabs[0]
        pts = slab.outline_pts
    else:
        xs = [p for w in data.walls for p in (w.start_pt, w.end_pt)]
        pts = []
        if xs:
            minx = min(p[0] for p in xs); maxx = max(p[0] for p in xs)
            miny = min(p[1] for p in xs); maxy = max(p[1] for p in xs)
            pts = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]]
        slab = SlabData(outline_pts=pts)

    if pts:
        profile_pts = [make_point(model, (p[0], p[1], 0.0)) for p in pts]
        if profile_pts[0].Coordinates != profile_pts[-1].Coordinates:
            profile_pts.append(profile_pts[0])
        polyline = model.create_entity("IfcPolyline", Points=profile_pts)
        profile = model.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=polyline)
        solid = model.create_entity(
            "IfcExtrudedAreaSolid",
            SweptArea=profile,
            Position=make_axis3(model, 0.0, 0.0, slab.elevation),
            ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0)),
            Depth=slab.thickness,
        )
        style_solid(model, solid, (0.75, 0.75, 0.72), "AI_Floor_Style")
        slab_elem = model.create_entity(
            "IfcSlab", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            Name=slab.slab_id, ObjectPlacement=storey_pl,
            PredefinedType="FLOOR",
        )
        attach_representation(model, slab_elem, context, [solid])
        assign_material(model, owner_history, slab_elem, material_cache, slab.material or "RCC")
        add_property_set(model, owner_history, slab_elem, "Pset_SlabCommon", {
            "Thickness": slab.thickness,
            "Finish": slab.finish,
            "Source": "Gemini",
        })
        elements.append(slab_elem)

    # Openings and their filled products.
    for op in data.openings:
        create_opening_products(
            model, context, storey_pl, owner_history, material_cache,
            wall_map, wall_lookup, elements, op,
        )

    # Interiors: completely procedural from AI semantic data.
    for item in data.interiors:
        build_interior_element(
            model, context, storey_pl, owner_history, material_cache,
            elements, item,
        )

    model.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatedElements=elements,
        RelatingStructure=storey,
    )

    model.write(output_path)
    print(f"[Success] Pure-AI IFC generated: {output_path}")
    print(f"[IFC] Elements contained in Ground Floor: {len(elements)}")


# ============================================================================
# 7. CLI / CACHE
# ============================================================================


def load_or_extract(args):
    cache_path = args.cache
    use_cache = os.path.exists(cache_path) and not args.force
    if use_cache:
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if int(cached.get("_pipeline_version", -1)) == PIPELINE_VERSION and "analysis" in cached:
                data = BuildingAnalysis(**cached["analysis"])
                data = normalize_analysis(data)
                print(f"[Cache] Using pipeline v{PIPELINE_VERSION} cache: {cache_path}")
                return data
            print("[Cache] Existing cache is from an older pipeline; re-extracting.")
        except Exception as exc:
            print(f"[Cache-WARN] Could not read cache; re-extracting: {exc}")

    data = analyze_floor_plan(args.image)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump({"_pipeline_version": PIPELINE_VERSION, "analysis": data.model_dump()}, f, indent=4)
    return data


def main():
    parser = argparse.ArgumentParser(description="Pure-AI floor plan to IFC")
    parser.add_argument("--image", default="1 BHK HOUSE .jpg")
    parser.add_argument("--output", default="1_BHK_Detailed.ifc")
    parser.add_argument("--cache", default="1_BHK_Detailed_Cache.json")
    parser.add_argument("--analysis-output", default=None)
    parser.add_argument("--assets", default=None, help="Legacy compatibility flag; ignored by the pure-AI compiler")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--allow-low-detail", action="store_true", help="Compatibility flag; zero-wall output is still rejected")
    args = parser.parse_args()

    if args.cache == parser.get_default("cache") and args.image != parser.get_default("image"):
        stem = os.path.splitext(os.path.basename(args.image))[0].strip().replace(" ", "_")
        args.cache = f"{stem}_AI_v{PIPELINE_VERSION}_Cache.json"
        print(f"[Info] Using image-specific cache: {args.cache}")


    try:
        data = load_or_extract(args)
        if args.analysis_output:
            with open(args.analysis_output, "w", encoding="utf-8") as f:
                json.dump({
                    "version": PIPELINE_VERSION,
                    "provider": "google-gemini",
                    "model": MODEL_NAME,
                    "analysis": data.model_dump(),
                }, f, indent=4)
            print(f"[AI] Analysis JSON: {args.analysis_output}")
        build_ifc(data, args.output, debug=args.debug)
    except (APIError, ServerError, ClientError) as exc:
        print(f"[API-ERROR] GenAI API failed: {exc}")
        return 2
    except Exception as exc:
        print(f"[ERROR] {type(exc).__name__}: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
