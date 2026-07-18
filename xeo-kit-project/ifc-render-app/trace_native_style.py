#!/usr/bin/env python3
"""
trace_native_style.py
=====================
A raw debugging script to walk the IFC relationship graph step-by-step 
from an IfcProduct down to its IfcColourRGB definition.

Usage:
    python trace_native_style.py <path_to_ifc> <global_id>
"""

import sys

try:
    import ifcopenshell
except ImportError:
    print("Error: ifcopenshell is required. Install with: pip install ifcopenshell")
    sys.exit(1)


def print_step(entity, context: str) -> None:
    """Prints the raw state of an IFC entity."""
    if not entity:
        return

    print(f"\n{'-'*60}")
    print(f"STEP: {context}")
    print(f"{'-'*60}")
    print(f"IFC Type: {entity.is_a()}")
    print(f"STEP ID:  #{entity.id()}")
    print(f"Name:     {getattr(entity, 'Name', 'N/A')}")
    print("Attributes:")
    
    # Extract all attributes natively parsed by ifcopenshell
    info = entity.get_info()
    for key, value in info.items():
        if key in ("id", "type"):
            continue
            
        # Truncate overly long lists (like coordinate arrays) for readability
        val_str = str(value)
        if len(val_str) > 100:
            val_str = val_str[:97] + "..."
            
        print(f"  - {key}: {val_str}")


def check_surface_style(surface_style) -> None:
    """Inspects an IfcSurfaceStyle to find the target RGB colour."""
    styles = getattr(surface_style, "Styles", [])
    
    for rendering in styles:
        if not rendering:
            continue
            
        print_step(rendering, "Surface Style Element")
        
        if rendering.is_a("IfcSurfaceStyleRendering"):
            colour = getattr(rendering, "SurfaceColour", None)
            
            if colour and colour.is_a("IfcColourRgb"):
                print_step(colour, "Target Colour Found")
                print(f"\n" + "="*60)
                print(" 🎯 TARGET REACHED: IfcColourRGB")
                print("="*60)
                print(f"Red:   {colour.Red}")
                print(f"Green: {colour.Green}")
                print(f"Blue:  {colour.Blue}")
                print("="*60)
                # Stop script immediately upon finding the colour
                sys.exit(0)


def trace_graph(ifc_path: str, global_id: str) -> None:
    print(f"Opening IFC file: {ifc_path}")
    try:
        ifc = ifcopenshell.open(ifc_path)
    except Exception as e:
        print(f"Failed to open IFC: {e}")
        sys.exit(1)

    try:
        product = ifc.by_guid(global_id)
    except Exception:
        print(f"Could not find element with GlobalId: {global_id}")
        sys.exit(1)

    print_step(product, "Root Product")

    # 1. ProductDefinitionShape
    representation = getattr(product, "Representation", None)
    if not representation:
        print("\nElement has no Representation attribute. Stopping.")
        sys.exit(0)
        
    print_step(representation, "Product Definition Shape")

    # 2. ShapeRepresentations
    reps = getattr(representation, "Representations", [])
    for shape_rep in reps:
        if not shape_rep:
            continue
            
        print_step(shape_rep, "Shape Representation")

        # 3. RepresentationItems
        items = getattr(shape_rep, "Items", [])
        for item in items:
            if not item:
                continue
                
            print_step(item, "Representation Item")

            # 4. StyledItems (Inverse relationship)
            styled_by = getattr(item, "StyledByItem", [])
            for styled_item in styled_by:
                if not styled_item or not styled_item.is_a("IfcStyledItem"):
                    continue
                    
                print_step(styled_item, "Styled Item")

                # 5. PresentationStyleAssignments / SurfaceStyles
                styles = getattr(styled_item, "Styles", [])
                for style in styles:
                    if not style:
                        continue
                        
                    print_step(style, "Assigned Style")

                    # IFC2x3 routing
                    if style.is_a("IfcPresentationStyleAssignment"):
                        sub_styles = getattr(style, "Styles", [])
                        for sub_style in sub_styles:
                            if sub_style and sub_style.is_a("IfcSurfaceStyle"):
                                print_step(sub_style, "Surface Style (via IFC2x3 Assignment)")
                                check_surface_style(sub_style)
                                
                    # IFC4 routing
                    elif style.is_a("IfcSurfaceStyle"):
                        check_surface_style(style)
                        
    print("\nGraph traversal complete. No IfcColourRGB was found for this element.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python trace_native_style.py <path_to_ifc> <global_id>")
        sys.exit(1)
        
    trace_graph(sys.argv[1], sys.argv[2])