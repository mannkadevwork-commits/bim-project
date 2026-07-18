"""
renderer_v2
===========

Foundation data model and IFC Document Scanner for the V2 BIM rendering
pipeline.

PR-1 established the core scene-graph shapes (RenderNode, RenderScene,
RenderContext, SceneReport). PR-2 strengthened the type system
(GeometryData, MaterialData, SceneStatistics) and added render_id /
world_transform to RenderNode. PR-3A adds the IFC Document Scanner: the
first pipeline stage, which validates and inspects an IFC file's
document-level metadata (schema, header, project/site/building/storeys,
units, coordinate system) without touching geometry or creating any
RenderNodes.

Contents
--------
- ``RenderNode``          : one object in the scene graph (wall, door,
                             furniture instance, future light/annotation).
- ``RenderScene``         : the graph itself, plus geometry/material/
                             metadata stores and scene-level bookkeeping.
- ``RenderContext``       : renderer-wide settings (coordinate system,
                             tone mapping, camera/shadow/ground defaults).
- ``SceneReport``         : structured, stage-tagged diagnostics.
- ``GeometryData``        : strongly typed geometry entry for
                             RenderScene's geometry_store.
- ``MaterialData``        : strongly typed resolved-material entry for
                             RenderScene's material_store.
- ``SceneStatistics``     : strongly typed aggregate counters for
                             RenderScene.statistics.
- ``scan_ifc_document``   : entry point for the IFC Document Scanner stage.
- ``DocumentScanResult``  : the scanner's return type.
- ``ValidationResult``    : pass/fail verdict produced by the scanner.

Explicitly out of scope through PR-3A
-----------------------------------------
- No geometry extraction, no coordinate transforms, no material
  resolution logic, no GLB/OBJ export. Those are separate, later PRs
  that will *populate* the data model this package defines.
- No changes to, or imports from, ``scene_merger.py`` or
  ``aps-pipeline.js``. The existing renderer is completely unaware this
  package exists.
- No import of ``trimesh`` or ``numpy`` anywhere in this package.
  ``ifc_document_scanner.py`` is the only module that imports
  ``ifcopenshell``, and it imports only the top-level package -- never
  ``ifcopenshell.geom``.
"""

from .render_node import (
    RenderNode,
    identity_matrix,
    VALID_SOURCE_TYPES,
    VALID_COORDINATE_SPACES,
)
from .render_scene import RenderScene
from .render_context import RenderContext
from .scene_report import SceneReport, ReportEntry
from .geometry_data import GeometryData
from .material_data import MaterialData, VALID_VERTEX_COLOR_MODES, VALID_MATERIAL_SOURCES
from .scene_statistics import SceneStatistics
from .ifc_document_scanner import scan_ifc_document, DocumentScanResult, ValidationResult

__version__ = "2.0.0-pr3a"

__all__ = [
    "RenderNode",
    "RenderScene",
    "RenderContext",
    "SceneReport",
    "ReportEntry",
    "GeometryData",
    "MaterialData",
    "SceneStatistics",
    "identity_matrix",
    "VALID_SOURCE_TYPES",
    "VALID_COORDINATE_SPACES",
    "VALID_VERTEX_COLOR_MODES",
    "VALID_MATERIAL_SOURCES",
    "scan_ifc_document",
    "DocumentScanResult",
    "ValidationResult",
]