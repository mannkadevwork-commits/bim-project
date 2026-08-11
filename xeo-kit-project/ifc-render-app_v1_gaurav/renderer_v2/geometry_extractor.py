"""
renderer_v2.geometry_extractor
==============================
Implements the Geometry Extractor: the second stage of the V2 pipeline.

This module is responsible ONLY for extracting raw geometry from an IFC file
into reusable `GeometryData` objects. It is strictly forbidden from making
rendering decisions, calculating world transforms, resolving materials, or
baking colors into vertex data.

Geometry deduplication (instancing) is achieved natively by binary hashing the 
local vertex, face, normal, and UV arrays. Identical local geometry will share a
single `GeometryData` entry in the `RenderScene.geometry_store`.
"""

from __future__ import annotations
import array
import hashlib
import os
from typing import Any, Dict, List, Optional, Tuple

try:
    import ifcopenshell
    import ifcopenshell.geom
except ImportError as exc:
    raise ImportError(
        "ifcopenshell is required for renderer_v2.geometry_extractor. "
        "Install with: pip install ifcopenshell"
    ) from exc

from .render_scene import RenderScene
from .geometry_data import GeometryData
from .scene_report import SceneReport

STAGE_NAME = "geometry_extractor"

class GeometryExtractor:
    """Extracts raw mesh geometry from an IFC document into a RenderScene."""

    # Maintained locally, as the Scene Builder maps the whole document,
    # but the Extractor decides what actually gets geometry.
    SKIP_IFC_TYPES = frozenset({
        "IfcSpace", "IfcOpeningElement", "IfcSite", "IfcAnnotation",
        "IfcGrid", "IfcGridAxis",
    })

    def extract(
        self, 
        scene: RenderScene, 
        ifc_path: str,
        report: Optional[SceneReport] = None
    ) -> RenderScene:
        """Extract geometry for valid RenderNodes in the scene.

        Parameters
        ----------
        scene
            The canonical scene graph prepared by IfcSceneBuilder.
        ifc_path
            Filesystem path to the source IFC file.
        report
            An existing SceneReport to append diagnostics into. If omitted,
            a fresh SceneReport is created.

        Returns
        -------
        RenderScene
            The mutated scene with populated geometry_store and geometry_refs.
        """
        active_report = report if report is not None else SceneReport()

        if not os.path.exists(ifc_path):
            active_report.error(STAGE_NAME, f"IFC file not found: {ifc_path}")
            return scene

        try:
            ifc_file = ifcopenshell.open(ifc_path)
        except Exception as exc:
            active_report.error(
                STAGE_NAME,
                f"Failed to open IFC file '{ifc_path}': {exc}",
                metadata={"exception_type": type(exc).__name__}
            )
            return scene

        settings = ifcopenshell.geom.settings()
        # V2 Requirement: Extract local geometry to preserve instancing natively
        settings.set(settings.USE_WORLD_COORDS, False) 
        settings.set(settings.WELD_VERTICES, True)
        # V2 Requirement: Do not synthesize fallbacks; preserve raw native state
        settings.set(settings.APPLY_DEFAULT_MATERIALS, False)

        try:
            iterator = ifcopenshell.geom.iterator(
                settings, ifc_file, num_threads=os.cpu_count() or 2
            )
        except Exception as exc:
            active_report.error(
                STAGE_NAME,
                f"Could not construct geometry iterator: {exc}",
                metadata={"exception_type": type(exc).__name__}
            )
            return scene

        if not iterator.initialize():
            active_report.warning(STAGE_NAME, "Geometry iterator found nothing to process.")
            return scene

        # O(1) lookup map to associate raw ifcopenshell shapes with our V2 graph
        global_id_to_node = {
            node.global_id: node 
            for node in scene.nodes.values() 
            if node.global_id
        }

        while True:
            shape = iterator.get()
            try:
                # Fast path: use shape.guid natively available in modern ifcopenshell
                global_id = getattr(shape, "guid", None)
                ifc_type = "UnknownType"
                
                # Slow path fallback if shape.guid is missing
                if not global_id:
                    elem = ifc_file.by_id(shape.id)
                    global_id = getattr(elem, "GlobalId", None)
                    ifc_type = elem.is_a()

                # If the SceneBuilder didn't create a node, we discard the geometry.
                if not global_id or global_id not in global_id_to_node:
                    if not iterator.next():
                        break
                    continue

                node = global_id_to_node[global_id]
                
                # If we used the fast path, grab the ifc_type from the node
                if ifc_type == "UnknownType":
                    ifc_type = node.ifc_type or "UnknownType"

                if ifc_type in self.SKIP_IFC_TYPES:
                    active_report.warning(
                        STAGE_NAME,
                        f"Skipped IFC type {ifc_type}",
                        element_id=node.id,
                        metadata={"global_id": global_id, "ifc_type": ifc_type}
                    )
                    node.metadata["geometry_status"] = "skipped"
                    if not iterator.next():
                        break
                    continue

                verts = shape.geometry.verts
                faces = shape.geometry.faces

                if len(verts) == 0 or len(faces) == 0:
                    active_report.warning(
                        STAGE_NAME,
                        "Extracted empty mesh (0 vertices or 0 faces)",
                        element_id=node.id,
                        metadata={"global_id": global_id, "ifc_type": ifc_type}
                    )
                    node.metadata["geometry_status"] = "empty"
                    scene.statistics.empty_geometry_count += 1
                    if not iterator.next():
                        break
                    continue

                normals = getattr(shape.geometry, "normals", ())
                uvs = getattr(shape.geometry, "uvs", ())

                # Deterministic Binary Geometry Hashing
                geom_hash = self._hash_geometry(verts, faces, normals, uvs)
                geom_id = f"geom_{geom_hash[:16]}"

                # Instancing: Only process and store if the geometry is unique
                if geom_id not in scene.geometry_store:
                    native_color, native_material = self._extract_native_style(shape)
                    bbox, centroid = self._compute_bounds(verts)

                    # Repackage flat tuples into nested lists of [x, y, z] / [u, v]
                    v_list = [list(verts[i:i+3]) for i in range(0, len(verts), 3)]
                    f_list = [list(faces[i:i+3]) for i in range(0, len(faces), 3)]
                    n_list = [list(normals[i:i+3]) for i in range(0, len(normals), 3)] if normals else []
                    uv_list = [list(uvs[i:i+2]) for i in range(0, len(uvs), 2)] if uvs else []

                    geom_data = GeometryData(
                        id=geom_id,
                        vertices=v_list,
                        faces=f_list,
                        normals=n_list,
                        uvs=uv_list,
                        native_color=native_color,
                        native_material=native_material,
                        bbox=bbox,
                        metadata={"centroid": centroid}
                    )
                    
                    scene.geometry_store[geom_id] = geom_data

                    scene.statistics.geometry_count += 1
                    scene.statistics.vertex_count += len(v_list)
                    scene.statistics.triangle_count += len(f_list)

                # Link the node to the shared or newly created geometry
                node.geometry_ref = geom_id
                node.metadata["geometry_status"] = "extracted"

                active_report.info(
                    STAGE_NAME,
                    "Geometry successfully extracted",
                    element_id=node.id,
                    metadata={"global_id": global_id, "geometry_ref": geom_id}
                )

            except Exception as exc:
                active_report.error(
                    STAGE_NAME,
                    f"Extraction failure: {exc}",
                    element_id=node.id if 'node' in locals() else None,
                    metadata={
                        "global_id": global_id if 'global_id' in locals() else None,
                        "ifc_type": ifc_type if 'ifc_type' in locals() else None,
                        "exception_type": type(exc).__name__
                    }
                )
                if 'node' in locals():
                    node.metadata["geometry_status"] = "failed"

            if not iterator.next():
                break

        return scene

    def _hash_geometry(self, verts: tuple, faces: tuple, normals: tuple, uvs: tuple) -> str:
        """Deterministically hash binary mesh arrays using the standard library."""
        hasher = hashlib.sha256()
        
        # array('d') handles double precision floats, 'q' handles 64-bit signed integers
        hasher.update(array.array('d', verts).tobytes())
        hasher.update(array.array('q', faces).tobytes())
        
        if normals:
            hasher.update(array.array('d', normals).tobytes())
        if uvs:
            hasher.update(array.array('d', uvs).tobytes())
            
        return hasher.hexdigest()

    def _extract_native_style(self, shape: Any) -> Tuple[Optional[List[float]], Optional[Dict[str, Any]]]:
        """Safely extract native color and material properties."""
        diffuse = None
        transparency = 0.0
        native_material = {}

        try:
            # Modern shape.styles extraction
            if hasattr(shape, "styles") and shape.styles:
                style = shape.styles[0]
                if len(style) >= 3:
                    diffuse = [float(c) for c in style[:3]]
                if len(style) >= 4:
                    transparency = float(style[3])
            
            # Fallback to older geometry.materials extraction
            if not diffuse and hasattr(shape.geometry, "materials") and shape.geometry.materials:
                mat = shape.geometry.materials[0]
                d = getattr(mat, "diffuse", None)
                if d and len(d) >= 3:
                    diffuse = [float(c) for c in d[:3]]
                
                transparency = float(getattr(mat, "transparency", 0.0))
                name = getattr(mat, "name", None)
                if name:
                    native_material["name"] = name

        except Exception:
            pass

        native_color = None
        if diffuse:
            # Convert to [r, g, b, a] in 0.0-1.0 range
            native_color = diffuse + [max(0.0, 1.0 - transparency)]

        if transparency > 0.0:
            native_material["transparency"] = transparency

        return native_color, native_material if native_material else None

    def _compute_bounds(self, verts: tuple) -> Tuple[Dict[str, List[float]], List[float]]:
        """Compute Bounding Box and Centroid efficiently in pure Python."""
        x = verts[0::3]
        y = verts[1::3]
        z = verts[2::3]

        min_pt = [min(x), min(y), min(z)]
        max_pt = [max(x), max(y), max(z)]
        centroid = [sum(x) / len(x), sum(y) / len(y), sum(z) / len(z)]

        bbox = {"min": min_pt, "max": max_pt}
        return bbox, centroid