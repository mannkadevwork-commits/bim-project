"""
renderer_v2.ifc_geometry_diagnostic
=======================================

Implements the IFC Geometry Diagnostic: a read-only inspection tool that
answers, per IfcProduct and aggregated by IFC type:

  - Which elements are geometrically renderable (a non-empty shape was
    produced)?
  - Which elements fail geometry creation (a representation exists but no
    shape was produced)?
  - Which elements produce empty meshes (a shape was produced with zero
    vertices or faces)?
  - Which elements have a native IFC style/material authored on them?
  - What are the vertex/face counts for each successfully generated shape?

This is explicitly NOT the Geometry Extractor. It creates no RenderNodes,
populates no GeometryData, applies no transforms or materials, and
exports no GLB. Its only output is a structured diagnostic report meant
to be read by a developer (or a future automated check) BEFORE the real
Geometry Extractor runs, so geometry problems in a given IFC file are
visible and categorized up front instead of surfacing as a single opaque
"No renderable structural geometry found" error partway through a render.

Why APPLY_DEFAULT_MATERIALS is set to False here
----------------------------------------------------
scene_merger.py (the current V1 renderer) sets APPLY_DEFAULT_MATERIALS to
True, which causes ifcopenshell to synthesize a default material for any
element that has no authored IFC style. That's the right choice for a
renderer that ultimately needs *some* color for every element. It's the
wrong choice for this diagnostic: with default-material synthesis on,
every single element would report "has a style," making the
has_native_style signal meaningless. This module turns it off so
has_native_style reflects what the source IFC document actually
authored, not what ifcopenshell would paper over it with.

This module is the counterpart to ifc_document_scanner.py: that stage
was forbidden from using ifcopenshell.geom.iterator() (document-level
metadata only); this stage is the one place in renderer_v2, alongside
the (not-yet-implemented) Geometry Extractor, that is expected to use it.
"""

from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

try:
    import ifcopenshell
    import ifcopenshell.geom
except ImportError as exc:  # pragma: no cover - exercised only when the
    # optional dependency is genuinely absent.
    raise ImportError(
        "ifcopenshell is required for renderer_v2.ifc_geometry_diagnostic. "
        "Install with: pip install ifcopenshell"
    ) from exc

from .scene_report import SceneReport

STAGE_NAME = "ifc_geometry_diagnostic"
"""The stage name recorded on every SceneReport entry this module produces."""

STATUS_RENDERABLE = "renderable"
STATUS_EMPTY = "empty"
STATUS_FAILED = "failed"
STATUS_NO_REPRESENTATION = "no_representation"

VALID_STATUSES = frozenset({
    STATUS_RENDERABLE,        # A non-empty shape was produced.
    STATUS_EMPTY,             # A shape was produced but has 0 vertices or 0 faces.
    STATUS_FAILED,            # The element declares a Representation, but no
                               # shape for it was ever yielded by the iterator.
    STATUS_NO_REPRESENTATION, # The element has no Representation at all
                               # (expected/normal for many non-geometric
                               # IfcProduct subtypes, e.g. IfcProject-level
                               # organizational entities) -- not a failure.
})
"""Known values for ElementGeometryDiagnostic.status."""


@dataclass
class ElementGeometryDiagnostic:
    """Diagnostic result for exactly one IfcProduct entity.

    Fields
    ------
    global_id
        The element's IFC GlobalId.
    ifc_type
        The element's IFC entity type (e.g. "IfcWallStandardCase").
    status
        One of VALID_STATUSES -- see the constants above for what each
        means.
    vertex_count
        Number of vertices in the produced shape. 0 if status is not
        "renderable" or "empty" (i.e. no shape was produced at all).
    face_count
        Number of triangular faces in the produced shape. 0 under the
        same conditions as vertex_count.
    has_native_style
        True if the iterator found an authored IFC style/material on
        this element (with APPLY_DEFAULT_MATERIALS disabled, so this
        reflects what the source document actually declared, not a
        synthesized fallback). Always False if no shape was produced.
    native_color
        [r, g, b] color (0.0-1.0 range) read from the native style, if
        has_native_style is True. None otherwise.
    message
        Optional human-readable explanation, populated for non-renderable
        statuses (e.g. why an element is classified "failed").
    """

    global_id: str
    ifc_type: str
    status: str
    vertex_count: int = 0
    face_count: int = 0
    has_native_style: bool = False
    native_color: Optional[List[float]] = None
    message: Optional[str] = None

    def __post_init__(self) -> None:
        """Validate status against the known set eagerly, so a typo in a
        status string fails loudly at construction time rather than
        silently producing a diagnostic entry no aggregation code
        recognizes.
        """
        if self.status not in VALID_STATUSES:
            raise ValueError(
                f"ElementGeometryDiagnostic for '{self.global_id}': status "
                f"must be one of {sorted(VALID_STATUSES)}, got {self.status!r}."
            )

    def to_dict(self) -> Dict[str, Any]:
        """Serialize this diagnostic entry to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)


@dataclass
class IfcTypeGeometryStats:
    """Aggregate geometry diagnostic statistics for one IFC type
    (e.g. all "IfcWallStandardCase" elements considered together).

    Fields
    ------
    ifc_type
        The IFC entity type this record aggregates.
    total_count
        Total number of elements of this type that were examined.
    renderable_count / empty_count / failed_count / no_representation_count
        Counts of elements of this type in each status.
    with_native_style_count
        Number of elements of this type that have an authored native
        style (regardless of renderable/empty/failed status).
    total_vertex_count / total_face_count
        Sum of vertex/face counts across all "renderable" elements of
        this type (empty/failed/no_representation elements contribute 0).
    min_vertex_count / max_vertex_count / avg_vertex_count
        Vertex-count distribution across "renderable" elements of this
        type. None if there are no renderable elements of this type.
    min_face_count / max_face_count / avg_face_count
        Face-count distribution across "renderable" elements of this
        type. None if there are no renderable elements of this type.
    """

    ifc_type: str
    total_count: int = 0
    renderable_count: int = 0
    empty_count: int = 0
    failed_count: int = 0
    no_representation_count: int = 0
    with_native_style_count: int = 0
    total_vertex_count: int = 0
    total_face_count: int = 0
    min_vertex_count: Optional[int] = None
    max_vertex_count: Optional[int] = None
    avg_vertex_count: Optional[float] = None
    min_face_count: Optional[int] = None
    max_face_count: Optional[int] = None
    avg_face_count: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        """Serialize these stats to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)


@dataclass
class GeometryDiagnosticResult:
    """The complete output of running the IFC Geometry Diagnostic.

    Fields
    ------
    report
        The SceneReport accumulated during this diagnostic run. Every
        entry produced by this module has stage == "ifc_geometry_diagnostic".
    elements
        One ElementGeometryDiagnostic per examined IfcProduct entity.
    by_type
        Aggregate IfcTypeGeometryStats, keyed by IFC type string.
    total_products
        Total number of IfcProduct entities examined.
    renderable_count / empty_count / failed_count / no_representation_count
        Scene-wide totals across all elements, mirroring the per-type
        breakdown in `by_type` but summed across every type -- provided
        directly so a caller doesn't have to sum `by_type` themselves for
        the common "how many elements overall are renderable" question.
    """

    report: SceneReport
    elements: List[ElementGeometryDiagnostic] = field(default_factory=list)
    by_type: Dict[str, IfcTypeGeometryStats] = field(default_factory=dict)
    total_products: int = 0
    renderable_count: int = 0
    empty_count: int = 0
    failed_count: int = 0
    no_representation_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the full diagnostic result to a plain, JSON-safe dict."""
        return {
            "report": self.report.to_dict(),
            "elements": [e.to_dict() for e in self.elements],
            "by_type": {k: v.to_dict() for k, v in self.by_type.items()},
            "total_products": self.total_products,
            "renderable_count": self.renderable_count,
            "empty_count": self.empty_count,
            "failed_count": self.failed_count,
            "no_representation_count": self.no_representation_count,
        }


def _extract_native_style(shape: Any) -> "tuple[bool, Optional[List[float]]]":
    """Determine whether a produced shape carries an authored native
    IFC style, and its color if so.

    Mirrors the two-tier extraction scene_merger.py uses (modern
    ``shape.styles`` first, older ``shape.geometry.materials`` as
    fallback), but purely for detection/reporting -- nothing here bakes
    a color into any geometry. Never raises: any failure during
    inspection is treated as "no native style found" rather than
    propagated, since a style-reading hiccup on one element shouldn't
    abort the whole diagnostic scan.
    """
    try:
        if hasattr(shape, "styles") and shape.styles:
            style = shape.styles[0]
            if style and len(style) >= 3 and any(c is not None for c in style[:3]):
                return True, [float(c) for c in style[:3]]
    except Exception:
        pass

    try:
        if hasattr(shape, "geometry") and hasattr(shape.geometry, "materials"):
            materials = shape.geometry.materials
            if materials:
                diffuse = getattr(materials[0], "diffuse", None)
                if diffuse and len(diffuse) >= 3:
                    return True, [float(c) for c in diffuse[:3]]
    except Exception:
        pass

    return False, None


def _has_representation(entity: Any) -> bool:
    """Return True if ``entity`` declares a non-None Representation.

    This is a cheap attribute check (no geometry creation), used to tell
    apart "geometry creation was attempted but failed" (status FAILED)
    from "this element was never meant to have geometry" (status
    NO_REPRESENTATION) for elements the iterator never yields a shape
    for.
    """
    try:
        return getattr(entity, "Representation", None) is not None
    except Exception:
        return False


def _update_type_stats(
    stats: IfcTypeGeometryStats, diag: ElementGeometryDiagnostic
) -> None:
    """Fold one ElementGeometryDiagnostic into its IfcTypeGeometryStats,
    in place, recomputing the min/max/avg vertex and face counts.

    Kept as a small standalone function (rather than inlined in the main
    loop) so the aggregation logic itself -- which is a little fiddly
    around "None means no renderable elements yet" -- is easy to read
    and test in isolation.
    """
    stats.total_count += 1

    if diag.has_native_style:
        stats.with_native_style_count += 1

    if diag.status == STATUS_RENDERABLE:
        stats.renderable_count += 1
        stats.total_vertex_count += diag.vertex_count
        stats.total_face_count += diag.face_count

        stats.min_vertex_count = (
            diag.vertex_count
            if stats.min_vertex_count is None
            else min(stats.min_vertex_count, diag.vertex_count)
        )
        stats.max_vertex_count = (
            diag.vertex_count
            if stats.max_vertex_count is None
            else max(stats.max_vertex_count, diag.vertex_count)
        )
        stats.avg_vertex_count = stats.total_vertex_count / stats.renderable_count

        stats.min_face_count = (
            diag.face_count
            if stats.min_face_count is None
            else min(stats.min_face_count, diag.face_count)
        )
        stats.max_face_count = (
            diag.face_count
            if stats.max_face_count is None
            else max(stats.max_face_count, diag.face_count)
        )
        stats.avg_face_count = stats.total_face_count / stats.renderable_count

    elif diag.status == STATUS_EMPTY:
        stats.empty_count += 1
    elif diag.status == STATUS_FAILED:
        stats.failed_count += 1
    elif diag.status == STATUS_NO_REPRESENTATION:
        stats.no_representation_count += 1


def run_geometry_diagnostic(
    ifc_path: str,
    report: Optional[SceneReport] = None,
) -> GeometryDiagnosticResult:
    """Run the IFC Geometry Diagnostic over an IFC file.

    This is the sole entry point for this stage. It opens ``ifc_path``,
    enumerates every IfcProduct entity, runs ifcopenshell.geom.iterator()
    to see which of them actually produce shapes, and classifies each one
    as renderable / empty / failed / no_representation. It creates no
    RenderNodes, populates no GeometryData, and exports nothing.

    Parameters
    ----------
    ifc_path
        Filesystem path to the IFC file to inspect.
    report
        An existing SceneReport to append diagnostic entries into,
        instead of creating a new one. Useful for composing this stage's
        output into a larger, multi-stage diagnostic report later without
        losing entries from earlier stages. If omitted, a fresh
        SceneReport is created.

    Returns
    -------
    GeometryDiagnosticResult
        Always returned, even on failure to open the file -- callers
        should check ``result.report.has_errors()`` rather than expect an
        exception for ordinary document/geometry problems. This function
        only raises for genuinely exceptional situations (e.g.
        ``ifc_path`` is not even a string).
    """
    if not isinstance(ifc_path, str) or not ifc_path:
        raise ValueError("ifc_path must be a non-empty string.")

    active_report = report if report is not None else SceneReport()
    result = GeometryDiagnosticResult(report=active_report)

    if not os.path.exists(ifc_path):
        active_report.error(STAGE_NAME, f"IFC file not found: {ifc_path}")
        return result

    try:
        ifc_file = ifcopenshell.open(ifc_path)
    except Exception as exc:
        active_report.error(
            STAGE_NAME,
            f"Failed to open IFC file '{ifc_path}': {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    try:
        products = ifc_file.by_type("IfcProduct")
    except Exception as exc:
        active_report.error(
            STAGE_NAME,
            f"Could not enumerate IfcProduct entities: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    # global_id -> (entity, ifc_type). Built up front so every examined
    # element -- including ones the iterator never yields a shape for --
    # ends up represented in the final report exactly once.
    product_index: Dict[str, Any] = {}
    for entity in products:
        try:
            global_id = getattr(entity, "GlobalId", None)
        except Exception as exc:
            active_report.warning(
                STAGE_NAME,
                f"Could not read GlobalId for one IfcProduct entity: {exc}",
                metadata={"exception_type": type(exc).__name__},
            )
            continue
        if not global_id:
            active_report.warning(
                STAGE_NAME,
                f"Skipping an IfcProduct entity (id={entity.id() if hasattr(entity, 'id') else '?'}) "
                f"with no GlobalId.",
            )
            continue
        product_index[global_id] = entity

    result.total_products = len(product_index)
    active_report.info(
        STAGE_NAME,
        f"Found {result.total_products} IfcProduct entity(ies) to examine.",
        metadata={"count": result.total_products},
    )

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, True)
    # Deliberately False -- see module docstring "Why
    # APPLY_DEFAULT_MATERIALS is set to False here."
    settings.set(settings.APPLY_DEFAULT_MATERIALS, False)

    diagnostics_by_global_id: Dict[str, ElementGeometryDiagnostic] = {}

    try:
        iterator = ifcopenshell.geom.iterator(
            settings, ifc_file, num_threads=os.cpu_count() or 2
        )
    except Exception as exc:
        active_report.error(
            STAGE_NAME,
            f"Could not construct geometry iterator: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    if not iterator.initialize():
        active_report.warning(
            STAGE_NAME,
            "Geometry iterator found nothing to process (initialize() "
            "returned False). Every IfcProduct with a Representation "
            "will be classified as 'failed'; every one without will be "
            "classified as 'no_representation'.",
        )
    else:
        while True:
            shape = iterator.get()
            try:
                entity = ifc_file.by_id(shape.id)
                global_id = getattr(entity, "GlobalId", None) or f"elem_{shape.id}"
                ifc_type = entity.is_a()

                verts = shape.geometry.verts
                faces = shape.geometry.faces
                vertex_count = len(verts) // 3
                face_count = len(faces) // 3

                has_style, native_color = _extract_native_style(shape)

                status = STATUS_EMPTY if (vertex_count == 0 or face_count == 0) else STATUS_RENDERABLE

                diag = ElementGeometryDiagnostic(
                    global_id=global_id,
                    ifc_type=ifc_type,
                    status=status,
                    vertex_count=vertex_count,
                    face_count=face_count,
                    has_native_style=has_style,
                    native_color=native_color,
                    message=(
                        None
                        if status == STATUS_RENDERABLE
                        else "Shape produced but has zero vertices or zero faces."
                    ),
                )
                diagnostics_by_global_id[global_id] = diag

                if status == STATUS_EMPTY:
                    active_report.warning(
                        STAGE_NAME,
                        f"Empty mesh produced for {ifc_type} '{global_id}' "
                        f"(vertices={vertex_count}, faces={face_count}).",
                        element_id=global_id,
                        metadata={"ifc_type": ifc_type},
                    )
            except Exception as exc:
                active_report.warning(
                    STAGE_NAME,
                    f"Error while inspecting a produced shape (source "
                    f"element id={getattr(shape, 'id', '?')}): {exc}",
                    metadata={"exception_type": type(exc).__name__},
                )

            if not iterator.next():
                break

    # Second pass: classify every enumerated IfcProduct that the iterator
    # never produced a shape for, as either FAILED (representation exists
    # but no shape came out) or NO_REPRESENTATION (no representation was
    # ever declared -- expected for many non-geometric IfcProduct types).
    for global_id, entity in product_index.items():
        if global_id in diagnostics_by_global_id:
            continue

        try:
            ifc_type = entity.is_a()
        except Exception:
            ifc_type = "UnknownType"

        if _has_representation(entity):
            diag = ElementGeometryDiagnostic(
                global_id=global_id,
                ifc_type=ifc_type,
                status=STATUS_FAILED,
                message=(
                    "Element declares a Representation, but the geometry "
                    "iterator never produced a shape for it. This "
                    "typically indicates a geometry-creation failure "
                    "(e.g. unsupported representation type, degenerate "
                    "profile) rather than an intentionally non-geometric "
                    "element."
                ),
            )
            active_report.error(
                STAGE_NAME,
                f"Geometry creation failed for {ifc_type} '{global_id}': "
                f"a Representation is declared but no shape was produced.",
                element_id=global_id,
                metadata={"ifc_type": ifc_type},
            )
        else:
            diag = ElementGeometryDiagnostic(
                global_id=global_id,
                ifc_type=ifc_type,
                status=STATUS_NO_REPRESENTATION,
                message="Element has no Representation; no geometry was ever authored for it.",
            )
            active_report.info(
                STAGE_NAME,
                f"{ifc_type} '{global_id}' has no geometric representation.",
                element_id=global_id,
                metadata={"ifc_type": ifc_type},
            )

        diagnostics_by_global_id[global_id] = diag

    result.elements = list(diagnostics_by_global_id.values())

    for diag in result.elements:
        type_stats = result.by_type.setdefault(
            diag.ifc_type, IfcTypeGeometryStats(ifc_type=diag.ifc_type)
        )
        _update_type_stats(type_stats, diag)

        if diag.status == STATUS_RENDERABLE:
            result.renderable_count += 1
        elif diag.status == STATUS_EMPTY:
            result.empty_count += 1
        elif diag.status == STATUS_FAILED:
            result.failed_count += 1
        elif diag.status == STATUS_NO_REPRESENTATION:
            result.no_representation_count += 1

    active_report.info(
        STAGE_NAME,
        f"Geometry diagnostic complete: {result.renderable_count} renderable, "
        f"{result.empty_count} empty, {result.failed_count} failed, "
        f"{result.no_representation_count} without representation, across "
        f"{len(result.by_type)} IFC type(s).",
        metadata={
            "renderable_count": result.renderable_count,
            "empty_count": result.empty_count,
            "failed_count": result.failed_count,
            "no_representation_count": result.no_representation_count,
            "type_count": len(result.by_type),
        },
    )

    return result