#!/usr/bin/env python3
"""
trace_style_usage.py
====================
A diagnostic script that traverses the IFC graph backwards from a specific 
IfcSurfaceStyle (or any starting STEP ID) to discover which IfcProducts 
reference it.

It uses `get_inverse()` to discover the true relationship paths without 
assuming a specific schema version or hierarchy.

Usage:
    python trace_style_usage.py <path_to_ifc> <style_name_or_step_id>
    
Examples:
    python trace_style_usage.py model.ifc int_mb_bed_Style
    python trace_style_usage.py model.ifc #1622
"""

import sys

try:
    import ifcopenshell
except ImportError:
    print("Error: ifcopenshell is required. Install with: pip install ifcopenshell")
    sys.exit(1)


def format_entity(entity) -> str:
    """Formats an IFC entity into a readable string with its critical attributes."""
    step_id = f"#{entity.id()}"
    ifc_type = entity.is_a()
    name = getattr(entity, "Name", None)
    guid = getattr(entity, "GlobalId", None)

    details = []
    if name:
        details.append(f"Name='{name}'")
    if guid:
        details.append(f"GlobalId='{guid}'")

    if details:
        return f"{step_id} = {ifc_type}({', '.join(details)})"
    
    return f"{step_id} = {ifc_type}"


def find_targets(ifc_file: "ifcopenshell.file", identifier: str) -> list:
    """Locates the starting entities based on a STEP ID or a string Name."""
    targets = []
    
    # Lookup by STEP ID
    if identifier.startswith("#"):
        try:
            step_int = int(identifier[1:])
            entity = ifc_file.by_id(step_int)
            targets.append(entity)
        except Exception as e:
            print(f"Error finding STEP ID {identifier}: {e}")
    
    # Lookup by Name
    else:
        # Search all PresentationStyles (covers IfcSurfaceStyle, IfcCurveStyle, etc.)
        for style in ifc_file.by_type("IfcPresentationStyle"):
            if getattr(style, "Name", None) == identifier:
                targets.append(style)
                
    return targets


def trace_to_products(ifc_file: "ifcopenshell.file", start_entity) -> list:
    """
    Recursively traces inverse relationships to find all paths from the 
    start_entity up to any IfcProduct.
    """
    valid_paths = []

    def dfs(current_entity, current_path, visited_ids):
        current_path.append(current_entity)
        visited_ids.add(current_entity.id())

        # Success condition: We reached a product
        if current_entity.is_a("IfcProduct"):
            valid_paths.append(list(current_path))
        else:
            # Discover all entities that reference this one
            inverses = ifc_file.get_inverse(current_entity)
            for inv in inverses:
                if inv.id() not in visited_ids:
                    dfs(inv, current_path, visited_ids)

        # Backtrack
        visited_ids.remove(current_entity.id())
        current_path.pop()

    dfs(start_entity, [], set())
    return valid_paths


def main():
    if len(sys.argv) != 3:
        print("Usage: python trace_style_usage.py <path_to_ifc> <style_name_or_step_id>")
        sys.exit(1)

    ifc_path = sys.argv[1]
    target_identifier = sys.argv[2]

    print(f"Opening IFC file: {ifc_path}...")
    try:
        ifc_file = ifcopenshell.open(ifc_path)
    except Exception as e:
        print(f"Failed to open IFC: {e}")
        sys.exit(1)

    print(f"Searching for target: {target_identifier}...")
    targets = find_targets(ifc_file, target_identifier)

    if not targets:
        print(f"Could not find any entity matching '{target_identifier}'.")
        sys.exit(1)

    for i, target in enumerate(targets):
        print(f"\n{'='*70}")
        print(f" Target [{i+1}/{len(targets)}]: {format_entity(target)}")
        print(f"{'='*70}")

        paths = trace_to_products(ifc_file, target)

        if not paths:
            print("  No path found leading to an IfcProduct. This style may be orphaned.")
            continue

        print(f"  Found {len(paths)} path(s) to IfcProducts:\n")
        
        for path_idx, path in enumerate(paths, 1):
            print(f"  --- Path {path_idx} ---")
            
            # Print the path bottom-up (from Style -> Product)
            for step_idx, entity in enumerate(path):
                indent = "  " * (step_idx + 1)
                prefix = "└─ " if step_idx > 0 else "• "
                print(f"{indent}{prefix}{format_entity(entity)}")
            print()


if __name__ == "__main__":
    main()