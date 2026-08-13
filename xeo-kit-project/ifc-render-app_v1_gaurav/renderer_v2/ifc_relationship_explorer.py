"""
renderer_v2.ifc_relationship_explorer
=====================================
Implements a pure IFC graph traversal utility to inspect how an element's
visual appearance is authored in the source document.

This module walks the IFC relationship tree:
IfcProduct -> Representation -> Representations -> Items -> StyledByItem -> Styles

It extracts the nested hierarchy of:
- IfcProductDefinitionShape
- IfcShapeRepresentation
- IfcRepresentationItem
- IfcStyledItem
- IfcSurfaceStyle
- IfcSurfaceStyleRendering
- IfcColourRgb
- IfcMaterial (via IfcRelAssociatesMaterial)

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
        "ifcopenshell is required for renderer_v2.ifc_relationship_explorer. "
        "Install with: pip install ifcopenshell"
    ) from exc


# -----------------------------------------------------------------------------
# Strongly Typed Data Models
# -----------------------------------------------------------------------------

@dataclass
class IfcColourRGBData:
    r: float
    g: float
    b: float

@dataclass
class IfcSurfaceStyleRenderingData:
    transparency: Optional[float] = None
    diffuse_colour: Optional[IfcColourRGBData] = None

@dataclass
class IfcSurfaceStyleData:
    name: Optional[str] = None
    renderings: List[IfcSurfaceStyleRenderingData] = field(default_factory=list)

@dataclass
class IfcStyledItemData:
    name: Optional[str] = None
    styles: List[IfcSurfaceStyleData] = field(default_factory=list)

@dataclass
class IfcRepresentationItemData:
    ifc_type: str
    styled_items: List[IfcStyledItemData] = field(default_factory=list)

@dataclass
class IfcShapeRepresentationData:
    identifier: Optional[str] = None
    representation_type: Optional[str] = None
    items: List[IfcRepresentationItemData] = field(default_factory=list)

@dataclass
class IfcProductDefinitionShapeData:
    name: Optional[str] = None
    representations: List[IfcShapeRepresentationData] = field(default_factory=list)

@dataclass
class IfcMaterialRecord:
    ifc_type: str
    name: Optional[str] = None

@dataclass
class RelationshipReport:
    """The complete structured report of an element's appearance relationships."""
    global_id: str
    ifc_type: str
    name: Optional[str] = None
    shape: Optional[IfcProductDefinitionShapeData] = None
    materials: List[IfcMaterialRecord] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the report to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)


# -----------------------------------------------------------------------------
# Traversal Engine
# -----------------------------------------------------------------------------

def _extract_colour(colour_entity: Any) -> Optional[IfcColourRGBData]:
    if not colour_entity or not colour_entity.is_a("IfcColourRgb"):
        return None
    try:
        return IfcColourRGBData(
            r=float(colour_entity.Red),
            g=float(colour_entity.Green),
            b=float(colour_entity.Blue)
        )
    except Exception:
        return None


def _extract_rendering(rendering_entity: Any) -> IfcSurfaceStyleRenderingData:
    transparency = getattr(rendering_entity, "Transparency", None)
    diffuse = _extract_colour(getattr(rendering_entity, "SurfaceColour", None))
    
    return IfcSurfaceStyleRenderingData(
        transparency=float(transparency) if transparency is not None else None,
        diffuse_colour=diffuse
    )


def _extract_surface_style(style_entity: Any) -> IfcSurfaceStyleData:
    name = getattr(style_entity, "Name", None)
    renderings = []
    
    styles = getattr(style_entity, "Styles", [])
    for s in styles:
        if s and s.is_a("IfcSurfaceStyleRendering"):
            renderings.append(_extract_rendering(s))
            
    return IfcSurfaceStyleData(name=name, renderings=renderings)


def _extract_styled_item(styled_item_entity: Any) -> IfcStyledItemData:
    name = getattr(styled_item_entity, "Name", None)
    surface_styles = []
    
    styles = getattr(styled_item_entity, "Styles", [])
    for style in styles:
        if not style:
            continue
            
        # Handle IFC2x3 hierarchy (IfcPresentationStyleAssignment -> IfcSurfaceStyle)
        if style.is_a("IfcPresentationStyleAssignment"):
            assigned_styles = getattr(style, "Styles", [])
            for sub_style in assigned_styles:
                if sub_style and sub_style.is_a("IfcSurfaceStyle"):
                    surface_styles.append(_extract_surface_style(sub_style))
                    
        # Handle IFC4 hierarchy (Directly IfcSurfaceStyle)
        elif style.is_a("IfcSurfaceStyle"):
            surface_styles.append(_extract_surface_style(style))
            
    return IfcStyledItemData(name=name, styles=surface_styles)


def _extract_materials(product: Any) -> List[IfcMaterialRecord]:
    materials = []
    associations = getattr(product, "HasAssociations", [])
    
    for assoc in associations:
        if not assoc or not assoc.is_a("IfcRelAssociatesMaterial"):
            continue
            
        rel_mat = getattr(assoc, "RelatingMaterial", None)
        if not rel_mat:
            continue
            
        # Direct Material
        if rel_mat.is_a("IfcMaterial"):
            materials.append(IfcMaterialRecord(
                ifc_type=rel_mat.is_a(), 
                name=getattr(rel_mat, "Name", None)
            ))
            
        # List of Materials
        elif rel_mat.is_a("IfcMaterialList"):
            for mat in getattr(rel_mat, "Materials", []):
                if mat:
                    materials.append(IfcMaterialRecord(
                        ifc_type=mat.is_a(), 
                        name=getattr(mat, "Name", None)
                    ))
                    
        # Layer Sets (e.g. walls/slabs)
        elif rel_mat.is_a("IfcMaterialLayerSetUsage"):
            layer_set = getattr(rel_mat, "ForLayerSet", None)
            if layer_set:
                for layer in getattr(layer_set, "MaterialLayers", []):
                    mat = getattr(layer, "Material", None)
                    if mat:
                        materials.append(IfcMaterialRecord(
                            ifc_type=mat.is_a(), 
                            name=getattr(mat, "Name", None)
                        ))
                        
    return materials


def explore_by_global_id(ifc_file: "ifcopenshell.file", global_id: str) -> RelationshipReport:
    """
    Traverse the relationship graph for a given IFC element to extract its
    authorial shape and material definitions.

    Parameters
    ----------
    ifc_file
        An open ifcopenshell file instance.
    global_id
        The IFC GlobalId of the element to inspect.

    Returns
    -------
    RelationshipReport
        A strongly typed dataclass containing the nested styling and material
        data extracted from the document.
    """
    try:
        product = ifc_file.by_guid(global_id)
    except Exception:
        raise ValueError(f"Could not find element with GlobalId: {global_id}")

    if not product.is_a("IfcProduct"):
        raise ValueError(f"Entity '{global_id}' is not an IfcProduct.")

    report = RelationshipReport(
        global_id=global_id,
        ifc_type=product.is_a(),
        name=getattr(product, "Name", None)
    )

    # 1. Extract Materials
    report.materials = _extract_materials(product)

    # 2. Extract Shape and Styling
    representation = getattr(product, "Representation", None)
    if not representation or not representation.is_a("IfcProductDefinitionShape"):
        return report
        
    shape_data = IfcProductDefinitionShapeData(name=getattr(representation, "Name", None))
    
    reps = getattr(representation, "Representations", [])
    for rep in reps:
        if not rep or not rep.is_a("IfcShapeRepresentation"):
            continue
            
        rep_data = IfcShapeRepresentationData(
            identifier=getattr(rep, "RepresentationIdentifier", None),
            representation_type=getattr(rep, "RepresentationType", None)
        )
        
        items = getattr(rep, "Items", [])
        for item in items:
            if not item:
                continue
                
            item_data = IfcRepresentationItemData(ifc_type=item.is_a())
            
            # Inverse relationship: IfcStyledItem(s) pointing to this item
            styled_by = getattr(item, "StyledByItem", [])
            for styled_item in styled_by:
                if styled_item and styled_item.is_a("IfcStyledItem"):
                    item_data.styled_items.append(_extract_styled_item(styled_item))
                    
            rep_data.items.append(item_data)
            
        shape_data.representations.append(rep_data)

    report.shape = shape_data
    return report