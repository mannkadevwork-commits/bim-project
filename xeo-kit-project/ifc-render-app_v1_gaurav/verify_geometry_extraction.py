#!/usr/bin/env python3
"""
verify_geometry_extraction.py
=============================
A standalone verification script to validate the V2 Geometry Extractor against 
an IFC file. It builds the scene, extracts geometry, and prints a structured 
comparison report.
"""

import sys
import os
from collections import Counter

from renderer_v2.ifc_scene_builder import IfcSceneBuilder
from renderer_v2.geometry_extractor import GeometryExtractor
from renderer_v2.scene_report import SceneReport


def verify_extraction(ifc_path: str) -> None:
    """Run the V2 pipeline stages and print a verification report."""
    
    if not os.path.exists(ifc_path):
        print(f"Error: IFC file not found at '{ifc_path}'")
        sys.exit(1)

    print(f"--- Starting V2 Verification for: {os.path.basename(ifc_path)} ---")
    
    # 1. Build Scene
    print("Running IfcSceneBuilder...")
    builder = IfcSceneBuilder()
    scene = builder.build(ifc_path)
    
    # 2. Extract Geometry
    print("Running GeometryExtractor...")
    extractor = GeometryExtractor()
    report = SceneReport()
    scene = extractor.extract(scene, ifc_path, report=report)
    
    # 3. Analyze Data
    total_nodes = len(scene.nodes)
    
    # Node geometry referencing
    nodes_with_geom = [n for n in scene.nodes.values() if n.geometry_ref]
    total_geom_refs = len(nodes_with_geom)
    unique_geoms = len(scene.geometry_store)
    
    # If total nodes referencing geometry is higher than unique geometries, instancing is working
    shared_geometries = total_geom_refs - unique_geoms
    
    # Status tracking via metadata
    statuses = Counter(n.metadata.get("geometry_status", "unknown") for n in scene.nodes.values())
    
    skipped_types = Counter(
        n.ifc_type for n in scene.nodes.values() 
        if n.metadata.get("geometry_status") == "skipped"
    )
    
    # Native Styles Detection
    styles_detected = sum(
        1 for g in scene.geometry_store.values() 
        if g.native_color is not None or g.native_material is not None
    )
    
    # 4. Print Structured Report
    print("\n" + "=" * 60)
    print(" V2 GEOMETRY EXTRACTION VERIFICATION REPORT")
    print("=" * 60)
    
    print("\n### 1. High-Level Node Metrics")
    print(f"  Total RenderNodes Created:     {total_nodes}")
    print(f"  Nodes with Renderable Geom:    {total_geom_refs}")
    
    print("\n### 2. Geometry Instancing & Storage")
    print(f"  Extracted GeometryData Entries:{unique_geoms}")
    print(f"  Shared/Instanced Geometries:   {shared_geometries} (Nodes sharing a mesh)")
    
    print("\n### 3. Mesh Statistics")
    print(f"  Total Vertex Count:            {scene.statistics.vertex_count}")
    print(f"  Total Triangle Count:          {scene.statistics.triangle_count}")
    print(f"  Native Styles Preserved:       {styles_detected} / {unique_geoms} unique meshes")
    
    print("\n### 4. Diagnostic Status Breakdown")
    print(f"  Successfully Extracted:        {statuses.get('extracted', 0)}")
    print(f"  Empty Meshes (0 verts/faces):  {statuses.get('empty', 0)}")
    print(f"  Failed Extractions:            {statuses.get('failed', 0)}")
    print(f"  Skipped Elements:              {statuses.get('skipped', 0)}")
    
    if skipped_types:
        print("\n### 5. Skipped IFC Types")
        for ifc_type, count in skipped_types.most_common():
            print(f"  - {ifc_type}: {count}")
            
    print("\n" + "=" * 60)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python verify_geometry_extraction.py <path_to_ifc_file>")
        sys.exit(1)
        
    verify_extraction(sys.argv[1])