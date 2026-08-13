"""
renderer_v2.ifc_appearance_extractor
====================================
Implements the Multi-Representation Appearance Extractor for Renderer V2.

Extracts authored appearance information per IfcRepresentationItem, providing
a direct mapping for future glTF primitives. Responsibilities for geometric 
styles (colors/textures) and semantic materials (IfcMaterial) are strictly 
separated into distinct internal extractors.

Explicitly Out of Scope:
- Geometry generation or parsing.
- Material resolution (choosing between native style vs override).
- RenderScene modifications.
"""

from __future__ import annotations
import dataclasses
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

try:
    import ifcopenshell
except ImportError as exc:
    raise ImportError(
        "ifcopenshell is required for renderer_v2.ifc_appearance_extractor. "
        "Install with: pip install ifcopenshell"
    ) from exc


# -----------------------------------------------------------------------------
# Strongly Typed Data Models
# -----------------------------------------------------------------------------

@dataclass
class RgbColor:
    r: float
    g: float
    b: float

@dataclass
class ItemAppearance:
    """Authored appearance data keyed to a specific IfcRepresentationItem."""
    item_id: int
    ifc_type: str
    style_name: Optional[str] = None
    surface_colour: Optional[RgbColor] = None
    diffuse_colour: Optional[RgbColor] = None
    reflection_colour: Optional[RgbColor] = None
    specular_colour: Optional[RgbColor] = None
    transparency: Optional[float] = None
    reflectance_method: Optional[str] = None
    has_texture: bool = False  # Hook for future IfcSurfaceStyleWithTextures

@dataclass
class MaterialRecord:
    """Authored semantic material association data."""
    ifc_type: str
    name: Optional[str] = None

@dataclass
class AppearanceDiagnostic:
    severity: str
    message: str
    item_id: Optional[int] = None

@dataclass
class AppearanceData:
    """The complete appearance definition for one IfcProduct."""
    global_id: str
    # Keyed by RepresentationItem ID to map cleanly to glTF primitives
    items: Dict[int, ItemAppearance] = field(default_factory=dict)
    materials: List[MaterialRecord] = field(default_factory=list)
    diagnostics: List[AppearanceDiagnostic] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


# -----------------------------------------------------------------------------
# Internal Extractors
# -----------------------------------------------------------------------------

class MaterialExtractor:
    """Responsible exclusively for extracting semantic IfcMaterial associations."""
    
    @staticmethod
    def extract(product: Any, diagnostics: List[AppearanceDiagnostic]) -> List[MaterialRecord]:
        materials = []
        try:
            associations = getattr(product, "HasAssociations", [])
            for assoc in associations:
                if not assoc or not assoc.is_a("IfcRelAssociatesMaterial"):
                    continue
                    
                rel_mat = getattr(assoc, "RelatingMaterial", None)
                if not rel_mat:
                    continue
                    
                if rel_mat.is_a("IfcMaterial"):
                    materials.append(MaterialRecord(ifc_type=rel_mat.is_a(), name=getattr(rel_mat, "Name", None)))
                    
                elif rel_mat.is_a("IfcMaterialList"):
                    for mat in getattr(rel_mat, "Materials", []):
                        if mat and mat.is_a("IfcMaterial"):
                            materials.append(MaterialRecord(ifc_type=mat.is_a(), name=getattr(mat, "Name", None)))
                            
                elif rel_mat.is_a("IfcMaterialLayerSetUsage"):
                    layer_set = getattr(rel_mat, "ForLayerSet", None)
                    if layer_set:
                        for layer in getattr(layer_set, "MaterialLayers", []):
                            mat = getattr(layer, "Material", None)
                            if mat:
                                materials.append(MaterialRecord(ifc_type=mat.is_a(), name=getattr(mat, "Name", None)))
        except Exception as exc:
            diagnostics.append(AppearanceDiagnostic("warning", f"Failed to extract materials: {exc}"))

        return materials


class StyleExtractor:
    """Responsible exclusively for extracting visual styles (colours/textures)."""
    
    @staticmethod
    def _extract_rgb(colour_entity: Any) -> Optional[RgbColor]:
        if not colour_entity or not colour_entity.is_a("IfcColourRgb"):
            return None
        try:
            return RgbColor(float(colour_entity.Red), float(colour_entity.Green), float(colour_entity.Blue))
        except Exception:
            return None

    @classmethod
    def process_surface_style(cls, style_entity: Any, item_id: int, ifc_type: str, diagnostics: List[AppearanceDiagnostic]) -> Optional[ItemAppearance]:
        name = getattr(style_entity, "Name", None)
        appearance = ItemAppearance(item_id=item_id, ifc_type=ifc_type, style_name=name)
        found_data = False

        try:
            styles = getattr(style_entity, "Styles", [])
            for rendering in styles:
                if not rendering:
                    continue

                # 1. Standard Rendering (PBR/Phong base)
                if rendering.is_a("IfcSurfaceStyleRendering"):
                    transparency = getattr(rendering, "Transparency", None)
                    appearance.surface_colour = cls._extract_rgb(getattr(rendering, "SurfaceColour", None))
                    appearance.diffuse_colour = cls._extract_rgb(getattr(rendering, "DiffuseColour", None))
                    appearance.reflection_colour = cls._extract_rgb(getattr(rendering, "ReflectionColour", None))
                    appearance.specular_colour = cls._extract_rgb(getattr(rendering, "SpecularColour", None))
                    appearance.transparency = float(transparency) if transparency is not None else None
                    appearance.reflectance_method = getattr(rendering, "ReflectanceMethod", None)
                    found_data = True
                
                # 2. Simple Shading (Fallback/Flat colour)
                elif rendering.is_a("IfcSurfaceStyleShading"):
                    appearance.surface_colour = cls._extract_rgb(getattr(rendering, "SurfaceColour", None))
                    found_data = True
                    
                # 3. Texture Maps (Hook for future implementation)
                elif rendering.is_a("IfcSurfaceStyleWithTextures"):
                    appearance.has_texture = True
                    found_data = True
                    # TODO (Future PR): Extract IfcBlobTexture / IfcImageTexture paths here

        except Exception as exc:
            diagnostics.append(AppearanceDiagnostic("warning", f"Failed to process IfcSurfaceStyle: {exc}", item_id))
        
        return appearance if found_data else None


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

def extract_appearance_by_global_id(ifc_file: "ifcopenshell.file", global_id: str) -> AppearanceData:
    """
    Traverses the relationship graph for an IFC element to extract its authored 
    appearance definitions, keyed by RepresentationItem.
    """
    data = AppearanceData(global_id=global_id)
    
    try:
        product = ifc_file.by_guid(global_id)
    except Exception as exc:
        data.diagnostics.append(AppearanceDiagnostic("error", f"Could not find element: {exc}"))
        return data

    if not product.is_a("IfcProduct"):
        data.diagnostics.append(AppearanceDiagnostic("error", f"Entity is not an IfcProduct."))
        return data

    # Route semantic material parsing
    data.materials = MaterialExtractor.extract(product, data.diagnostics)

    # Route geometric style parsing
    representation = getattr(product, "Representation", None)
    if not representation or not representation.is_a("IfcProductDefinitionShape"):
        return data

    try:
        for rep in getattr(representation, "Representations", []):
            if not rep or not rep.is_a("IfcShapeRepresentation"):
                continue

            for item in getattr(rep, "Items", []):
                if not item:
                    continue
                
                item_id = item.id()
                item_type = item.is_a()

                try:
                    for styled_item in getattr(item, "StyledByItem", []):
                        if not styled_item or not styled_item.is_a("IfcStyledItem"):
                            continue
                            
                        for style in getattr(styled_item, "Styles", []):
                            if not style:
                                continue
                                
                            # IFC2x3 (IfcPresentationStyleAssignment)
                            if style.is_a("IfcPresentationStyleAssignment"):
                                for sub_style in getattr(style, "Styles", []):
                                    if sub_style and sub_style.is_a("IfcSurfaceStyle"):
                                        appearance = StyleExtractor.process_surface_style(sub_style, item_id, item_type, data.diagnostics)
                                        if appearance:
                                            data.items[item_id] = appearance
                                            
                            # IFC4 (Direct IfcSurfaceStyle)
                            elif style.is_a("IfcSurfaceStyle"):
                                appearance = StyleExtractor.process_surface_style(style, item_id, item_type, data.diagnostics)
                                if appearance:
                                    data.items[item_id] = appearance
                                    
                except Exception as exc:
                    data.diagnostics.append(AppearanceDiagnostic("warning", f"Failed traversing StyledByItem: {exc}", item_id))
    
    except Exception as exc:
        data.diagnostics.append(AppearanceDiagnostic("error", f"Critical Representation traversal failure: {exc}"))

    return data