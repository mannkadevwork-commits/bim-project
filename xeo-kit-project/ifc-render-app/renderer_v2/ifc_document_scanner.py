"""
renderer_v2.ifc_document_scanner
====================================

Implements the IFC Document Scanner: the first stage of the V2 pipeline.

This stage inspects the IFC *document itself* -- schema version, header
provenance (application/author/organization), the IfcProject/IfcSite/
IfcBuilding hierarchy, building storeys, units, and (if declared) the
model's geometric representation context/coordinate system -- and nothing
else. It is deliberately blind to shape geometry: it never touches
IfcExtrudedAreaSolid, ProductDefinitionShape, ShapeRepresentation, or
anything reachable only through ifcopenshell.geom.iterator(). That is the
Geometry Extractor's job, in a later PR.

Why this stage exists as a separate first step
-------------------------------------------------
The current V1 renderer's only diagnostic when geometry extraction fails
is a single opaque ``ValueError: No renderable structural geometry found``,
with no way to tell whether the problem is "the IFC file itself is
malformed/empty" versus "the file is fine but geometry extraction failed."
This stage answers that question first and separately: if the document is
missing an IfcProject, has zero building storeys, or won't even open, that
is surfaced here -- structurally, per-field -- before any geometry code
runs at all.

This module is the only place in renderer_v2 that imports ifcopenshell.
It does not import ifcopenshell.geom, and it never calls
ifcopenshell.geom.iterator() -- both are reserved for the Geometry
Extractor stage.
"""

from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

try:
    import ifcopenshell
except ImportError as exc:  # pragma: no cover - exercised only when the
    # optional dependency is genuinely absent.
    raise ImportError(
        "ifcopenshell is required for renderer_v2.ifc_document_scanner. "
        "Install with: pip install ifcopenshell"
    ) from exc

from .render_scene import RenderScene
from .scene_report import SceneReport

STAGE_NAME = "ifc_document_scanner"
"""The stage name recorded on every SceneReport entry this module produces."""


@dataclass
class ValidationResult:
    """Pass/fail verdict for one document scan, plus the counts behind it.

    Fields
    ------
    is_valid
        True if the document scan completed without any ERROR-severity
        diagnostic (e.g. the file opened and an IfcProject was found).
        A document can be "valid" and still have warnings (e.g. no
        building storeys) -- validity here means "the pipeline can
        reasonably proceed to geometry extraction," not "the model is
        perfect."
    error_count
        Number of ERROR-severity entries recorded during the scan.
    warning_count
        Number of WARNING-severity entries recorded during the scan.
    reasons
        Human-readable messages for every ERROR-severity entry, copied
        out of the SceneReport for convenience -- so a caller can check
        ``validation.is_valid`` and ``validation.reasons`` without also
        having to filter ``report.entries`` themselves.
    """

    is_valid: bool
    error_count: int = 0
    warning_count: int = 0
    reasons: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize this validation result to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)


@dataclass
class DocumentScanResult:
    """The complete output of scanning one IFC document.

    Fields
    ------
    scene
        A RenderScene with no nodes, no geometry, and no materials --
        this stage does not create any of those. Only
        ``scene.metadata_store`` and ``scene.statistics.warnings`` /
        ``scene.statistics.errors`` are populated. The scene is still
        returned (rather than metadata alone) so this stage's output can
        be handed directly to the next pipeline stage, which will add
        nodes to the same scene rather than merge two separate objects.
    report
        The SceneReport accumulated during this scan. Every entry has
        ``stage == "ifc_document_scanner"``.
    header_metadata
        The same document-level facts also written into
        ``scene.metadata_store``, returned here directly as well so a
        caller who only cares about metadata (e.g. a UI showing "Project:
        X, Schema: IFC4") doesn't need to reach through the scene object.
    validation
        The pass/fail verdict for this scan.
    """

    scene: RenderScene
    report: SceneReport
    header_metadata: Dict[str, Any]
    validation: ValidationResult

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the full scan result to a plain, JSON-safe dict."""
        return {
            "scene": self.scene.to_dict(),
            "report": self.report.to_dict(),
            "header_metadata": self.header_metadata,
            "validation": self.validation.to_dict(),
        }


def _safe_str(value: Any) -> Optional[str]:
    """Coerce an IFC attribute value into a plain, trimmed string or None.

    IFC STEP header fields (author, organization) are frequently lists of
    strings rather than a single string, and IFC attributes in general are
    often ``None`` for optional fields that weren't authored. This
    normalizes both cases into either a clean string or None, so every
    extraction function below can treat "the value wasn't provided" as a
    single, consistent case (None) instead of also having to check for
    empty strings/lists/whitespace at every call site.
    """
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        parts = [str(v).strip() for v in value if v is not None and str(v).strip()]
        return ", ".join(parts) if parts else None
    text = str(value).strip()
    return text or None


def _extract_header_info(
    ifc_file: "ifcopenshell.file", report: SceneReport
) -> Dict[str, Optional[str]]:
    """Extract STEP header provenance: author, organization, timestamp,
    preprocessor/originating-system strings, and the header's own file
    name/description text.

    These come from the IFC file's STEP header (FILE_NAME / FILE_DESCRIPTION
    entities), which is distinct from -- and always present alongside --
    any IfcApplication entity in the data section. Both are captured; this
    function only handles the header, not IfcApplication (see
    ``_extract_application_info``).

    Never raises: any failure to read a specific header field is recorded
    as a WARNING and that field is left as None, since a malformed or
    partially-authored header should not block the rest of the scan.
    """
    result: Dict[str, Optional[str]] = {
        "header_file_name": None,
        "header_timestamp": None,
        "author": None,
        "organization": None,
        "preprocessor_version": None,
        "originating_system": None,
        "file_description": None,
    }

    try:
        header = ifc_file.wrapped_data.header
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not access IFC STEP header: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    try:
        file_name = header.file_name
        result["header_file_name"] = _safe_str(getattr(file_name, "name", None))
        result["header_timestamp"] = _safe_str(getattr(file_name, "time_stamp", None))
        result["author"] = _safe_str(getattr(file_name, "author", None))
        result["organization"] = _safe_str(getattr(file_name, "organization", None))
        result["preprocessor_version"] = _safe_str(
            getattr(file_name, "preprocessor_version", None)
        )
        result["originating_system"] = _safe_str(
            getattr(file_name, "originating_system", None)
        )
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not read FILE_NAME header fields: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )

    try:
        file_description = header.file_description
        result["file_description"] = _safe_str(
            getattr(file_description, "description", None)
        )
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not read FILE_DESCRIPTION header field: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )

    return result


def _extract_application_info(
    ifc_file: "ifcopenshell.file", report: SceneReport
) -> Dict[str, Optional[str]]:
    """Extract application name/version/developer from IfcApplication.

    Preferred over the STEP header's ``originating_system`` field when
    available, since IfcApplication is a structured data-section entity
    (ApplicationFullName, Version, ApplicationDeveloper) rather than free
    text. If no IfcApplication entity exists, this returns all-None
    fields and records an INFO entry (not a warning -- IfcApplication is
    common but not required by the schema, so its absence is not itself
    a problem worth escalating).
    """
    result: Dict[str, Optional[str]] = {
        "application_name": None,
        "application_version": None,
        "application_developer": None,
    }

    try:
        applications = ifc_file.by_type("IfcApplication")
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not query IfcApplication entities: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    if not applications:
        report.info(STAGE_NAME, "No IfcApplication entity found in document.")
        return result

    app = applications[0]
    if len(applications) > 1:
        report.info(
            STAGE_NAME,
            f"Multiple IfcApplication entities found ({len(applications)}); "
            f"using the first.",
            metadata={"count": len(applications)},
        )

    try:
        result["application_name"] = _safe_str(getattr(app, "ApplicationFullName", None))
        result["application_version"] = _safe_str(getattr(app, "Version", None))
        developer = getattr(app, "ApplicationDeveloper", None)
        developer_name = getattr(developer, "Name", None) if developer is not None else None
        result["application_developer"] = _safe_str(developer_name)
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not read IfcApplication fields: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )

    return result


def _get_first_entity(
    ifc_file: "ifcopenshell.file", ifc_type: str, report: SceneReport
) -> Optional[Any]:
    """Return the first entity of ``ifc_type``, or None with a WARNING
    logged if none exists (not an ERROR -- only IfcProject's absence is
    treated as document-invalidating; IfcSite/IfcBuilding missing is
    common in partial/in-progress models).

    Never raises: a query failure is recorded as a WARNING and None is
    returned, consistent with every other extraction helper in this module.
    """
    try:
        entities = ifc_file.by_type(ifc_type)
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not query {ifc_type} entities: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return None

    if not entities:
        report.warning(STAGE_NAME, f"No {ifc_type} entity found in document.")
        return None

    if len(entities) > 1:
        report.info(
            STAGE_NAME,
            f"Multiple {ifc_type} entities found ({len(entities)}); using the first.",
            metadata={"count": len(entities)},
        )

    return entities[0]


def _extract_project_hierarchy(
    ifc_file: "ifcopenshell.file", report: SceneReport
) -> Dict[str, Any]:
    """Extract IfcProject, IfcSite, IfcBuilding names and the list of
    IfcBuildingStorey names.

    IfcProject's absence is the one condition this whole module treats as
    an ERROR (not a warning) -- every other piece of document metadata is
    optional in practice, but a document with no IfcProject at all is not
    a usable BIM model for this pipeline's purposes, and PR-3A's spec
    explicitly calls this out as an ERROR-level diagnostic.
    """
    result: Dict[str, Any] = {
        "project_name": None,
        "site_name": None,
        "building_name": None,
        "building_storeys": [],
    }

    try:
        projects = ifc_file.by_type("IfcProject")
    except Exception as exc:
        report.error(
            STAGE_NAME,
            f"Could not query IfcProject entities: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    if not projects:
        report.error(STAGE_NAME, "No IfcProject entity found in document.")
        return result

    project = projects[0]
    if len(projects) > 1:
        report.warning(
            STAGE_NAME,
            f"Multiple IfcProject entities found ({len(projects)}); using "
            f"the first. A well-formed IFC file should contain exactly one.",
            metadata={"count": len(projects)},
        )

    try:
        result["project_name"] = _safe_str(getattr(project, "Name", None))
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not read IfcProject.Name: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )

    site = _get_first_entity(ifc_file, "IfcSite", report)
    if site is not None:
        try:
            result["site_name"] = _safe_str(getattr(site, "Name", None))
        except Exception as exc:
            report.warning(
                STAGE_NAME,
                f"Could not read IfcSite.Name: {exc}",
                metadata={"exception_type": type(exc).__name__},
            )

    building = _get_first_entity(ifc_file, "IfcBuilding", report)
    if building is not None:
        try:
            result["building_name"] = _safe_str(getattr(building, "Name", None))
        except Exception as exc:
            report.warning(
                STAGE_NAME,
                f"Could not read IfcBuilding.Name: {exc}",
                metadata={"exception_type": type(exc).__name__},
            )

    try:
        storeys = ifc_file.by_type("IfcBuildingStorey")
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not query IfcBuildingStorey entities: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        storeys = []

    if not storeys:
        report.warning(STAGE_NAME, "No building storeys found.")
    else:
        storey_names: List[str] = []
        for storey in storeys:
            try:
                storey_name = _safe_str(getattr(storey, "Name", None))
            except Exception as exc:
                report.warning(
                    STAGE_NAME,
                    f"Could not read a IfcBuildingStorey.Name: {exc}",
                    metadata={"exception_type": type(exc).__name__},
                )
                storey_name = None
            storey_names.append(storey_name or "(unnamed storey)")
        result["building_storeys"] = storey_names
        report.info(
            STAGE_NAME,
            f"Found {len(storey_names)} building storey(s).",
            metadata={"count": len(storey_names)},
        )

    return result


def _unit_to_string(unit: Any) -> Optional[str]:
    """Render one IfcUnit entity as a short human-readable string, e.g.
    "METRE", "MILLI METRE", or "FOOT (conversion-based)".

    Handles the two common cases (IfcSIUnit and IfcConversionBasedUnit)
    and falls back to the entity's IFC type name for anything else,
    rather than raising on an unfamiliar unit representation.
    """
    if unit is None:
        return None
    try:
        ifc_class = unit.is_a()
    except Exception:
        return None

    if ifc_class == "IfcSIUnit":
        prefix = _safe_str(getattr(unit, "Prefix", None))
        name = _safe_str(getattr(unit, "Name", None))
        if not name:
            return None
        return f"{prefix} {name}" if prefix else name

    if ifc_class == "IfcConversionBasedUnit":
        name = _safe_str(getattr(unit, "Name", None))
        return f"{name} (conversion-based)" if name else "(conversion-based unit)"

    return f"({ifc_class})"


def _extract_units(
    ifc_file: "ifcopenshell.file", report: SceneReport
) -> Dict[str, Optional[str]]:
    """Extract the model's length, area, and volume units from
    IfcProject.UnitsInContext.

    This is document metadata (what units does the model claim to use),
    not a coordinate transform -- it does not read any shape geometry.
    """
    result: Dict[str, Optional[str]] = {
        "length_unit": None,
        "area_unit": None,
        "volume_unit": None,
    }

    try:
        projects = ifc_file.by_type("IfcProject")
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not query IfcProject for unit extraction: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    if not projects:
        # IfcProject's absence is already reported as an ERROR by
        # _extract_project_hierarchy; nothing further to add here.
        return result

    project = projects[0]

    try:
        units_in_context = getattr(project, "UnitsInContext", None)
        units = getattr(units_in_context, "Units", None) if units_in_context else None
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not read IfcProject.UnitsInContext: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return result

    if not units:
        report.warning(STAGE_NAME, "No units declared in IfcProject.UnitsInContext.")
        return result

    unit_type_map = {
        "LENGTHUNIT": "length_unit",
        "AREAUNIT": "area_unit",
        "VOLUMEUNIT": "volume_unit",
    }

    for unit in units:
        try:
            unit_type = getattr(unit, "UnitType", None)
        except Exception as exc:
            report.warning(
                STAGE_NAME,
                f"Could not read UnitType on a declared unit: {exc}",
                metadata={"exception_type": type(exc).__name__},
            )
            continue

        field_name = unit_type_map.get(unit_type)
        if field_name is None:
            continue  # Not a unit type this scan cares about (e.g. TIMEUNIT).

        rendered = _unit_to_string(unit)
        if rendered is not None:
            result[field_name] = rendered

    for label, field_name in unit_type_map.items():
        if result[field_name] is None:
            report.warning(STAGE_NAME, f"No {label.lower()} declared in document.")

    return result


def _extract_coordinate_system(
    ifc_file: "ifcopenshell.file", report: SceneReport
) -> Optional[Dict[str, Any]]:
    """Extract the model's declared world coordinate system, if any, from
    IfcGeometricRepresentationContext.

    This reads the *context* entity that declares where the model's
    origin and true-north direction are -- it does NOT read any
    IfcProductDefinitionShape, IfcShapeRepresentation, or per-element
    geometry, which stays entirely out of scope for this stage. If
    multiple contexts exist (common: one for "Model", one for "Plan"),
    the "Model" context is preferred; otherwise the first is used.
    """
    try:
        projects = ifc_file.by_type("IfcProject")
    except Exception:
        return None

    if not projects:
        return None

    try:
        contexts = getattr(projects[0], "RepresentationContexts", None) or []
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not read IfcProject.RepresentationContexts: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return None

    if not contexts:
        report.info(STAGE_NAME, "No geometric representation context declared.")
        return None

    chosen = None
    for ctx in contexts:
        try:
            if getattr(ctx, "ContextType", None) == "Model":
                chosen = ctx
                break
        except Exception:
            continue
    if chosen is None:
        chosen = contexts[0]

    try:
        wcs = getattr(chosen, "WorldCoordinateSystem", None)
        location = getattr(wcs, "Location", None) if wcs is not None else None
        coords = list(getattr(location, "Coordinates", [])) if location is not None else []

        true_north = getattr(chosen, "TrueNorth", None)
        true_north_dir = (
            list(getattr(true_north, "DirectionRatios", []))
            if true_north is not None
            else None
        )

        return {
            "context_type": _safe_str(getattr(chosen, "ContextType", None)),
            "coordinate_space_dimension": getattr(chosen, "CoordinateSpaceDimension", None),
            "precision": getattr(chosen, "Precision", None),
            "world_coordinate_system_origin": coords or None,
            "true_north_direction": true_north_dir,
        }
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not fully read geometric representation context: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return None


def _count_entities(ifc_file: "ifcopenshell.file", report: SceneReport) -> Optional[int]:
    """Count the total number of entity instances in the document.

    Tries the direct, exact method first (``len(ifc_file)``, supported by
    current ifcopenshell versions). If that's unavailable, falls back to
    counting IfcRoot-derived entities via ``by_type("IfcRoot")`` and
    records an INFO note that this is a rooted-entity count (it excludes
    non-rooted value/measure entities), so the number is understood to be
    a lower bound rather than mistaken for an exact total.
    """
    try:
        return len(ifc_file)
    except TypeError:
        pass
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not get exact entity count: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return None

    try:
        rooted = ifc_file.by_type("IfcRoot")
        report.info(
            STAGE_NAME,
            "Exact entity count unavailable in this ifcopenshell version; "
            "reporting count of IfcRoot-derived entities instead (a lower "
            "bound, excludes non-rooted value/measure entities).",
        )
        return len(rooted)
    except Exception as exc:
        report.warning(
            STAGE_NAME,
            f"Could not count entities by any method: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        return None


def scan_ifc_document(ifc_path: str) -> DocumentScanResult:
    """Open and inspect the document-level metadata of an IFC file.

    This is the sole entry point for the IFC Document Scanner stage. It
    opens ``ifc_path`` with ifcopenshell, extracts schema/header/project/
    unit/coordinate-system metadata, and returns a DocumentScanResult. It
    never extracts geometry, creates RenderNodes, or touches trimesh.

    Parameters
    ----------
    ifc_path
        Filesystem path to the IFC file to scan.

    Returns
    -------
    DocumentScanResult
        Always returned, even on failure to open the file -- callers
        should check ``result.validation.is_valid`` rather than expect an
        exception for ordinary document problems (missing IfcProject,
        malformed header fields, etc). This function only raises for
        genuinely exceptional situations (e.g. ``ifc_path`` is not even a
        string), not for problems with the IFC document's content.
    """
    if not isinstance(ifc_path, str) or not ifc_path:
        raise ValueError("ifc_path must be a non-empty string.")

    scene = RenderScene()
    report = SceneReport()
    header_metadata: Dict[str, Any] = {}

    if not os.path.exists(ifc_path):
        report.error(STAGE_NAME, f"IFC file not found: {ifc_path}")
        validation = ValidationResult(
            is_valid=False,
            error_count=1,
            warning_count=0,
            reasons=[f"IFC file not found: {ifc_path}"],
        )
        scene.metadata_store.update(header_metadata)
        scene.statistics.errors = 1
        scene.statistics.warnings = 0
        return DocumentScanResult(
            scene=scene,
            report=report,
            header_metadata=header_metadata,
            validation=validation,
        )

    try:
        ifc_file = ifcopenshell.open(ifc_path)
    except Exception as exc:
        report.error(
            STAGE_NAME,
            f"Failed to open IFC file '{ifc_path}': {exc}",
            metadata={"exception_type": type(exc).__name__},
        )
        validation = ValidationResult(
            is_valid=False,
            error_count=1,
            warning_count=0,
            reasons=[f"Failed to open IFC file '{ifc_path}': {exc}"],
        )
        scene.metadata_store.update(header_metadata)
        scene.statistics.errors = 1
        scene.statistics.warnings = 0
        return DocumentScanResult(
            scene=scene,
            report=report,
            header_metadata=header_metadata,
            validation=validation,
        )

    report.info(STAGE_NAME, f"Opened IFC successfully: {ifc_path}")

    try:
        schema = _safe_str(ifc_file.schema)
    except Exception as exc:
        schema = None
        report.warning(
            STAGE_NAME,
            f"Could not determine IFC schema: {exc}",
            metadata={"exception_type": type(exc).__name__},
        )

    if schema:
        report.info(STAGE_NAME, f"Schema = {schema}")
    else:
        report.warning(STAGE_NAME, "IFC schema could not be determined.")

    header_metadata["schema"] = schema
    header_metadata["source_file"] = ifc_path
    header_metadata.update(_extract_header_info(ifc_file, report))
    header_metadata.update(_extract_application_info(ifc_file, report))
    header_metadata.update(_extract_project_hierarchy(ifc_file, report))
    header_metadata.update(_extract_units(ifc_file, report))
    header_metadata["coordinate_system"] = _extract_coordinate_system(ifc_file, report)
    header_metadata["entity_count"] = _count_entities(ifc_file, report)

    entity_count = header_metadata.get("entity_count")
    if entity_count is not None:
        report.info(STAGE_NAME, f"Document contains {entity_count} entities.")

    scene.metadata_store.update(header_metadata)

    summary = report.summary()
    error_count = summary["counts"]["error"]
    warning_count = summary["counts"]["warning"]

    scene.statistics.errors = error_count
    scene.statistics.warnings = warning_count

    error_reasons = [
        entry.message for entry in report.entries if entry.severity == "error"
    ]

    validation = ValidationResult(
        is_valid=error_count == 0,
        error_count=error_count,
        warning_count=warning_count,
        reasons=error_reasons,
    )

    return DocumentScanResult(
        scene=scene,
        report=report,
        header_metadata=header_metadata,
        validation=validation,
    )