import os
import sys
import time
import json
import argparse
import math
import re
import faulthandler
import importlib.util
import ifcopenshell
import ifcopenshell.guid
from google import genai
from google.genai import types
from google.genai.errors import APIError, ServerError, ClientError
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional

faulthandler.enable()

# =====================================================================
# 1. COMPREHENSIVE DATA MODELS
# =====================================================================
def _property_value_to_text(value) -> str:
    if isinstance(value, bool): return "true" if value else "false"
    if value is None: return ""
    if isinstance(value, (str, int, float)): return str(value)
    return json.dumps(value)

def _properties_to_entries(value):
    if value is None: return []
    if isinstance(value, list): return value
    if not isinstance(value, dict): return []
    entries = []
    for key, prop_value in value.items():
        if isinstance(prop_value, dict) and str(key).startswith("Pset_"):
            for nested_name, nested_value in prop_value.items():
                entries.append({"pset": str(key), "name": str(nested_name), "value": _property_value_to_text(nested_value)})
        else:
            entries.append({"name": str(key), "value": _property_value_to_text(prop_value)})
    return entries

class ElementProperty(BaseModel):
    name: str = Field(description="IFC property name")
    value: str = Field(description="Property value as text")
    pset: Optional[str] = Field(default=None)

class OpeningComponent(BaseModel):
    id: str
    type: str = Field(description="door, window, or arch opening")
    location_pt: List[float] = Field(description="[x, y] center of the opening")
    width: float = 0.90
    height: float = 2.10
    parent_wall_id: str
    operation_type: Optional[str] = Field(default=None)
    material: Optional[str] = Field(default=None)
    color: Optional[List[float]] = Field(default=None)
    properties: List[ElementProperty] = Field(default_factory=list)
    unit: str = "m"
    @field_validator("properties", mode="before")
    @classmethod
    def normalize_properties(cls, value): return _properties_to_entries(value)

class InteriorComponent(BaseModel):
    id: str
    category: str = Field(description="furnishing, sanitary, or appliance")
    type: Optional[str] = Field(default=None)
    location_pt: List[float]
    dimensions: List[float] = Field(default=[0.8, 0.8, 0.5])
    material: Optional[str] = Field(default=None)
    color: Optional[List[float]] = Field(default=None)
    properties: List[ElementProperty] = Field(default_factory=list)
    unit: str = "m"
    @field_validator("properties", mode="before")
    @classmethod
    def normalize_properties(cls, value): return _properties_to_entries(value)

class WallData(BaseModel):
    wall_id: str
    start_pt: List[float] = Field(description="Centerline start point")
    end_pt: List[float] = Field(description="Centerline end point")
    thickness: float = 0.23
    height: float = 3.0
    unit: str = "m"

class BuildingAnalysis(BaseModel):
    building_name: str = "1 BHK Detailed Plan"
    walls: List[WallData]
    openings: List[OpeningComponent] = Field(default_factory=list)
    interiors: List[InteriorComponent] = Field(default_factory=list)

def find_ifc_properties_files(search_root: str = None) -> List[str]:
    root = os.path.abspath(search_root or os.path.dirname(__file__))
    matches = []
    for dirpath, dirnames, filenames in os.walk(root):
        if "ifc_properties.py" in filenames: matches.append(os.path.join(dirpath, "ifc_properties.py"))
    return matches

def load_ifc_properties_module(path: str):
    spec = importlib.util.spec_from_file_location("ifc_properties", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def _convert_to_meters(value: float, unit: str) -> float:
    if value is None: return 0.0
    unit = (unit or "m").strip().lower()
    if unit in {"mm"}: return value / 1000.0
    if unit in {"cm"}: return value / 100.0
    if unit in {"in", "inch", "inches"}: return value * 0.0254
    if unit in {"ft", "foot", "feet"}: return value * 0.3048
    return value

def _normalize_point(point: List[float], unit: str) -> List[float]:
    return [_convert_to_meters(coord, unit) for coord in point]

def _normalize_mapping_key(value) -> str:
    if value is None: return ""
    text = str(value).strip()
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", text)
    text = re.sub(r"[^A-Za-z0-9]+", "_", text)
    return text.strip("_").lower()

def _get_component_config(category: str, props_module=None) -> dict:
    category_key = _normalize_mapping_key(category)
    aliases = {"furniture": "furnishing", "fixture": "sanitary", "appliances": "appliance"}
    category_key = aliases.get(category_key, category_key)
    
    fallback = {
        "furnishing": {"schema_key": "Furniture", "ifc_class": "IfcFurniture", "pset": "Pset_FurnitureTypeCommon", "predefined_attr": "PredefinedType"},
        "sanitary": {"schema_key": "FlowTerminal", "ifc_class": "IfcSanitaryTerminal", "pset": "Pset_SanitaryTerminalTypeCommon", "predefined_attr": "PredefinedType"},
        "appliance": {"schema_key": "ElectricAppliance", "ifc_class": "IfcElectricAppliance", "pset": "Pset_ElectricApplianceTypeCommon", "predefined_attr": "PredefinedType"},
    }
    return fallback.get(category_key, fallback["furnishing"])

def resolve_component_spec(item: InteriorComponent, props_module=None) -> dict:
    config = _get_component_config(item.category, props_module)
    return {
        "ifc_class": config.get("ifc_class", "IfcBuildingElementProxy"),
        "pset": config.get("pset"),
        "predefined_attr": config.get("predefined_attr"),
        "predefined_type": item.type or "NOTDEFINED"
    }

def normalize_opening_type(op_type: str) -> str:
    normalized = (op_type or "").strip().lower()
    if "window" in normalized: return "window"
    return "door"

def _normalize_color(value):
    if not value or not isinstance(value, (list, tuple)) or len(value) < 3: return None
    channels = [float(value[0]), float(value[1]), float(value[2])]
    if max(channels) > 1.0: channels = [c / 255.0 for c in channels]
    return tuple(max(0.0, min(1.0, c)) for c in channels)

def assign_surface_style(model, representation_item, color, style_name: str = "SurfaceStyle"):
    rgb = _normalize_color(color)
    if not rgb or representation_item is None: return None
    colour = model.create_entity("IfcColourRgb", Name=None, Red=rgb[0], Green=rgb[1], Blue=rgb[2])
    surface = model.create_entity("IfcSurfaceStyleShading", SurfaceColour=colour, Transparency=0.0)
    style = model.create_entity("IfcSurfaceStyle", Name=style_name, Side="BOTH", Styles=[surface])
    try: return model.create_entity("IfcStyledItem", Item=representation_item, Styles=[style], Name=style_name)
    except: return None

def _build_extraction_prompt(image_path: str) -> str:
    return (
        "Analyze the floor plan and extract detailed architectural data.\n"
        "Completeness is more important than rich properties. Never omit visible physical objects just to keep the JSON short.\n"
        "1. Extract ALL straight wall segments using CENTERLINE coordinates so corners meet perfectly.\n"
        "2. Identify ALL Doors and Windows as openings and specify their host wall.\n"
        "3. Identify ALL interior elements including furniture, sanitary components, and appliances.\n"
        "   - Use category exactly as one of: furnishing, sanitary, appliance.\n"
        "   - For furnishing type, use one of: SOFA, BED, CHAIR, TABLE, DESK, WARDROBE.\n"
        "   - For sanitary type, use one of: WC, WASHBASIN, SINK, SHOWER, BATHTUB.\n"
        "   - Estimate each element's real [width, depth, height] in meters from its drawn size.\n"
        "Return the complete results in structured JSON according to the schema."
    )

def analyze_floor_plan_detailed(image_path: str) -> BuildingAnalysis:
    client = genai.Client()
    ext = os.path.splitext(image_path)[1].lower()
    mime_type = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png'}.get(ext.replace('.', ''), 'application/octet-stream')
    with open(image_path, 'rb') as f:
        image_part = types.Part.from_bytes(data=f.read(), mime_type=mime_type)
    
    print(f"[API] Running Detailed Visual Extraction...")
    response = client.models.generate_content(
        model='gemini-3-flash-preview',
        contents=[image_part, _build_extraction_prompt(image_path)],
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=BuildingAnalysis, temperature=0.0
        ),
    )
    return response.parsed

# =====================================================================
# THE FIX: 100% STANDARD IFC RECTANGLE BUILDER
# =====================================================================
def create_standard_box(model, w, d, h, x_offset=0.0, y_offset=0.0, z_offset=0.0):
    profile_pt = model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0))
    profile_ax = model.create_entity("IfcAxis2Placement2D", Location=profile_pt)
    profile = model.create_entity("IfcRectangleProfileDef", ProfileType="AREA", Position=profile_ax, XDim=w, YDim=d)
    
    insert_pt = model.create_entity("IfcCartesianPoint", Coordinates=(float(x_offset), float(y_offset), float(z_offset)))
    insert_ax = model.create_entity("IfcAxis2Placement3D", Location=insert_pt)
    direction = model.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    
    return model.create_entity("IfcExtrudedAreaSolid", SweptArea=profile, Position=insert_ax, ExtrudedDirection=direction, Depth=h)

# =====================================================================
# 3. BIM COMPILER 
# =====================================================================
def build_detailed_ifc(data: BuildingAnalysis, output_filepath: str, props_module=None, debug: bool = False, assets_dir: str = ""):
    print(f"Compiling High-Detail BIM...")
    model = ifcopenshell.file(schema="IFC4")
    
    owner_h = model.create_entity("IfcOwnerHistory", OwningUser=model.create_entity("IfcPersonAndOrganization", ThePerson=model.create_entity("IfcPerson", Identification="Sushil"), TheOrganization=model.create_entity("IfcOrganization", Name="Entrevista")), OwningApplication=model.create_entity("IfcApplication", ApplicationDeveloper=model.create_entity("IfcOrganization", Name="Entrevista"), Version="1.0", ApplicationFullName="OonexBIM"), ChangeAction="ADDED", CreationDate=int(time.time()))
    units = model.create_entity("IfcUnitAssignment", Units=[model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")])
    world_pl = model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(0.,0.,0.)))
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
    wall_map = {}

    # --- 1. WALLS ---
    for wall in data.walls:
        wall_unit = getattr(wall, "unit", "m") or "m"
        start_pt = _normalize_point(wall.start_pt, wall_unit)
        end_pt = _normalize_point(wall.end_pt, wall_unit)
        wt = _convert_to_meters(wall.thickness, wall_unit)
        wh = _convert_to_meters(wall.height, wall_unit)

        dx, dy = end_pt[0] - start_pt[0], end_pt[1] - start_pt[1]
        length = (dx**2 + dy**2)**0.5
        angle = math.atan2(dy, dx)
        
        wall_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(start_pt[0], start_pt[1], 0.0)), RefDirection=model.create_entity("IfcDirection", DirectionRatios=(math.cos(angle), math.sin(angle), 0.0))))
        ifc_wall = model.create_entity("IfcWallStandardCase", GlobalId=ifcopenshell.guid.new(), Name=wall.wall_id, ObjectPlacement=wall_loc)
        
        solid = create_standard_box(model, length, wt, wh, x_offset=length/2)
        ifc_wall.Representation = model.create_entity("IfcProductDefinitionShape", Representations=[model.create_entity("IfcShapeRepresentation", ContextOfItems=context, RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[solid])])
        elements.append(ifc_wall)
        wall_map[wall.wall_id] = ifc_wall

    # --- 2. OPENINGS ---
    for op in data.openings:
        op_unit = getattr(op, "unit", "m") or "m"
        op_pt = _normalize_point(op.location_pt, op_unit)
        op_width = _convert_to_meters(op.width, op_unit)
        op_height = _convert_to_meters(op.height, op_unit)
        op_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(op_pt[0], op_pt[1], 0.0))))
        
        opening_elem = model.create_entity("IfcOpeningElement", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_h, Name=f"Opening_{op.id}", ObjectPlacement=op_loc)
        if op.parent_wall_id and op.parent_wall_id in wall_map:
            model.create_entity("IfcRelVoidsElement", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_h, RelatingBuildingElement=wall_map[op.parent_wall_id], RelatedOpeningElement=opening_elem)

        if "window" in (op.type or "").lower():
            ifc_ent = model.create_entity("IfcWindow", GlobalId=ifcopenshell.guid.new(), Name=op.id, ObjectPlacement=op_loc, OverallHeight=op_height, OverallWidth=op_width)
        else:
            ifc_ent = model.create_entity("IfcDoor", GlobalId=ifcopenshell.guid.new(), Name=op.id, ObjectPlacement=op_loc, OverallHeight=op_height, OverallWidth=op_width)

        model.create_entity("IfcRelFillsElement", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_h, RelatingOpeningElement=opening_elem, RelatedBuildingElement=ifc_ent)
        elements.extend([opening_elem, ifc_ent])

    # --- 3. THE ASSEMBLY FIX FOR XEOKIT ---
    for item in data.interiors:
        item_unit = getattr(item, "unit", "m") or "m"
        item_pt = _normalize_point(item.location_pt, item_unit)
        dims = [_convert_to_meters(v, item_unit) for v in item.dimensions]
        w = dims[0] if len(dims) > 0 else 0.8
        d = dims[1] if len(dims) > 1 else 0.8
        h = dims[2] if len(dims) > 2 else 0.8

        item_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(item_pt[0], item_pt[1], 0.0))))
        component_spec = resolve_component_spec(item, props_module)
        
        # 1. Create the Parent Container (Has no visual geometry, just groups things)
        ifc_parent = model.create_entity(component_spec["ifc_class"], GlobalId=ifcopenshell.guid.new(), Name=item.id, ObjectPlacement=item_loc)
        
        ai_raw_type = f"{getattr(item, 'type', '')} {getattr(item, 'id', '')} {getattr(item, 'category', '')}".upper()
        
        parts = []
        
        # Helper to generate individual blocks inside the assembly
        def add_part(part_name, pw, pd, ph, px, py, pz):
            solid = create_standard_box(model, pw, pd, ph, px, py, pz)
            rep = model.create_entity("IfcShapeRepresentation", ContextOfItems=context, RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[solid])
            shape = model.create_entity("IfcProductDefinitionShape", Representations=[rep])
            
            # Sub-placement must be relative to the parent object
            part_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=item_loc, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(0.0,0.0,0.0))))
            part = model.create_entity("IfcFurnishingElement", GlobalId=ifcopenshell.guid.new(), Name=f"{item.id}_{part_name}", ObjectPlacement=part_loc, Representation=shape)
            
            if item.color:
                assign_surface_style(model, solid, item.color, style_name=f"{item.id}_{part_name}_Style")
            
            parts.append(part)

        # 🛋️ BUILD SOFA
        if "SOFA" in ai_raw_type or "COUCH" in ai_raw_type:
            add_part("Seat", w, d * 0.6, h * 0.4, 0.0, -d * 0.2, 0.0)
            add_part("Backrest", w, d * 0.4, h, 0.0, d * 0.3, 0.0)
            arm_w = w * 0.15
            add_part("LeftArm", arm_w, d * 0.6, h * 0.6, -w/2 + arm_w/2, -d * 0.2, 0.0)
            add_part("RightArm", arm_w, d * 0.6, h * 0.6, w/2 - arm_w/2, -d * 0.2, 0.0)
        
        # 🛏️ BUILD BED
        elif "BED" in ai_raw_type:
            add_part("Mattress", w, d * 0.9, h * 0.6, 0.0, -d * 0.05, 0.0)
            add_part("Headboard", w, d * 0.1, h, 0.0, d * 0.45, 0.0)
            add_part("PillowLeft", w * 0.3, d * 0.15, 0.1, -w * 0.25, d * 0.3, h * 0.6)
            add_part("PillowRight", w * 0.3, d * 0.15, 0.1, w * 0.25, d * 0.3, h * 0.6)
        
        # 🪑 BUILD TABLE
        elif "TABLE" in ai_raw_type or "DESK" in ai_raw_type:
            add_part("Top", w, d, 0.05, 0.0, 0.0, h - 0.05)
            leg_w = min(w, d) * 0.1
            add_part("Leg1", leg_w, leg_w, h - 0.05, -w/2+leg_w, -d/2+leg_w, 0.0)
            add_part("Leg2", leg_w, leg_w, h - 0.05, w/2-leg_w, -d/2+leg_w, 0.0)
            add_part("Leg3", leg_w, leg_w, h - 0.05, -w/2+leg_w, d/2-leg_w, 0.0)
            add_part("Leg4", leg_w, leg_w, h - 0.05, w/2-leg_w, d/2-leg_w, 0.0)
            
        else:
            add_part("Body", w, d, h, 0.0, 0.0, 0.0)
            
        # 2. Link the child parts to the Parent Sofa using the official IFC Grouping method
        model.create_entity("IfcRelAggregates", GlobalId=ifcopenshell.guid.new(), RelatingObject=ifc_parent, RelatedObjects=parts)
        
        # 3. Expose both parent and children to the main viewer structure
        elements.append(ifc_parent)
        elements.extend(parts)

    model.create_entity("IfcRelContainedInSpatialStructure", GlobalId=ifcopenshell.guid.new(), RelatingStructure=storey, RelatedElements=elements)
    model.write(output_filepath)
    print(f"[Success] Fully Detailed & Connected BIM Generated: {output_filepath}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="1 BHK HOUSE .jpg")
    parser.add_argument("--output", default="1_BHK_Detailed.ifc")
    parser.add_argument("--cache", default="1_BHK_Detailed_Cache.json")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--assets", default="", help="Directory containing IFC asset files for furniture")
    args = parser.parse_args()

    if os.path.exists(args.cache) and not args.force:
        with open(args.cache, 'r') as f: data = BuildingAnalysis(**json.load(f))
    else:
        data = analyze_floor_plan_detailed(args.image)
        with open(args.cache, 'w') as f: json.dump(data.model_dump(), f, indent=4)

    build_detailed_ifc(data, args.output, assets_dir=args.assets)