"""
renderer_v2.geometry_data
===========================

Defines ``GeometryData``: the strongly typed replacement for storing raw
geometry as ``Dict[str, Any]`` inside ``RenderScene.geometry_store``.

This module has NO dependency on trimesh, ifcopenshell, or numpy.
Vertices, normals, faces, and UVs are held as plain nested Python lists so
that GeometryData stays trivially JSON-serializable and importable without
pulling in the geometry-processing stack -- consistent with PR-1's
foundation-only scope.

native_color / native_material vs. MaterialData
-------------------------------------------------
GeometryData.native_color and GeometryData.native_material capture what
the SOURCE format itself said about this geometry's appearance (e.g. the
raw diffuse color IfcOpenShell reads off an IFC shape's style, before any
resolution). This is deliberately distinct from ``MaterialData``
(material_data.py), which represents the PIPELINE's *resolved* material
after a future Material Resolver stage decides between native color,
project_state.json override, or a default fallback. Keeping the native
fact recorded on the geometry itself -- rather than only on the resolved
material -- means it is never silently lost if resolution falls through to
a default, which is not the case in the current V1 renderer.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class GeometryData:
    """Strongly typed geometry for one node's mesh data.

    Fields
    ------
    id
        Stable identifier for this geometry entry within
        RenderScene.geometry_store. Required, must be non-empty. Multiple
        RenderNodes may share one GeometryData by referencing the same id
        via their geometry_ref (e.g. instanced furniture), so this id is
        the geometry's own identity, not any single node's.
    name
        Optional human-readable label (e.g. the source asset's filename).
    vertices
        List of [x, y, z] float triples, in whatever coordinate_space the
        owning RenderNode declares (native or normalized) -- GeometryData
        itself does not track coordinate space, since the same geometry
        data structure is reused as a node moves through the pipeline;
        the node is the source of truth for which space it's currently in.
    normals
        List of [x, y, z] float triples, one per vertex if present.
        Empty list if normals haven't been computed/loaded.
    faces
        List of index tuples (as lists, e.g. [i0, i1, i2] for a triangle)
        into `vertices`.
    uvs
        List of [u, v] float pairs, one per vertex if present.
    vertex_colors
        List of per-vertex color values (e.g. [r, g, b, a]), if the
        geometry carries baked vertex colors. Left unit-agnostic (0-1 vs
        0-255) here deliberately -- normalizing color representation is a
        Material Resolver concern, not a geometry-storage concern.
    bbox
        Optional axis-aligned bounding box as {"min": [x,y,z], "max":
        [x,y,z]}. None if not yet computed.
    native_color
        Optional [r, g, b] or [r, g, b, a] color read directly from the
        source format (e.g. an IFC element's native style), independent
        of any override. See module docstring for why this is distinct
        from MaterialData.
    native_material
        Optional free-form dict of other native material facts from the
        source format (e.g. transparency, a source-specific material
        name) that don't fit neatly into native_color alone.
    source_file
        Optional path/URL of the file this geometry was extracted or
        loaded from (e.g. "input.ifc", or a furniture asset path).
    metadata
        Free-form bag for anything else worth carrying along (e.g. the
        originating IFC type, extraction warnings specific to this
        geometry).
    """

    id: str
    name: Optional[str] = None
    vertices: List[List[float]] = field(default_factory=list)
    normals: List[List[float]] = field(default_factory=list)
    faces: List[List[int]] = field(default_factory=list)
    uvs: List[List[float]] = field(default_factory=list)
    vertex_colors: List[List[float]] = field(default_factory=list)
    bbox: Optional[Dict[str, List[float]]] = None
    native_color: Optional[List[float]] = None
    native_material: Optional[Dict[str, Any]] = None
    source_file: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate the one field that, if wrong, would silently corrupt
        the geometry store (a missing/empty id makes lookups by id
        impossible) -- checked eagerly rather than left to fail later.
        """
        if not self.id:
            raise ValueError("GeometryData.id must be a non-empty string.")

    def is_empty(self) -> bool:
        """True if this geometry has no usable renderable data.

        Mirrors the check the current V1 renderer makes ad hoc when
        deciding whether extracted IFC geometry is renderable (it treats
        zero vertices OR zero faces as "nothing to render") -- codified
        here as a single reusable method instead of an inline condition
        repeated at each call site.
        """
        return len(self.vertices) == 0 or len(self.faces) == 0

    def vertex_count(self) -> int:
        """Number of vertices in this geometry."""
        return len(self.vertices)

    def face_count(self) -> int:
        """Number of faces in this geometry."""
        return len(self.faces)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize this geometry to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "GeometryData":
        """Reconstruct a GeometryData from a dict produced by ``to_dict``.

        Unknown keys are ignored (forward-compatible with future fields).
        Required key (``id``) is NOT defaulted -- a dict missing it raises
        a ``TypeError``, since inventing an id would hide a real data
        problem rather than surface it.
        """
        known_fields = {f.name for f in dataclasses.fields(cls)}
        filtered = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered)