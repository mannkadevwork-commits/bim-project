"""
renderer_v2.ifc_scene_builder
=============================
Implements the IFC Scene Builder: the foundational orchestrator for Renderer V2.

This stage is responsible for converting an IFC document into a canonical
`RenderScene` by invoking the `IfcDocumentScanner` and `IfcGeometryDiagnostic`
stages, and then enumerating every `IfcProduct` to create a corresponding
`RenderNode`.

Explicitly Out of Scope:
- Geometry extraction (handled by future Geometry Extractor).
- Material resolution (handled by future Material Resolver).
- Furniture loading (handled by future Furniture Resolver).
- World transform calculations.
- GLB/OBJ export.
- Numpy and Trimesh dependencies.
"""

from __future__ import annotations
import os
import uuid
from typing import Any, Dict, List, Optional

try:
    import ifcopenshell
except ImportError as exc:
    raise ImportError(
        "ifcopenshell is required for renderer_v2.ifc_scene_builder. "
        "Install with: pip install ifcopenshell"
    ) from exc

from .render_node import RenderNode, identity_matrix
from .render_scene import RenderScene
from .scene_report import SceneReport
from .ifc_document_scanner import scan_ifc_document
from .ifc_geometry_diagnostic import run_geometry_diagnostic

STAGE_NAME = "ifc_scene_builder"
"""The stage name recorded on every SceneReport entry this module produces."""


def _normalize_vector(v: List[float]) -> List[float]:
    """Pure Python vector normalization."""
    mag = sum(x * x for x in v) ** 0.5
    if mag == 0:
        return v
    return [x / mag for x in v]


def _cross_product(a: List[float], b: List[float]) -> List[float]:
    """Pure Python 3D cross product."""
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def _extract_local_transform(placement: Any) -> List[List[float]]:
    """Extract a 4x4 local transform matrix from an IfcLocalPlacement.
    
    Operates using pure Python lists of floats to avoid a numpy dependency.
    Calculates only the relative/local placement (RelativePlacement); 
    resolving the full world transform via PlacementRelTo is left to a 
    future Transform Resolver stage.
    """
    if not placement:
        return identity_matrix()
    
    try:
        rel_placement = getattr(placement, "RelativePlacement", None)
        if not rel_placement or rel_placement.is_a() != "IfcAxis2Placement3D":
            return identity_matrix()

        # Location -> Translation
        loc = getattr(rel_placement, "Location", None)
        origin = list(getattr(loc, "Coordinates", [0.0, 0.0, 0.0]))
        while len(origin) < 3:
            origin.append(0.0)

        # Axis -> Z Direction
        z_axis = getattr(rel_placement, "Axis", None)
        z_dir = list(getattr(z_axis, "DirectionRatios", [0.0, 0.0, 1.0])) if z_axis else [0.0, 0.0, 1.0]
        
        # RefDirection -> X Direction
        x_axis = getattr(rel_placement, "RefDirection", None)
        x_dir = list(getattr(x_axis, "DirectionRatios", [1.0, 0.0, 0.0])) if x_axis else [1.0, 0.0, 0.0]

        Z = _normalize_vector(z_dir)
        X = _normalize_vector(x_dir)
        Y = _normalize_vector(_cross_product(Z, X))
        
        # Recalculate X to ensure perfect orthogonality
        X = _normalize_vector(_cross_product(Y, Z))

        return [
            [X[0], Y[0], Z[0], origin[0]],
            [X[1], Y[1], Z[1], origin[1]],
            [X[2], Y[2], Z[2], origin[2]],
            [0.0,  0.0,  0.0,  1.0]
        ]
    except Exception:
        # Fallback safely if placement data is malformed
        return identity_matrix()


class IfcSceneBuilder:
    """Orchestrates the conversion of an IFC document into a RenderScene.

    This class serves as the canonical entry point into the V2 pipeline. It
    coordinates document scanning, geometry diagnostics, and the instantiation
    of the scene graph hierarchy, creating a foundation that subsequent stages
    mutate and extract data into.
    """

    def build(
        self, ifc_path: str, project_state: Optional[Dict[str, Any]] = None
    ) -> RenderScene:
        """Construct a RenderScene from an IFC file.

        Parameters
        ----------
        ifc_path
            Filesystem path to the source IFC file.
        project_state
            Optional JSON state (e.g., from project_state.json). Stored in the
            scene's metadata_store for downstream stages.

        Returns
        -------
        RenderScene
            The canonical scene graph containing a RenderNode for every
            IfcProduct, complete with hierarchical relationships, but without
            extracted geometry meshes or resolved materials.
        """
        # 1. Document Scanner (Initializes the scene and base metadata)
        scan_result = scan_ifc_document(ifc_path)
        scene = scan_result.scene
        report = scan_result.report

        # Store the project state centrally so downstream modules can consume it
        if project_state is not None:
            scene.metadata_store["project_state"] = project_state

        if not os.path.exists(ifc_path):
            return scene

        # 2. Geometry Diagnostic
        diag_result = run_geometry_diagnostic(ifc_path, report=report)
        geom_status_map = {
            elem.global_id: elem.status for elem in diag_result.elements
        }

        # 3. Open IFC document for structural parsing
        try:
            ifc_file = ifcopenshell.open(ifc_path)
        except Exception as exc:
            report.error(
                STAGE_NAME,
                f"Failed to open IFC file for scene building: {exc}",
                metadata={"exception_type": type(exc).__name__},
            )
            return scene

        # 4. Map IFC Hierarchy (Parent-Child tracking by GlobalId)
        parent_map: Dict[str, str] = {}

        def _map_hierarchy(relations: list, relating_attr: str, related_attr: str, single_child: bool = False) -> None:
            for rel in relations:
                try:
                    parent_obj = getattr(rel, relating_attr, None)
                    if not parent_obj:
                        continue
                    parent_gid = getattr(parent_obj, "GlobalId", None)
                    if not parent_gid:
                        continue
                    
                    if single_child:
                        child = getattr(rel, related_attr, None)
                        children = [child] if child else []
                    else:
                        children = getattr(rel, related_attr, [])

                    for child in children:
                        child_gid = getattr(child, "GlobalId", None)
                        if child_gid:
                            parent_map[child_gid] = parent_gid
                except Exception as exc:
                    report.warning(
                        STAGE_NAME,
                        f"Failed to parse hierarchy relation: {exc}",
                        metadata={"exception_type": type(exc).__name__},
                    )

        # Standard Spatial Structure
        _map_hierarchy(ifc_file.by_type("IfcRelAggregates"), "RelatingObject", "RelatedObjects")
        _map_hierarchy(ifc_file.by_type("IfcRelContainedInSpatialStructure"), "RelatingStructure", "RelatedElements")
        
        # Wall/Slab -> Opening -> Door/Window relationships
        _map_hierarchy(ifc_file.by_type("IfcRelVoidsElement"), "RelatingBuildingElement", "RelatedOpeningElement", single_child=True)
        _map_hierarchy(ifc_file.by_type("IfcRelFillsElement"), "RelatingOpeningElement", "RelatedBuildingElement", single_child=True)

        # 5. Graph Construction (Node creation)
        try:
            products = ifc_file.by_type("IfcProduct")
        except Exception as exc:
            report.error(
                STAGE_NAME,
                f"Could not enumerate IfcProduct entities: {exc}",
                metadata={"exception_type": type(exc).__name__},
            )
            return scene

        nodes_created = 0
        nodes_skipped = 0
        missing_global_ids = 0
        missing_placements = 0
        missing_hierarchy = 0

        gid_to_node_id: Dict[str, str] = {}

        # Pass A: Create every node and insert it into the scene flatly.
        for product in products:
            try:
                global_id = getattr(product, "GlobalId", None)
                if not global_id:
                    missing_global_ids += 1
                    nodes_skipped += 1
                    continue
                
                ifc_type = product.is_a()
                name = getattr(product, "Name", None) or global_id
                status = geom_status_map.get(global_id, "unknown")
                
                placement = getattr(product, "ObjectPlacement", None)
                if not placement:
                    missing_placements += 1
                    local_transform = identity_matrix()
                else:
                    local_transform = _extract_local_transform(placement)

                # Generate unique internal identity distinct from IFC GlobalId
                node_id = uuid.uuid4().hex
                gid_to_node_id[global_id] = node_id

                # Construct canonical node
                node = RenderNode(
                    id=node_id,
                    source_type="structural",
                    global_id=global_id,
                    instance_id=None,
                    name=name,
                    ifc_type=ifc_type,
                    coordinate_space="native",
                    local_transform=local_transform,
                )
                
                # Store geometry diagnostic status temporarily in metadata
                node.metadata["geometry_status"] = status
                
                scene.add_node(node)
                nodes_created += 1

            except Exception as exc:
                report.error(
                    STAGE_NAME,
                    f"Error creating node for product (id={getattr(product, 'id', '?')}): {exc}",
                    metadata={"exception_type": type(exc).__name__},
                )
                nodes_skipped += 1

        # Pass B: Wire relationships using GlobalId cross-references.
        for node in scene.nodes.values():
            if not node.global_id:
                continue
                
            parent_gid = parent_map.get(node.global_id)
            if parent_gid:
                parent_node_id = gid_to_node_id.get(parent_gid)
                if parent_node_id and parent_node_id in scene.nodes:
                    node.parent = parent_node_id
                    scene.nodes[parent_node_id].add_child(node.id)
                else:
                    missing_hierarchy += 1
            else:
                # IfcProject is historically the top root and doesn't subclass IfcProduct.
                missing_hierarchy += 1

        # 6. Aggregate Diagnostics
        scene.statistics.structural_nodes = nodes_created
        scene.statistics.total_nodes = len(scene.nodes)

        report.info(
            STAGE_NAME,
            f"IfcSceneBuilder complete: {nodes_created} nodes created, {nodes_skipped} skipped.",
            metadata={
                "nodes_created": nodes_created,
                "nodes_skipped": nodes_skipped,
                "missing_global_ids": missing_global_ids,
                "missing_placements": missing_placements,
                "missing_hierarchy": missing_hierarchy,
            },
        )

        return scene