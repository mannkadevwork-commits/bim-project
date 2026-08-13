"""
renderer_v2.material_data
============================

Defines ``MaterialData``: the strongly typed replacement for storing
resolved materials as ``Dict[str, Any]`` inside
``RenderScene.material_store``.

A MaterialData represents the PIPELINE's resolved answer to "what does
this element look like," after a future Material Resolver stage has
chosen between an element's native color (see GeometryData.native_color),
a project_state.json override, or a default fallback. Recording *which*
of those was chosen (via `source`) is what will let a future Scene
Validator report a coverage metric like "N elements fell back to
default" instead of that being invisible, as it currently is in the V1
renderer.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

VALID_VERTEX_COLOR_MODES = frozenset({
    "none",       # This material does not use per-vertex color at all;
                  # base_color (and any texture, later) is authoritative.
    "native",     # Vertex colors are the geometry's native, unmodified
                  # per-vertex color data.
    "override",   # Vertex colors have been overwritten by a resolved
                  # override color (uniform across the mesh).
})
"""Known values for MaterialData.vertex_color_mode.

Exists because the V1 renderer currently mixes vertex-color and
material-based visuals across nodes in the same scene with no record of
which mode a given element is in -- a direct contributor to the GLB
export inconsistency PR discussion identified (some nodes exposing
COLOR_0 vertex attributes, others exposing baseColorFactor, with no way
to tell which to expect). Making this explicit per-material is the fix.
"""

VALID_MATERIAL_SOURCES = frozenset({
    "native",     # Resolved from the source format's own native color/style.
    "override",   # Resolved from a project_state.json-style override.
    "default",    # Resolved via fallback because neither of the above was available.
})
"""Known values for MaterialData.source.

Mirrors the three-way resolution (native / override / default) that the
V1 renderer performs but never records -- see the PR-1 discussion of the
gray-override bug, which was invisible precisely because nothing tracked
which of these three paths a given element took.
"""


@dataclass
class MaterialData:
    """Strongly typed, resolved material definition for one or more nodes.

    Fields
    ------
    id
        Stable identifier for this material entry within
        RenderScene.material_store. Required, must be non-empty. Multiple
        RenderNodes may share one MaterialData by referencing the same id
        via their material_ref.
    name
        Optional human-readable label.
    base_color
        [r, g, b, a] color, normalized to the 0.0-1.0 range. This is the
        single authoritative color value for this material -- resolution
        logic (native vs. override vs. default) happens upstream, before
        a MaterialData is constructed; by the time one exists, base_color
        is final.
    opacity
        Overall opacity, 0.0 (fully transparent) to 1.0 (fully opaque).
        Kept separate from base_color's alpha channel so a consumer that
        only cares about opacity doesn't have to unpack a color tuple.
    metallic
        PBR metallic factor, 0.0-1.0.
    roughness
        PBR roughness factor, 0.0-1.0.
    emissive
        [r, g, b] emissive color, normalized to 0.0-1.0.
    double_sided
        Whether this material should render both faces of a triangle.
        Directly relevant given the V1 viewer currently forces
        THREE.DoubleSide on every material as a blanket fix -- having
        this be a real per-material field means that decision can
        eventually be made per-element instead of globally.
    vertex_color_mode
        One of VALID_VERTEX_COLOR_MODES. Declares whether/how this
        material's appearance depends on the geometry's per-vertex color
        data, as opposed to base_color alone.
    source
        One of VALID_MATERIAL_SOURCES. Records which resolution path
        produced base_color, for diagnostics/coverage reporting.
    metadata
        Free-form bag for anything else (e.g. the original raw color
        value before normalization, for debugging).
    """

    id: str
    name: Optional[str] = None
    base_color: List[float] = field(default_factory=lambda: [0.8, 0.8, 0.8, 1.0])
    opacity: float = 1.0
    metallic: float = 0.0
    roughness: float = 0.5
    emissive: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    double_sided: bool = False
    vertex_color_mode: str = "none"
    source: str = "default"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate the fields that, if wrong, would silently corrupt
        material resolution reporting rather than raise -- checked
        eagerly, mirroring RenderNode's validation pattern from PR-1.
        """
        if not self.id:
            raise ValueError("MaterialData.id must be a non-empty string.")

        if self.vertex_color_mode not in VALID_VERTEX_COLOR_MODES:
            raise ValueError(
                f"MaterialData '{self.id}': vertex_color_mode must be one "
                f"of {sorted(VALID_VERTEX_COLOR_MODES)}, got "
                f"{self.vertex_color_mode!r}."
            )

        if self.source not in VALID_MATERIAL_SOURCES:
            raise ValueError(
                f"MaterialData '{self.id}': source must be one of "
                f"{sorted(VALID_MATERIAL_SOURCES)}, got {self.source!r}."
            )

    def to_dict(self) -> Dict[str, Any]:
        """Serialize this material to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MaterialData":
        """Reconstruct a MaterialData from a dict produced by ``to_dict``.

        Unknown keys are ignored (forward-compatible with future fields).
        Required key (``id``) is NOT defaulted, for the same reason as
        GeometryData.from_dict.
        """
        known_fields = {f.name for f in dataclasses.fields(cls)}
        filtered = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered)