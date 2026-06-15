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
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    if isinstance(value, (str, int, float)):
        return str(value)
    return json.dumps(value)

def _properties_to_entries(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        return []

    entries = []
    for key, prop_value in value.items():
        if isinstance(prop_value, dict) and str(key).startswith("Pset_"):
            for nested_name, nested_value in prop_value.items():
                entries.append({
                    "pset": str(key),
                    "name": str(nested_name),
                    "value": _property_value_to_text(nested_value),
                })
        else:
            entries.append({
                "name": str(key),
                "value": _property_value_to_text(prop_value),
            })
    return entries

class ElementProperty(BaseModel):
    name: str = Field(description="IFC property name, e.g. BedSize, SeatingCapacity, FuelType")
    value: str = Field(description="Property value as text; use numeric text for numbers and true/false for booleans")
    pset: Optional[str] = Field(default=None, description="Optional IFC property set name, e.g. Pset_BedTypeCommon")

class OpeningComponent(BaseModel):
    id: str
    type: str = Field(description="door, window, or arch opening")
    location_pt: List[float] = Field(description="[x, y] center of the opening")
    width: float = 0.90
    height: float = 2.10
    parent_wall_id: str
    operation_type: Optional[str] = Field(default=None, description="Door/window operation, e.g. SINGLE_SWING_RIGHT, SLIDING, CASEMENT, FIXEDLIGHT")
    material: Optional[str] = Field(default=None, description="Primary door/window material")
    color: Optional[List[float]] = Field(default=None, description="RGB color as [r, g, b], values from 0-1")
    properties: List[ElementProperty] = Field(default_factory=list, description="Additional IFC property overrides as name/value rows")
    unit: str = "m"

    @field_validator("properties", mode="before")
    @classmethod
    def normalize_properties(cls, value):
        return _properties_to_entries(value)

class InteriorComponent(BaseModel):
    id: str
    category: str = Field(description="furnishing, sanitary, or appliance")
    type: Optional[str] = Field(default=None, description="Specific element type, e.g. BED, SOFA, REFRIGERATOR, WC, WASHBASIN")
    location_pt: List[float]
    dimensions: List[float] = Field(default=[0.8, 0.8, 0.5], description="[w, d, h]")
    material: Optional[str] = Field(default=None, description="Primary visible material")
    color: Optional[List[float]] = Field(default=None, description="RGB color as [r, g, b], values from 0-1")
    properties: List[ElementProperty] = Field(default_factory=list, description="Additional IFC property overrides as name/value rows")
    unit: str = "m"

    @field_validator("properties", mode="before")
    @classmethod
    def normalize_properties(cls, value):
        return _properties_to_entries(value)

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
        if "ifc_properties.py" in filenames:
            matches.append(os.path.join(dirpath, "ifc_properties.py"))
    return matches

def load_ifc_properties_module(path: str):
    spec = importlib.util.spec_from_file_location("ifc_properties", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def _to_meters(value: float, unit: str) -> float:
    unit = (unit or "m").strip().lower()
    if unit in {"m", "meter", "meters", "metre", "metres"}:
        return value
    if unit == "mm":
        return value / 1000.0
    if unit == "cm":
        return value / 100.0
    if unit in {"in", "inch", "inches"}:
        return value * 0.0254
    if unit in {"ft", "foot", "feet"}:
        return value * 0.3048
    return value

def _to_square_meters(value: float, unit: str) -> float:
    unit = (unit or "m2").strip().lower()
    if unit == "mm2":
        return value / 1_000_000.0
    if unit == "cm2":
        return value / 10_000.0
    if unit in {"in2", "sqin", "square_inch", "square_inches"}:
        return value * 0.00064516
    if unit in {"ft2", "sqft", "square_foot", "square_feet"}:
        return value * 0.09290304
    if unit in {"m2", "sqm", "square_meter", "square_meters", "square_metre", "square_metres"}:
        return value
    return value

def _convert_to_meters(value: float, unit: str) -> float:
    if value is None:
        return 0.0
    return _to_meters(value, unit or "m")

def _normalize_point(point: List[float], unit: str) -> List[float]:
    return [_convert_to_meters(coord, unit) for coord in point]

def _make_ifc_value(model, value, prop_name: str = None, unit: str = None):
    if isinstance(value, bool):
        return model.create_entity("IfcBoolean", value)

    area_pattern = re.compile(r"(area|floorarea|netfloorarea|grossfloorarea|surfacearea)", re.I)
    length_pattern = re.compile(r"(height|width|length|thickness|depth|cill|installationheight|thresholdheight|riserheight|treadlength|distance|offset|rise|run|diameter|radius)", re.I)
    unit_str = (unit or "").strip().lower()

    if isinstance(value, int) and not isinstance(value, bool):
        if unit_str in {"m", "meter", "meters", "metre", "metres", "mm", "cm", "in", "inch", "inches", "ft", "foot", "feet"} or (prop_name and length_pattern.search(prop_name)):
            converted = float(value)
            if unit_str:
                converted = _to_meters(converted, unit_str)
            return model.create_entity("IfcLengthMeasure", converted)
        if unit_str in {"m2", "sqm", "square_meter", "square_meters", "square_metre", "square_metres", "mm2", "cm2", "in2", "sqin", "ft2", "sqft"} or (prop_name and area_pattern.search(prop_name)):
            converted = float(value)
            if unit_str:
                converted = _to_square_meters(converted, unit_str)
            return model.create_entity("IfcAreaMeasure", converted)
        return model.create_entity("IfcInteger", value)

    if isinstance(value, float):
        if unit_str in {"m", "meter", "meters", "metre", "metres", "mm", "cm", "in", "inch", "inches", "ft", "foot", "feet"} or (prop_name and length_pattern.search(prop_name)):
            converted = value
            if unit_str:
                converted = _to_meters(converted, unit_str)
            return model.create_entity("IfcLengthMeasure", converted)
        if unit_str in {"m2", "sqm", "square_meter", "square_meters", "square_metre", "square_metres", "mm2", "cm2", "in2", "sqin", "ft2", "sqft"} or (prop_name and area_pattern.search(prop_name)):
            converted = value
            if unit_str:
                converted = _to_square_meters(converted, unit_str)
            return model.create_entity("IfcAreaMeasure", converted)
        return model.create_entity("IfcReal", value)

    if isinstance(value, str):
        return model.create_entity("IfcLabel", value)
    return None

def create_ifc_property_set(model, owner_history, element, pset_name: str, properties: dict, property_metadata: dict = None):
    if not properties:
        return None

    property_metadata = property_metadata or {}
    pset_props = []
    for prop_name, prop_value in properties.items():
        if prop_value is None:
            continue
        prop_meta = property_metadata.get(prop_name, {})
        nominal_value = _make_ifc_value(model, prop_value, prop_name=prop_name, unit=prop_meta.get("unit"))
        if nominal_value is None:
            continue

        pset_props.append(
            model.create_entity(
                "IfcPropertySingleValue",
                prop_name,
                None,
                nominal_value,
            )
        )

    if not pset_props:
        return None

    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        Name=pset_name,
        HasProperties=pset_props,
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        ifcopenshell.guid.new(),  
        owner_history,  
        None,  
        None,  
        [element],  
        pset,  
    )
    return pset

def create_ifc_quantity_set(model, owner_history, element, qset_name: str, quantities: dict):
    if not quantities:
        return None

    qset_props = []
    for qty_name, qty_value in quantities.items():
        if qty_value is None:
            continue
        if isinstance(qty_value, (int, float)):
            qty = model.create_entity(
                "IfcQuantityLength",
                Name=qty_name,
                Description=None,
                Unit=None,
                LengthValue=float(qty_value),
            )
        else:
            continue
        qset_props.append(qty)

    if not qset_props:
        return None

    qset = model.create_entity(
        "IfcElementQuantity",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        Name=qset_name,
        Quantities=qset_props,
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        ifcopenshell.guid.new(), 
        owner_history, 
        None, 
        None, 
        [element], 
        qset, 
    )
    return qset

def normalize_opening_type(op_type: str) -> str:
    if not op_type:
        return "door"
    normalized = op_type.strip().lower()
    if "window" in normalized:
        return "window"
    if "arch" in normalized or "portal" in normalized:
        return "door"
    if "door" in normalized:
        return "door"
    return "door"

def _normalize_mapping_key(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", text)
    text = re.sub(r"[^A-Za-z0-9]+", "_", text)
    return text.strip("_").lower()

def _resolve_mapped_value(values, mapping: dict, default: str = None) -> str:
    if not isinstance(values, list):
        values = [values]

    normalized_values = [_normalize_mapping_key(value) for value in values if value]
    normalized_values = [value for value in normalized_values if value]
    if not normalized_values:
        return default

    normalized_mapping = {_normalize_mapping_key(key): mapped for key, mapped in mapping.items()}
    for value in normalized_values:
        if value in normalized_mapping:
            return normalized_mapping[value]

    for value in normalized_values:
        for mapped in mapping.values():
            if value == _normalize_mapping_key(mapped):
                return mapped

    for value in normalized_values:
        for key, mapped in mapping.items():
            key_norm = _normalize_mapping_key(key)
            if key_norm and key_norm in value:
                return mapped

    return default

def _get_component_config(category: str, props_module=None) -> dict:
    category_key = _normalize_mapping_key(category)
    aliases = {
        "furniture": "furnishing",
        "fixture": "sanitary",
        "fixtures": "sanitary",
        "plumbing": "sanitary",
        "plumbing_fixture": "sanitary",
        "sanitary_terminal": "sanitary",
        "electric_appliance": "appliance",
        "appliances": "appliance",
    }
    category_key = aliases.get(category_key, category_key)

    registry = getattr(props_module, "COMPONENT_TYPE_MAP", {}) if props_module else {}
    if category_key in registry:
        return registry[category_key]

    fallback = {
        "furnishing": {
            "schema_key": "Furniture",
            "ifc_class": "IfcFurniture",
            "pset": "Pset_FurnitureTypeCommon",
            "predefined_attr": "PredefinedType",
            "type_property": "FurnitureType",
            "default_type": "NOTDEFINED",
            "types": {},
        },
        "sanitary": {
            "schema_key": "FlowTerminal",
            "ifc_class": "IfcSanitaryTerminal",
            "pset": "Pset_SanitaryTerminalTypeCommon",
            "predefined_attr": "PredefinedType",
            "type_property": "SanitaryTerminalType",
            "default_type": "NOTDEFINED",
            "types": {},
        },
        "appliance": {
            "schema_key": "ElectricAppliance",
            "ifc_class": "IfcElectricAppliance",
            "pset": "Pset_ElectricApplianceTypeCommon",
            "predefined_attr": "PredefinedType",
            "type_property": "ApplianceType",
            "default_type": "NOTDEFINED",
            "types": {},
        },
    }
    return fallback.get(category_key, fallback["furnishing"])

def resolve_component_spec(item: InteriorComponent, props_module=None) -> dict:
    config = _get_component_config(item.category, props_module)
    mapped_type = _resolve_mapped_value(
        [getattr(item, "type", None), getattr(item, "id", None)],
        config.get("types", {}),
        config.get("default_type", "NOTDEFINED"),
    )
    type_psets = config.get("type_psets", {}).get(mapped_type, [])
    pset_names = [config.get("pset")]
    pset_names.extend(type_psets)

    return {
        "schema_key": config.get("schema_key"),
        "ifc_class": config.get("ifc_class", "IfcBuildingElementProxy"),
        "pset": config.get("pset"),
        "pset_names": [name for name in pset_names if name],
        "predefined_attr": config.get("predefined_attr"),
        "predefined_type": mapped_type,
        "type_property": config.get("type_property"),
    }

def resolve_opening_spec(op: OpeningComponent, opening_type: str, props_module=None) -> dict:
    registry = getattr(props_module, "OPENING_TYPE_MAP", {}) if props_module else {}
    config = registry.get(opening_type, {})
    if not config:
        config = {
            "ifc_class": "IfcWindow" if opening_type == "window" else "IfcDoor",
            "schema_key": "Window" if opening_type == "window" else "Door",
            "pset": "Pset_WindowCommon" if opening_type == "window" else "Pset_DoorCommon",
            "predefined_attr": "PredefinedType",
            "predefined_type": "WINDOW" if opening_type == "window" else "DOOR",
            "operation_attr": "PartitioningType" if opening_type == "window" else "OperationType",
            "operation_property": "OperationType",
            "default_operation": "SINGLE_PANEL" if opening_type == "window" else "SINGLE_SWING_RIGHT",
            "operations": {},
        }

    raw_operation = getattr(op, "operation_type", None)
    mapped_operation = _resolve_mapped_value(
        [raw_operation, getattr(op, "type", None), getattr(op, "id", None)],
        config.get("operations", {}),
        config.get("default_operation"),
    )
    operation_property = raw_operation or mapped_operation
    if opening_type == "window" and not raw_operation:
        operation_property = {
            "DOUBLE_PANEL_HORIZONTAL": "SLIDING",
            "SINGLE_PANEL": "FIXEDLIGHT",
        }.get(mapped_operation, mapped_operation)

    return {
        "schema_key": config.get("schema_key"),
        "ifc_class": config.get("ifc_class"),
        "pset": config.get("pset"),
        "predefined_attr": config.get("predefined_attr"),
        "predefined_type": config.get("predefined_type"),
        "operation_attr": config.get("operation_attr"),
        "operation_property": config.get("operation_property"),
        "operation_type": mapped_operation,
        "operation_property_value": operation_property,
    }

def _set_ifc_attribute(element, attr_name: str, value):
    if not attr_name or value is None:
        return
    try:
        setattr(element, attr_name, value)
    except Exception:
        pass

def _normalize_color(value):
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r"#[0-9A-Fa-f]{6}", text):
            return (
                int(text[1:3], 16) / 255.0,
                int(text[3:5], 16) / 255.0,
                int(text[5:7], 16) / 255.0,
            )
        return None
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None

    channels = [float(value[0]), float(value[1]), float(value[2])]
    if max(channels) > 1.0:
        channels = [channel / 255.0 for channel in channels]
    return tuple(max(0.0, min(1.0, channel)) for channel in channels)

def _color_to_hex(value) -> str:
    color = _normalize_color(value)
    if not color:
        return None
    return "#{:02X}{:02X}{:02X}".format(*(round(channel * 255) for channel in color))

def _material_color(material_name: str, props_module=None):
    if not material_name or not props_module or not hasattr(props_module, "MATERIALS"):
        return None
    for candidate, meta in props_module.MATERIALS.items():
        if candidate.lower() == str(material_name).lower():
            return meta.get("color")
    return None

def _default_component_material(category: str, mapped_type: str = None) -> str:
    category_key = _normalize_mapping_key(category)
    mapped_type = (mapped_type or "").upper()
    if category_key in {"sanitary", "fixture", "plumbing", "plumbing_fixture"}:
        return "Ceramic" if mapped_type not in {"SINK"} else "Stainless Steel"
    if category_key in {"appliance", "appliances", "electric_appliance"}:
        return "Stainless Steel"
    if mapped_type in {"SOFA", "CHAIR"}:
        return "Fabric"
    if mapped_type in {"TABLE", "DESK", "BED", "SHELF", "FILECABINET"}:
        return "Teak Wood"
    return "MDF"

def _default_opening_material(opening_type: str) -> str:
    return "Aluminium" if opening_type == "window" else "Teak Wood"

def _clean_property_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    color_hex = _color_to_hex(value)
    if color_hex:
        return color_hex
    return json.dumps(value)

def _parse_property_value(value):
    if not isinstance(value, str):
        return _clean_property_value(value)
    text = value.strip()
    if text.lower() == "true":
        return True
    if text.lower() == "false":
        return False
    if re.fullmatch(r"[-+]?\d+", text):
        return int(text)
    if re.fullmatch(r"[-+]?\d*\.\d+", text):
        return float(text)
    return value

def _merge_additional_properties(overrides: dict, default_pset: str, properties):
    if not properties:
        return

    if isinstance(properties, dict):
        for key, value in properties.items():
            if isinstance(value, dict) and key.startswith("Pset_"):
                overrides.setdefault(key, {})
                for prop_name, prop_value in value.items():
                    overrides[key][prop_name] = _parse_property_value(prop_value)
            else:
                overrides.setdefault(default_pset, {})[key] = _parse_property_value(value)
        return

    if not isinstance(properties, list):
        return

    for entry in properties:
        if isinstance(entry, dict):
            pset_name = entry.get("pset") or default_pset
            prop_name = entry.get("name")
            prop_value = entry.get("value")
        else:
            pset_name = getattr(entry, "pset", None) or default_pset
            prop_name = getattr(entry, "name", None)
            prop_value = getattr(entry, "value", None)

        if not prop_name:
            continue
        if isinstance(prop_value, dict) and str(prop_name).startswith("Pset_"):
            pset_name = prop_name
            overrides.setdefault(pset_name, {})
            for nested_name, nested_value in prop_value.items():
                overrides[pset_name][nested_name] = _parse_property_value(nested_value)
        else:
            overrides.setdefault(pset_name, {})[prop_name] = _parse_property_value(prop_value)

def _build_property_overrides(pset_key: str, width: float = None, depth: float = None, height: float = None, material: str = None, color=None, type_property: str = None, mapped_type: str = None, extra_properties: dict = None) -> dict:
    values = {}
    if width is not None:
        values["OverallWidth"] = width
    if depth is not None:
        values["OverallDepth"] = depth
    if height is not None:
        values["OverallHeight"] = height
    if material:
        values["Material"] = material
    color_hex = _color_to_hex(color)
    if color_hex:
        values["Color"] = color_hex
    if type_property and mapped_type:
        values[type_property] = mapped_type

    overrides = {pset_key: values}
    _merge_additional_properties(overrides, pset_key, extra_properties or {})
    return overrides

def assign_material(model, owner_history, element, material_name: str):
    if not material_name:
        return None
    material = model.create_entity("IfcMaterial", Name=str(material_name))
    model.create_entity(
        "IfcRelAssociatesMaterial",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        RelatedObjects=[element],
        RelatingMaterial=material,
    )
    return material

def assign_surface_style(model, representation_item, color, style_name: str = "SurfaceStyle", transparency: float = 0.0):
    rgb = _normalize_color(color)
    if not rgb or representation_item is None:
        return None

    colour = model.create_entity("IfcColourRgb", Name=None, Red=rgb[0], Green=rgb[1], Blue=rgb[2])
    try:
        surface = model.create_entity(
            "IfcSurfaceStyleRendering",
            SurfaceColour=colour,
            Transparency=transparency,
            ReflectanceMethod="NOTDEFINED",
        )
    except Exception:
        surface = model.create_entity("IfcSurfaceStyleShading", SurfaceColour=colour, Transparency=transparency)

    style = model.create_entity("IfcSurfaceStyle", Name=style_name, Side="BOTH", Styles=[surface])
    try:
        return model.create_entity("IfcStyledItem", Item=representation_item, Styles=[style], Name=style_name)
    except Exception:
        assignment = model.create_entity("IfcPresentationStyleAssignment", Styles=[style])
        return model.create_entity("IfcStyledItem", Item=representation_item, Styles=[assignment], Name=style_name)

def create_archicad_name_pset(model, owner_history, element, name: str):
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        Name="ArchiCADPName",
        HasProperties=[
            model.create_entity(
                "IfcPropertySingleValue",
                "Name",
                None,
                model.create_entity("IfcLabel", name),
            )
        ],
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        ifcopenshell.guid.new(),
        owner_history,
        None,
        None,
        [element],
        pset,
    )

def create_archicad_properties_pset(model, owner_history, element, element_id: str):
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=owner_history,
        Name="ArchiCADProperties",
        HasProperties=[
            model.create_entity(
                "IfcPropertySingleValue",
                "GuidValue",
                None,
                model.create_entity("IfcLabel", str(ifcopenshell.guid.new())),
            )
        ],
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        ifcopenshell.guid.new(),
        owner_history,
        None,
        None,
        [element],
        pset,
    )

def _log_property_attachment(element, pset_name: str, prop_values: dict):
    print(f"  [DEBUG] Attached {pset_name}: {list(prop_values.keys())}")

def assign_default_ifc_properties(model, owner_history, element, entity_type: str = None, props_module=None, custom_overrides: dict = None, debug: bool = False, pset_names: List[str] = None):
    if not props_module:
        return
    
    entity_type = entity_type or element.is_a()
    defaults = {}
    metadata = {}
    allowed_psets = set(pset_names or [])

    if hasattr(props_module, "IFC_SCHEMA"):
        schema = props_module.IFC_SCHEMA
        aliases = getattr(props_module, "ENTITY_SCHEMA_ALIASES", {})
        lookup_names = [
            entity_type,
            aliases.get(entity_type),
            entity_type.replace("Ifc", "") if entity_type.startswith("Ifc") else entity_type,
            aliases.get(entity_type.replace("Ifc", "") if entity_type.startswith("Ifc") else entity_type),
        ]
        for cls_name in [name for name in lookup_names if name]:
            if cls_name in schema:
                schema_def = schema[cls_name]
                for pset_name, props in schema_def.get("psets", {}).items():
                    if allowed_psets and pset_name not in allowed_psets:
                        continue
                    pset_defaults = {}
                    pset_metadata = {}
                    for prop_name, prop_meta in props.items():
                        if "default" in prop_meta:
                            prop_value = prop_meta["default"]
                            if prop_value is None:
                                continue
                            pset_defaults[prop_name] = prop_value
                            pset_metadata[prop_name] = prop_meta
                    if pset_defaults:
                        defaults[pset_name] = pset_defaults
                        metadata[pset_name] = pset_metadata
                break
    elif hasattr(props_module, "get_default_pset"):
        defaults = props_module.get_default_pset(entity_type)
        if allowed_psets:
            defaults = {name: props for name, props in defaults.items() if name in allowed_psets}

    if custom_overrides:
        for pset_name, props in custom_overrides.items():
            if pset_name in defaults:
                defaults[pset_name].update(props)
            else:
                defaults[pset_name] = props

    if debug and not defaults:
        print(f"[IFC-DEBUG] No default schema properties found for entity_type={entity_type}")

    for pset_name, prop_values in defaults.items():
        pset = create_ifc_property_set(model, owner_history, element, pset_name, prop_values, property_metadata=metadata.get(pset_name, {}))
        if debug and pset is not None:
            _log_property_attachment(element, pset_name, prop_values)

def _infer_bhk_count(*texts) -> Optional[int]:
    joined = " ".join(str(text or "") for text in texts)
    match = re.search(r"\b([1-9])\s*[_ -]?\s*BHK\b", joined, re.I)
    if match:
        return int(match.group(1))
    return None

def _expected_minimum_counts(image_path: str, building_name: str = None) -> dict:
    bedrooms = _infer_bhk_count(image_path, building_name)
    if not bedrooms:
        return {"walls": 8, "openings": 3, "interiors": 4}
    return {
        "walls": max(8, 6 + bedrooms * 4),
        "openings": max(3, bedrooms * 4),
        "interiors": max(4, bedrooms * 4),
    }

def _extraction_summary(data: BuildingAnalysis) -> dict:
    return {
        "walls": len(data.walls or []),
        "openings": len(data.openings or []),
        "interiors": len(data.interiors or []),
    }

def _extraction_score(data: BuildingAnalysis) -> int:
    summary = _extraction_summary(data)
    return summary["walls"] * 3 + summary["openings"] * 2 + summary["interiors"]

def _is_extraction_suspicious(data: BuildingAnalysis, image_path: str) -> tuple[bool, dict, dict]:
    summary = _extraction_summary(data)
    expected = _expected_minimum_counts(image_path, data.building_name)
    suspicious = any(summary[key] < expected[key] for key in expected)
    return suspicious, summary, expected

def _plan_specific_prompt(image_path: str) -> str:
    bedrooms = _infer_bhk_count(image_path)
    if not bedrooms:
        return ""

    return (
        f"\nThis appears to be a {bedrooms} BHK plan from the file name. "
        f"Do not stop after one bedroom or one bathroom. Expect and search for all {bedrooms} bedrooms, "
        "their doors/windows, wardrobes/beds where shown, toilets/bath fixtures, kitchen fixtures/appliances, "
        "living/dining furniture, balcony/utility openings, and all internal partition wall segments.\n"
    )

def _build_extraction_prompt(image_path: str, repair_summary: dict = None, expected_summary: dict = None) -> str:
    repair_instruction = ""
    if repair_summary and expected_summary:
        repair_instruction = (
            "\nIMPORTANT RETRY: The previous extraction was incomplete "
            f"(walls={repair_summary['walls']}, openings={repair_summary['openings']}, interiors={repair_summary['interiors']}). "
            f"Re-extract from the image exhaustively. Aim for at least walls={expected_summary['walls']}, "
            f"openings={expected_summary['openings']}, interiors={expected_summary['interiors']} when visible. "
            "Do not return a representative subset.\n"
        )

    return (
        "Analyze the floor plan and extract detailed architectural data.\n"
        "Completeness is more important than rich properties. Never omit visible physical objects just to keep the JSON short.\n"
        "Do not merge repeated rooms/items into a single representative object.\n"
        f"{_plan_specific_prompt(image_path)}"
        f"{repair_instruction}\n"
        "1. Extract ALL straight wall segments using CENTERLINE coordinates so corners meet perfectly.\n"
        "   - Split walls at every corner, T-junction, door/window/opening gap, balcony break, and visible change in wall run.\n"
        "   - Include exterior walls, interior partitions, toilet/kitchen/utility partitions, balcony/parapet/outer walls, and short return walls.\n"
        "   - Do not simplify the plan to only the outer rectangle plus a few partitions.\n"
        "   - Estimate wall thickness from visual proportions, using thicker exterior walls and thinner interior partitions when visible.\n\n"
        "2. Identify ALL Doors and Windows as openings and specify their host wall.\n"
        "   - Include entrance doors, bedroom doors, toilet doors, kitchen/utility doors, balcony doors, sliding doors, windows, ventilators, and small toilet/kitchen windows.\n"
        "   - Treat arched doorways, arched openings, and portal-style openings as doors.\n"
        "   - Estimate exact width and height from the 2D drawing proportions.\n"
        "   - For each opening, set type to 'door' or 'window' and include operation_type when visible or inferable.\n"
        "   - Door operation_type examples: SINGLE_SWING_LEFT, SINGLE_SWING_RIGHT, DOUBLE_SWING_LEFT, DOUBLE_SWING_RIGHT, SLIDING, FOLDING.\n"
        "   - Window operation_type examples: SLIDING, CASEMENT, FIXEDLIGHT.\n"
        "   - Include material and RGB color [r, g, b] when inferable, e.g. Wood/Brown, Aluminium/Silver, Glass/Light blue.\n\n"
        "3. Identify ALL interior elements including furniture, sanitary components, and appliances.\n"
        "   - Include every visible bed, sofa segment, table, chair, wardrobe/closet, TV unit/cabinet, toilet/WC, wash basin, kitchen sink, shower, bathtub, refrigerator, stove/hob, microwave/oven, dishwasher, and washing machine.\n"
        "   - Every interior element should include category, type, material, color, dimensions, and optional properties.\n"
        "   - Use category exactly as one of: furnishing, sanitary, appliance.\n"
        "   - For furnishing type, use one of: SOFA, BED, CHAIR, TABLE, DESK, SHELF, FILECABINET, TV_UNIT, WARDROBE.\n"
        "   - For appliance type, use one of: REFRIGERATOR, WASHINGMACHINE, DISHWASHER, MICROWAVE, STOVE, COOKINGRANGE, OVEN, FREEZER.\n"
        "   - For sanitary type, use one of: WC, TOILET, WASHBASIN, SINK, SHOWER, BATH, BATHTUB, URINAL.\n"
        "   - Use properties as a short list of rows, not as a JSON object. Each row must be {\"name\":\"PropertyName\", \"value\":\"PropertyValue\", \"pset\":\"OptionalPsetName\"}.\n"
        "   - Add at most 3 property rows per element. If uncertain, leave properties empty rather than omitting the element.\n"
        "   - Useful property names include BedSize, SeatingCapacity, FrameMaterial, UpholsteryMaterial, TableShape, NumberOfShelves, DoorType, "
        "TotalVolumeCapacity, PowerRating, EnergyRating, LoadCapacity, BurnerCount, FuelType, FlushType, BowlCount, HasDrainer, MountingType.\n"
        "   - Estimate each element's real [width, depth, height] in meters from its drawn size relative to the floor plan.\n\n"
        "4. Classification examples:\n"
        "   - Bed: category=furnishing, type=BED, material=Teak Wood, color=[0.54,0.27,0.07], properties=[{\"name\":\"BedSize\",\"value\":\"Queen\",\"pset\":\"Pset_BedTypeCommon\"}].\n"
        "   - Fridge: category=appliance, type=REFRIGERATOR, material=Stainless Steel, color=[0.75,0.75,0.75], properties=[{\"name\":\"EnergyRating\",\"value\":\"3 Star\"}].\n"
        "   - Toilet/WC: category=sanitary, type=WC, material=Ceramic, color=[1.0,1.0,1.0], properties=[{\"name\":\"FlushType\",\"value\":\"Dual Flush\"}].\n\n"
        "Return the complete results in structured JSON according to the schema."
    )

# =====================================================================
# 2. API LOGIC (Centerline & Detail Extraction)
# =====================================================================
def analyze_floor_plan_detailed(image_path: str, allow_low_detail: bool = False) -> BuildingAnalysis:
    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit("[!] Error: GEMINI_API_KEY is not set.")
    client = genai.Client()

    ext = os.path.splitext(image_path)[1].lower()
    mime_map = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.svg': 'image/jpeg'
    }
    mime_type = mime_map.get(ext, 'application/octet-stream')
    
    with open(image_path, 'rb') as f:
        image_bytes = f.read()
        image_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
    
    def run_extraction(prompt: str, label: str) -> BuildingAnalysis:
        print(f"[API] Running Detailed Visual Extraction{label}...")
        response = client.models.generate_content(
            # model='gemini-2.5-flash',
            model='gemini-3-flash-preview',
            contents=[image_part, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=BuildingAnalysis,
                temperature=0.0,
                max_output_tokens=65535,
            ),
        )
        return response.parsed

    try:
        data = run_extraction(_build_extraction_prompt(image_path), "")
        suspicious, summary, expected = _is_extraction_suspicious(data, image_path)
        if suspicious:
            print(f"[API-WARN] Extraction looks incomplete: got {summary}, expected about {expected}. Retrying with stricter prompt.")
            retry_data = run_extraction(_build_extraction_prompt(image_path, summary, expected), " retry")
            retry_summary = _extraction_summary(retry_data)
            if _extraction_score(retry_data) >= _extraction_score(data):
                data = retry_data
                summary = retry_summary
            print(f"[API] Final extraction counts: {summary}")
            suspicious, summary, expected = _is_extraction_suspicious(data, image_path)
            if suspicious and not allow_low_detail:
                sys.exit(
                    "[API-ERROR] Extraction is still below expected completeness after retry: "
                    f"got {summary}, expected about {expected}. IFC was not written. "
                    "Use --allow-low-detail only if you intentionally want a partial model."
                )
        return data
    except (APIError, ServerError, ClientError) as e:
        print(f"[API-ERROR] GenAI API failed: {e}")
        sys.exit(2)
    except Exception as e:
        print(f"[API-ERROR] Unexpected error during visual extraction: {e}")
        print("Hint: check GEMINI_API_KEY, network access, and that the image MIME type matches the file.")
        sys.exit(3)

# --- NEW ASSET INSTANCING CACHE & FUNCTION ---
asset_cache = {}

def get_asset_representation(model, assets_dir, item_type):
    """Loads an external IFC asset and clones its 3D geometry into the new model."""
    if not assets_dir or not item_type: 
        return None
    
    filename_map = {
        "SOFA": "sofa_modern.ifc",
        "BED": "bed.ifc", 
        "TABLE": "table.ifc",
        "CHAIR": "chair.ifc",
        "WC": "wc.ifc",
        "WASHBASIN": "washbasin.ifc"
    }
    
    filename = filename_map.get(item_type.upper(), f"{item_type.lower()}.ifc")
    asset_path = os.path.join(assets_dir, filename)
    
    if not os.path.exists(asset_path):
        return None 
        
    if asset_path in asset_cache:
        return asset_cache[asset_path]
        
    try:
        asset_ifc = ifcopenshell.open(asset_path)
        for prod in asset_ifc.by_type("IfcProduct"):
            if prod.Representation:
                cloned_rep = model.add(prod.Representation)
                asset_cache[asset_path] = cloned_rep
                return cloned_rep
    except Exception as e:
        print(f"[Warning] Failed to load 3D asset {asset_path}: {e}")
        
    return None

# =====================================================================
# 3. BIM COMPILER (With Unpacking Fix)
# =====================================================================
def build_detailed_ifc(data: BuildingAnalysis, output_filepath: str, props_module=None, debug: bool = False, assets_dir: str = ""):
    print(f"Compiling High-Detail BIM...{' [DEBUG]' if debug else ''}")
    model = ifcopenshell.file(schema="IFC4")
    
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
    walls_polygons = []
    wall_map = {}

    # --- 1. WALLS ---
    for wall in data.walls:
        wall_unit = getattr(wall, "unit", "m") or "m"
        start_pt = _normalize_point(wall.start_pt, wall_unit)
        end_pt = _normalize_point(wall.end_pt, wall_unit)
        wall_thickness = _convert_to_meters(wall.thickness, wall_unit)
        wall_height = _convert_to_meters(wall.height, wall_unit)

        dx, dy = end_pt[0] - start_pt[0], end_pt[1] - start_pt[1]
        length = (dx**2 + dy**2)**0.5
        angle = math.atan2(dy, dx)
        
        wall_origin = model.create_entity("IfcCartesianPoint", Coordinates=(start_pt[0], start_pt[1], 0.0))
        wall_ax = model.create_entity("IfcAxis2Placement3D", Location=wall_origin, RefDirection=model.create_entity("IfcDirection", DirectionRatios=(math.cos(angle), math.sin(angle), 0.0)))
        wall_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=wall_ax)
        
        ifc_wall = model.create_entity(
            "IfcWallStandardCase",
            GlobalId=ifcopenshell.guid.new(),
            Name=wall.wall_id,
            ObjectPlacement=wall_loc,
        )
        wall_overrides = {
            "Pset_WallCommon": {
                "Thickness": wall_thickness * 1000.0,  
                "Height": wall_height,
                "OverallHeight": wall_height,
                "Width": wall_thickness,
                "OverallWidth": wall_thickness
            }
        }
        assign_default_ifc_properties(model, owner_h, ifc_wall, "IfcWall", props_module, custom_overrides=wall_overrides, debug=debug)

        pts = [model.create_entity("IfcCartesianPoint", Coordinates=c) for c in [(0., -wall_thickness/2), (length, -wall_thickness/2), (length, wall_thickness/2), (0., wall_thickness/2), (0., -wall_thickness/2)]]
        profile = model.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=model.create_entity("IfcPolyline", Points=pts))
        solid = model.create_entity("IfcExtridedAreaSolid" if hasattr(model, "IfcExtridedAreaSolid") else "IfcExtrudedAreaSolid", SweptArea=profile, Position=world_pl, ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.,0.,1.)), Depth=wall_height)

        rep = model.create_entity("IfcShapeRepresentation", ContextOfItems=context, RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[solid])
        ifc_wall.Representation = model.create_entity("IfcProductDefinitionShape", Representations=[rep])

        wall_quantities = {
            "Length": length,
            "Height": wall_height,
            "Width": wall_thickness,
            "GrossFootprintArea": length * wall_thickness,
            "NetFootprintArea": length * wall_thickness,
            "GrossVolume": length * wall_thickness * wall_height,
            "NetVolume": length * wall_thickness * wall_height,
        }
        create_ifc_quantity_set(model, owner_h, ifc_wall, "BaseQuantities", wall_quantities)
        create_archicad_name_pset(model, owner_h, ifc_wall, wall.wall_id)
        create_archicad_properties_pset(model, owner_h, ifc_wall, wall.wall_id)

        archicad_quantities = {
            "Höhe": wall_height,
            "Dicke": wall_thickness,
            "Wandlänge an der Außenseite": length + wall_thickness,
            "Wandlänge an der Innenseite": max(length - wall_thickness, 0.0),
            "Maximale Höhe der Wand": wall_height,
            "Minimale Höhe der Wand": wall_height,
            "Länge der Wand in der Achse": length,
            "Fläche": length * wall_thickness,
            "Netto-Volumen": length * wall_thickness * wall_height,
        }
        create_ifc_quantity_set(model, owner_h, ifc_wall, "ArchiCADQuantities", archicad_quantities)

        elements.append(ifc_wall)
        wall_map[wall.wall_id] = ifc_wall
        
        perp_x, perp_y = -math.sin(angle), math.cos(angle)
        t2 = wall_thickness / 2.0
        wp = [
            (start_pt[0] - perp_x * t2, start_pt[1] - perp_y * t2),
            (end_pt[0] - perp_x * t2, end_pt[1] - perp_y * t2),
            (end_pt[0] + perp_x * t2, end_pt[1] + perp_y * t2),
            (start_pt[0] + perp_x * t2, start_pt[1] + perp_y * t2),
        ]
        walls_polygons.append(wp)

    # --- 2. OPENINGS ---
    for op in data.openings:
        op_unit = getattr(op, "unit", "m") or "m"
        op_pt = _normalize_point(op.location_pt, op_unit)
        op_width = _convert_to_meters(op.width, op_unit)
        op_height = _convert_to_meters(op.height, op_unit)
        op_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(op_pt[0], op_pt[1], 0.0))))
        opening_type = normalize_opening_type(op.type)
        opening_spec = resolve_opening_spec(op, opening_type, props_module)
        
        parent_wall_id = getattr(op, "parent_wall_id", None)
        pset_key = opening_spec.get("pset")
        opening_material = getattr(op, "material", None) or _default_opening_material(opening_type)
        opening_color = getattr(op, "color", None) or _material_color(opening_material, props_module)
        opening_overrides = _build_property_overrides(
            pset_key,
            width=op_width,
            height=op_height,
            material=opening_material,
            color=opening_color,
            extra_properties=getattr(op, "properties", None),
        )

        opening_elem = model.create_entity("IfcOpeningElement", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_h, Name=f"Opening_{op.id}", ObjectPlacement=op_loc)
        if parent_wall_id and parent_wall_id in wall_map:
            host_wall = wall_map[parent_wall_id]
            model.create_entity(
                "IfcRelVoidsElement",
                GlobalId=ifcopenshell.guid.new(),
                OwnerHistory=owner_h,
                Name=None,
                Description=None,
                RelatingBuildingElement=host_wall,
                RelatedOpeningElement=opening_elem,
            )

        if opening_type == "window":
            ifc_ent = model.create_entity("IfcWindow", GlobalId=ifcopenshell.guid.new(), Name=op.id, ObjectPlacement=op_loc, OverallHeight=op_height, OverallWidth=op_width)
        else:
            ifc_ent = model.create_entity("IfcDoor", GlobalId=ifcopenshell.guid.new(), Name=op.id, ObjectPlacement=op_loc, OverallHeight=op_height, OverallWidth=op_width)

        _set_ifc_attribute(ifc_ent, opening_spec.get("predefined_attr"), opening_spec.get("predefined_type"))
        _set_ifc_attribute(ifc_ent, opening_spec.get("operation_attr"), opening_spec.get("operation_type"))

        model.create_entity(
            "IfcRelFillsElement",
            GlobalId=ifcopenshell.guid.new(),
            OwnerHistory=owner_h,
            Name=None,
            Description=None,
            RelatingOpeningElement=opening_elem,
            RelatedBuildingElement=ifc_ent,
        )

        assign_default_ifc_properties(model, owner_h, ifc_ent, opening_spec.get("schema_key") or ifc_ent.is_a(), props_module, custom_overrides=opening_overrides, debug=debug, pset_names=[pset_key])
        assign_material(model, owner_h, ifc_ent, opening_material)
        elements.append(opening_elem)
        elements.append(ifc_ent)

    # --- 3. INTERIOR ---
    for item in data.interiors:
        item_unit = getattr(item, "unit", "m") or "m"
        item_pt = _normalize_point(item.location_pt, item_unit)
        
        def aabb_from_center(cx, cy, half_w, half_d):
            return (cx - half_w, cy - half_d, cx + half_w, cy + half_d)

        def aabb_overlap(a, b):
            return not (a[2] <= b[0] or a[0] >= b[2] or a[3] <= b[1] or a[1] >= b[3])

        dims = [_convert_to_meters(v, item_unit) for v in item.dimensions]
        w = dims[0] if len(dims) > 0 else 0.8
        d = dims[1] if len(dims) > 1 else 0.8
        category_key = _normalize_mapping_key(item.category)
        h = dims[2] if len(dims) > 2 else (0.4 if category_key == "sanitary" else 0.8)

        half_w = w / 2.0
        half_d = d / 2.0
        min_half = 0.05
        max_iters = 20
        cx, cy = item_pt[0], item_pt[1]
        iter_count = 0
        while iter_count < max_iters:
            item_aabb = aabb_from_center(cx, cy, half_w, half_d)
            overlapped = False
            for wp in walls_polygons:
                minx = min(p[0] for p in wp); miny = min(p[1] for p in wp)
                maxx = max(p[0] for p in wp); maxy = max(p[1] for p in wp)
                wall_aabb = (minx, miny, maxx, maxy)
                if aabb_overlap(item_aabb, wall_aabb):
                    overlapped = True
                    half_w = max(half_w * 0.9, min_half)
                    half_d = max(half_d * 0.9, min_half)
                    break
            if not overlapped:
                break
            iter_count += 1

        item_loc = model.create_entity("IfcLocalPlacement", PlacementRelTo=stry_pl, RelativePlacement=model.create_entity("IfcAxis2Placement3D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(cx, cy, 0.0))))

        component_spec = resolve_component_spec(item, props_module)
        ifc_ent = model.create_entity(component_spec["ifc_class"], GlobalId=ifcopenshell.guid.new(), Name=item.id, ObjectPlacement=item_loc)
        _set_ifc_attribute(ifc_ent, component_spec.get("predefined_attr"), component_spec.get("predefined_type"))

        item_material = getattr(item, "material", None) or _default_component_material(item.category, component_spec.get("predefined_type"))
        visual_color = getattr(item, "color", None) or _material_color(item_material, props_module)
        interior_overrides = _build_property_overrides(
            component_spec["pset"],
            width=w,
            depth=d,
            height=h,
            material=item_material,
            color=visual_color,
            type_property=component_spec.get("type_property"),
            mapped_type=component_spec.get("predefined_type"),
            extra_properties=getattr(item, "properties", None),
        )
        assign_default_ifc_properties(
            model,
            owner_h,
            ifc_ent,
            component_spec.get("schema_key") or ifc_ent.is_a(),
            props_module,
            custom_overrides=interior_overrides,
            debug=debug,
            pset_names=component_spec.get("pset_names"),
        )
        assign_material(model, owner_h, ifc_ent, item_material)
        
        # --- TRY TO LOAD REAL 3D ASSET ---
        cloned_rep = get_asset_representation(model, assets_dir, component_spec.get("predefined_type"))
        
        if cloned_rep:
            ifc_ent.Representation = cloned_rep
        else:
            f_pts = [model.create_entity("IfcCartesianPoint", Coordinates=c) for c in [(-half_w, -half_d), (half_w, -half_d), (half_w, half_d), (-half_w, half_d), (-half_w, -half_d)] ]
            f_profile = model.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=model.create_entity("IfcPolyline", Points=f_pts))
            f_solid = model.create_entity("IfcExtrudedAreaSolid", SweptArea=f_profile, Position=world_pl, ExtrudedDirection=model.create_entity("IfcDirection", DirectionRatios=(0.,0.,1.)), Depth=h)
            
            if visual_color:
                assign_surface_style(model, f_solid, visual_color, style_name=f"{item.id}_Style")
                
            ifc_ent.Representation = model.create_entity("IfcProductDefinitionShape", Representations=[
                model.create_entity("IfcShapeRepresentation", ContextOfItems=context, RepresentationIdentifier="Body", RepresentationType="SweptSolid", Items=[f_solid])
            ])
            
        elements.append(ifc_ent)

    model.create_entity("IfcRelContainedInSpatialStructure", GlobalId=ifcopenshell.guid.new(), RelatingStructure=storey, RelatedElements=elements)
    model.write(output_filepath)
    print(f"[Success] Fully Detailed & Connected BIM Generated: {output_filepath}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="1 BHK HOUSE .jpg")
    parser.add_argument("--output", default="1_BHK_Detailed.ifc")
    parser.add_argument("--cache", default="1_BHK_Detailed_Cache.json")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--debug", action="store_true", help="Print debug logs")
    parser.add_argument("--allow-low-detail", action="store_true", help="Write the IFC even if AI extraction is incomplete")
    parser.add_argument("--assets", default="", help="Directory containing IFC asset files for furniture")
    args = parser.parse_args()

    if args.cache == parser.get_default("cache") and args.image != parser.get_default("image"):
        image_stem = os.path.splitext(os.path.basename(args.image))[0].strip().replace(" ", "_")
        args.cache = f"{image_stem}_Detailed_Cache.json"
        print(f"[Info] Using image-specific cache: {args.cache}")

    if os.path.exists(args.cache) and not args.force:
        with open(args.cache, 'r') as f:
            data = BuildingAnalysis(**json.load(f))
    else:
        data = analyze_floor_plan_detailed(args.image, allow_low_detail=args.allow_low_detail)
        with open(args.cache, 'w') as f:
            json.dump(data.model_dump(), f, indent=4)

    prop_paths = find_ifc_properties_files()
    if not prop_paths:
        sys.exit("[Error] No ifc_properties.py found in the search path.")

    ifc_props = load_ifc_properties_module(prop_paths[0])
    build_detailed_ifc(data, args.output, props_module=ifc_props, debug=args.debug, assets_dir=args.assets)