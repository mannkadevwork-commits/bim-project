"""
renderer_v2.scene_statistics
===============================

Defines ``SceneStatistics``: the strongly typed replacement for
``RenderScene.statistics: Dict[str, Any]``.

This class only holds counters and summary values -- it does not compute
them. Future pipeline stages are responsible for populating a
SceneStatistics instance as they run (e.g. the Geometry Extractor
increments structural_nodes, the Scene Validator computes bbox). This PR
only defines the shape.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class SceneStatistics:
    """Aggregate counters and summary values for one RenderScene.

    Fields
    ------
    total_nodes
        Total count of all RenderNodes in the scene, across every
        source_type.
    structural_nodes
        Count of nodes with source_type == "structural".
    furniture_nodes
        Count of nodes with source_type == "furniture".
    light_nodes
        Count of nodes with source_type == "light".
    annotation_nodes
        Count of nodes with source_type == "annotation".
    geometry_count
        Number of entries in RenderScene.geometry_store.
    material_count
        Number of entries in RenderScene.material_store.
    triangle_count
        Total triangle/face count summed across all geometry in use.
    vertex_count
        Total vertex count summed across all geometry in use.
    empty_geometry_count
        Number of GeometryData entries for which is_empty() is True --
        directly surfaces the class of problem that today only shows up
        as a single opaque "No renderable structural geometry found"
        error with no indication of how many elements were affected.
    bbox
        Optional scene-wide axis-aligned bounding box, as
        {"min": [x,y,z], "max": [x,y,z]}.
    render_time_ms
        Optional wall-clock time the render took, in milliseconds.
    warnings
        Count of warning-severity diagnostics recorded for this scene
        (e.g. via a SceneReport's summary()) -- a count, not the entries
        themselves; full diagnostic detail belongs in SceneReport.
    errors
        Count of error-severity diagnostics recorded for this scene.
    """

    total_nodes: int = 0
    structural_nodes: int = 0
    furniture_nodes: int = 0
    light_nodes: int = 0
    annotation_nodes: int = 0
    geometry_count: int = 0
    material_count: int = 0
    triangle_count: int = 0
    vertex_count: int = 0
    empty_geometry_count: int = 0
    bbox: Optional[Dict[str, List[float]]] = None
    render_time_ms: Optional[float] = None
    warnings: int = 0
    errors: int = 0

    def reset(self) -> None:
        """Reset every field back to its default value, in place.

        Lets a caller reuse one SceneStatistics instance across multiple
        render attempts (e.g. a retry after a failed render) without
        constructing a new object and re-wiring references to it.
        """
        defaults = SceneStatistics()
        for f in dataclasses.fields(self):
            setattr(self, f.name, getattr(defaults, f.name))

    def to_dict(self) -> Dict[str, Any]:
        """Serialize these statistics to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SceneStatistics":
        """Reconstruct a SceneStatistics from a dict produced by
        ``to_dict``. Unknown keys are ignored; missing keys fall back to
        this class's own defaults, since a partially-specified stats dict
        (e.g. one written before a new field existed) is an expected
        input, not an error.
        """
        known_fields = {f.name for f in dataclasses.fields(cls)}
        filtered = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered)