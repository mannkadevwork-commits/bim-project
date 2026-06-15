import os
import sys
import time
import json
import argparse
import math
import faulthandler
from pathlib import Path

import ifcopenshell
import ifcopenshell.guid
from google import genai
from google.genai import types
from google.genai.errors import APIError, ServerError, ClientError
from pydantic import BaseModel, Field
from typing import List, Optional

faulthandler.enable()

# =====================================================================
# 1. COMPREHENSIVE DATA MODELS
# =====================================================================
class OpeningComponent(BaseModel):
    id: str
    type: str = Field(description="door or window")
    location_pt: List[float] = Field(description="[x, y] center of the opening")
    width: float = 0.90
    height: float = 2.10
    parent_wall_id: str

class InteriorComponent(BaseModel):
    id: str
    category: str = Field(description="furnishing, sanitary, or appliance")
    location_pt: List[float]
    dimensions: List[float] = Field(default=[0.8, 0.8, 0.5], description="[w, d, h]")

class WallData(BaseModel):
    wall_id: str
    start_pt: List[float] = Field(description="Centerline start point")
    end_pt: List[float] = Field(description="Centerline end point")
    thickness: float = 0.23

class BuildingAnalysis(BaseModel):
    building_name: str = "AI Generated Floor Plan"
    walls: List[WallData]
    openings: List[OpeningComponent] = Field(default_factory=list)
    interiors: List[InteriorComponent] = Field(default_factory=list)

# =====================================================================
# 2. API LOGIC (Centerline & Detail Extraction)
# =====================================================================
def analyze_floor_plan_detailed(image_path: str) -> BuildingAnalysis:
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"[!] Error: The image file '{image_path}' does not exist.")

    client = genai.Client()
    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit("[!] Error: GEMINI_API_KEY is not set. Please set your environment variable.")

    with open(image_path, 'rb') as f:
        image_part = types.Part.from_bytes(data=f.read(), mime_type="image/jpeg") # Note: ensure MIME type matches file if needed
    
    prompt = (
        "Analyze the floor plan. 1. Extract ALL wall segments using CENTERLINE coordinates "
        "to ensure corners meet perfectly. 2. Identify all Doors and Windows as 'openings' and "
        "specify their host wall. 3. Identify all furniture (Sofa, Bed), sanitary (Toilet, Sink), "
        "and appliances (Fridge, Stove). Return as structured JSON."
    )
    
    print(f"[API] Running Detailed Visual Extraction on {os.path.basename(image_path)}...")
    
    # TIP: If gemini-3-flash-preview causes issues, change this to "gemini-1.5-pro" or "gemini-2.5-flash"
    response = client.models.generate_content(
        model='gemini-3-flash-preview', 
        contents=[image_part, prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=BuildingAnalysis,
            temperature=0.1
        ),
    )
    return response.parsed

# =====================================================================
# 3. BIM COMPILER (With Unpacking Fix)
# =====================================================================
def build_detailed_ifc(data: BuildingAnalysis, output_filepath: str):
    print(f"[BIM] Compiling High-Detail BIM...")
    model = ifcopenshell.file(schema="IFC4")
    
    # --- Infrastructure Setup ---
    person = model.create_entity("IfcPerson", Identification="Sushil", FamilyName="Dev")
    org = model.create_entity("IfcOrganization", Name="Entrevista Media")
    p_and_o = model.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
    app = model.create_entity("IfcApplication", ApplicationDeveloper=org, Version="1.0", ApplicationFullName="OonexBIM")
    owner_h = model.create_entity("IfcOwnerHistory", OwningUser=p_and_o, OwningApplication=app, ChangeAction="ADDED", CreationDate=int(time.time()))
    
    unit_l = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    units = model.create_entity("IfcUnitAssignment", Units=[unit_l])
    origin = model.create_entity("IfcCartesianPoint", Coordinates=(0.,0.,0.))
    world_pl = model.create_entity("IfcAxis2Placement3D", Location=origin)
    context = model.create_entity("IfcGeometricRepresentationContext", ContextType="Model", CoordinateSpaceDimension=3, Precision=1e-05, WorldCoordinateSystem=world_pl)
    
    project = model.create_entity("IfcProject", GlobalId=ifcopenshell.guid.new(), Name=data.building_name, OwnerHistory=owner_h, RepresentationContexts=[context], UnitsInContext=units)
    site = model.create_entity("IfcSite", GlobalId=ifcopenshell.guid.new(), Name="Site", ObjectPlacement=model.create_entity("IfcLocalPlacement", RelativePlacement=world_pl))
    building = model.create_entity("IfcBuilding", GlobalId=ifcopenshell.guid.new(), Name="Structure", ObjectPlacement=model.create_entity("IfcLocalPlacement", PlacementRelTo=site.ObjectPlacement, RelativePlacement=world_pl))
    stry_pl = model.create_entity("IfcLocalPlacement", PlacementRelTo=building.ObjectPlacement, RelativePlacement=world_pl)
    storey = model.create_entity("IfcBuildingStorey", GlobalId=ifcopenshell.guid.new(), Name="Ground Floor", ObjectPlacement=stry_pl)

    model.create_entity("IfcRelAggregates", GlobalId=ifcopenshell.guid.new(), RelatingObject=project, RelatedObjects=[site])
    model.create_entity("IfcRelAggregates", GlobalId=ifcopenshell.guid.new(), RelatingObject=site, RelatedObjects=[building])
    model.create_entity("IfcRelAggregates", GlobalId=ifcopenshell.guid.new(), RelatingObject=building, RelatedObjects=[storey])

    elements = []

    # --- 1. WALLS (Centerline Alignment) ---
    for wall in data.walls:
        dx, dy = wall.end_pt[0] - wall.start_pt[0], wall.end_pt[1] - wall.start_pt[1]
        length = (dx**2 + dy**2)**0.5
        angle = math.atan2(dy, dx)
        
        wall_origin = model.create_entity("IfcCartesianPoint", Coordinates=(wall.start_pt[0], wall.start_pt[1], 0.0))
        wall_ax = model.create_entity("IfcAxis2Placement3D", Location=wall_origin, RefDirection=model.create_entity("IfcDirection", DirectionRatios=(math.cos(angle), math.sin(angle), 0.0)))
        wall_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=wall_ax)
        
        ifc_wall = model.create_entity("IfcWall", GlobalId=ifcopenshell.guid.new(), Name=wall.wall_id, ObjectPlacement=wall_loc)
        
        # Center the extrusion on the centerline
        pts = [model.create_entity("IfcCartesianPoint", Coordinates=c) for c in [(0., -wall.thickness/2), (length, -wall.thickness/2), (length, wall.thickness/2), (0., wall.thickness/2), (0., -wall.thickness/2)]]
        profile = model.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=model.create_entity("IfcPolyline", Points=pts))
        solid = model.create_entity("IfcExtrudedAreaSolid", SweptArea=profile, Position=world_pl, ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.,0.,1.)), Depth=3.0)
        
        rep = model.create_entity("IfcShapeRepresentation", ContextOfItems=context, RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[solid])
        ifc_wall.Representation = model.create_entity("IfcProductDefinitionShape", Representations=[rep])
        elements.append(ifc_wall)

    # --- 2. OPENINGS ---
    for op in data.openings:
        op_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(op.location_pt[0], op.location_pt[1], 0.0))))
        if op.type == "window":
            ifc_ent = model.create_entity("IfcWindow", GlobalId=ifcopenshell.guid.new(), Name=op.id, ObjectPlacement=op_loc, OverallHeight=op.height, OverallWidth=op.width)
        else:
            ifc_ent = model.create_entity("IfcDoor", GlobalId=ifcopenshell.guid.new(), Name=op.id, ObjectPlacement=op_loc, OverallHeight=op.height, OverallWidth=op.width)
        elements.append(ifc_ent)

    # --- 3. INTERIOR (With Dimension Fix) ---
    for item in data.interiors:
        item_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(item.location_pt[0], item.location_pt[1], 0.0))))
        
        # SAFE UNPACKING FIX
        dims = item.dimensions
        w = dims[0] if len(dims) > 0 else 0.8
        d = dims[1] if len(dims) > 1 else 0.8
        # Standardize height if missing (Sanitary: 0.4m, Appliances/Furnishing: 0.8m)
        h = dims[2] if len(dims) > 2 else (0.4 if item.category == "sanitary" else 0.8)

        if item.category == "sanitary":
            ifc_ent = model.create_entity("IfcSanitaryTerminal", GlobalId=ifcopenshell.guid.new(), Name=item.id, ObjectPlacement=item_loc)
        elif item.category == "appliance":
            ifc_ent = model.create_entity("IfcElectricAppliance", GlobalId=ifcopenshell.guid.new(), Name=item.id, ObjectPlacement=item_loc)
        else:
            ifc_ent = model.create_entity("IfcFurnishingElement", GlobalId=ifcopenshell.guid.new(), Name=item.id, ObjectPlacement=item_loc)
        
        f_pts = [model.create_entity("IfcCartesianPoint", Coordinates=c) for c in [(0.,0.), (w,0.), (w,d), (0.,d), (0.,0.)] ]
        f_profile = model.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=model.create_entity("IfcPolyline", Points=f_pts))
        f_solid = model.create_entity("IfcExtrudedAreaSolid", SweptArea=f_profile, Position=world_pl, ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.,0.,1.)), Depth=h)
        ifc_ent.Representation = model.create_entity("IfcProductDefinitionShape", Representations=[model.create_entity("IfcShapeRepresentation", ContextOfItems=context, RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[f_solid])])
        elements.append(ifc_ent)

    model.create_entity("IfcRelContainedInSpatialStructure", GlobalId=ifcopenshell.guid.new(), RelatingStructure=storey, RelatedElements=elements)
    model.write(output_filepath)
    print(f"[Success] Fully Detailed & Connected BIM Generated: {output_filepath}")

# =====================================================================
# 4. ORCHESTRATOR FUNCTION
# =====================================================================
def process_image_to_ifc(image_path: str, output_ifc: str = None, force_reanalyze: bool = False):
    """
    Main function to process an image. Can be imported by server.py later!
    """
    # Create dynamic names based on the input file
    base_path = Path(image_path)
    file_stem = base_path.stem # Extracts "My_House" from "My_House.jpg"
    
    cache_file = base_path.parent / f"{file_stem}_cache.json"
    
    if output_ifc is None:
        output_ifc = base_path.parent / f"{file_stem}_3D_Model.ifc"

    # Use cache if it exists and force isn't flagged
    if os.path.exists(cache_file) and not force_reanalyze:
        print(f"[*] Loading cached AI analysis from {cache_file}...")
        with open(cache_file, 'r') as f:
            data = BuildingAnalysis(**json.load(f))
    else:
        # Run AI analysis
        data = analyze_floor_plan_detailed(image_path)
        data.building_name = f"Floor Plan: {file_stem}"
        
        # Save cache for later
        with open(cache_file, 'w') as f:
            json.dump(data.model_dump(), f, indent=4)

    # Build the 3D model
    build_detailed_ifc(data, str(output_ifc))
    return str(output_ifc)

# =====================================================================
# 5. COMMAND LINE INTERFACE
# =====================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate 3D IFC model from a floor plan image.")
    # Notice: 'image' is now a required positional argument
    parser.add_argument("image", help="Path to the floor plan image (e.g., floorplan.jpg)")
    parser.add_argument("--output", help="Optional custom name for the output .ifc file", default=None)
    parser.add_argument("--force", action="store_true", help="Force AI re-analysis even if cache exists")
    
    args = parser.parse_args()

    try:
        final_ifc_path = process_image_to_ifc(
            image_path=args.image, 
            output_ifc=args.output, 
            force_reanalyze=args.force
        )
    except Exception as e:
        print(f"\n[!] A fatal error occurred: {e}")