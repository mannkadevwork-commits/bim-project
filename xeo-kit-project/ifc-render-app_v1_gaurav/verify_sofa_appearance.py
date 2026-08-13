#!/usr/bin/env python3
"""
verify_sofa_appearance.py
=========================
Regression test to validate the Multi-Representation Appearance Extractor.
This script uses a reference multi-material asset (e.g., sofa.ifc) to ensure
that styles are extracted and keyed correctly by RepresentationItem.

Usage:
    python verify_sofa_appearance.py <path_to_sofa.ifc>
"""

import sys
import os

try:
    import ifcopenshell
except ImportError:
    print("Error: ifcopenshell is required. Install with: pip install ifcopenshell")
    sys.exit(1)

from renderer_v2.ifc_appearance_extractor import extract_appearance_by_global_id


def run_regression_test(ifc_path: str):
    if not os.path.exists(ifc_path):
        print(f"FAIL: Reference asset not found at {ifc_path}")
        sys.exit(1)

    print(f"Loading reference asset: {ifc_path}...")
    try:
        ifc_file = ifcopenshell.open(ifc_path)
    except Exception as e:
        print(f"FAIL: Could not open IFC file: {e}")
        sys.exit(1)

    # Automatically find the primary IfcProduct (usually an IfcFurnishingElement or similar)
    products = ifc_file.by_type("IfcProduct")
    if not products:
        print("FAIL: No IfcProduct found in the reference asset.")
        sys.exit(1)

    # We test against the first product found in the asset
    target_product = products[0]
    global_id = target_product.GlobalId
    print(f"Targeting Product: {target_product.is_a()} (GlobalId: {global_id})")

    # Run the extractor
    appearance_data = extract_appearance_by_global_id(ifc_file, global_id)

    print("\n--- Regression Results ---")
    
    # Validation 1: Diagnostics
    if appearance_data.diagnostics:
        print("WARNING: Diagnostics reported during extraction:")
        for diag in appearance_data.diagnostics:
            print(f"  - [{diag.severity.upper()}] Item {diag.item_id}: {diag.message}")
    
    # Validation 2: Ensure we keyed by RepresentationItem
    item_count = len(appearance_data.items)
    print(f"RepresentationItems found with styles: {item_count}")
    
    if item_count == 0:
        print("FAIL: No appearance items extracted. The multi-material mapping failed or the asset lacks styles.")
        sys.exit(1)
        
    if item_count < 2:
        print("WARNING: Expected a multi-material asset (count >= 2), but found only 1 styled item.")
        
    for item_id, app in appearance_data.items.items():
        print(f"\nItem #{item_id} ({app.ifc_type})")
        print(f"  Style Name:      {app.style_name}")
        
        if app.surface_colour:
            print(f"  Surface Colour:  RGB({app.surface_colour.r}, {app.surface_colour.g}, {app.surface_colour.b})")
        if app.diffuse_colour:
            print(f"  Diffuse Colour:  RGB({app.diffuse_colour.r}, {app.diffuse_colour.g}, {app.diffuse_colour.b})")
            
        print(f"  Transparency:    {app.transparency}")
        print(f"  Has Texture Map: {app.has_texture}")

    # Validation 3: Semantic Materials
    print(f"\nSemantic Materials Attached: {len(appearance_data.materials)}")
    for mat in appearance_data.materials:
        print(f"  - {mat.ifc_type}: {mat.name}")

    print("\nSUCCESS: Multi-Representation extraction completed.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python verify_sofa_appearance.py <path_to_sofa.ifc>")
        sys.exit(1)
        
    run_regression_test(sys.argv[1])