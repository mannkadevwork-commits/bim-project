import ifcopenshell
import ifcopenshell.api

# 1. Initialize Model & Context
model = ifcopenshell.file(schema="IFC4")
project = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Furniture Project")
ifcopenshell.api.run("unit.assign_unit", model)
context = ifcopenshell.api.run("context.add_context", model, context_type="Model")
body = ifcopenshell.api.run("context.add_context", model, context_type="Model", 
                            context_identifier="Body", target_view="MODEL_VIEW", parent=context)

# 2. Setup Spatial Structure
site = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcSite", name="Site")
building = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuilding", name="Building")
storey = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuildingStorey", name="Storey")
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=project, products=[site])
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=site, products=[building])
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=building, products=[storey])

# 3. Create Styles (Colors) for the 3D Viewer
wood_style = ifcopenshell.api.run("style.add_style", model, name="Wood")
ifcopenshell.api.run("style.add_surface_style", model, style=wood_style, 
                     attributes={"SurfaceColour": { "Name": None, "Red": 0.4, "Green": 0.2, "Blue": 0.1 }})

fabric_white = ifcopenshell.api.run("style.add_style", model, name="White Fabric")
ifcopenshell.api.run("style.add_surface_style", model, style=fabric_white, 
                     attributes={"SurfaceColour": { "Name": None, "Red": 0.9, "Green": 0.9, "Blue": 0.9 }})

fabric_blue = ifcopenshell.api.run("style.add_style", model, name="Blue Fabric")
ifcopenshell.api.run("style.add_surface_style", model, style=fabric_blue, 
                     attributes={"SurfaceColour": { "Name": None, "Red": 0.2, "Green": 0.4, "Blue": 0.7 }})

# 4. Helper to create Extruded Boxes with Color
def create_styled_box(name, x, y, z, width, depth, height, style):
    obj = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcFurniture", name=name)
    
    # Create rectangular profile
    pt1 = model.createIfcCartesianPoint((0.0, 0.0))
    pt2 = model.createIfcCartesianPoint((width, 0.0))
    pt3 = model.createIfcCartesianPoint((width, depth))
    pt4 = model.createIfcCartesianPoint((0.0, depth))
    polyline = model.createIfcPolyline([pt1, pt2, pt3, pt4, pt1])
    profile = model.createIfcArbitraryClosedProfileDef("AREA", None, polyline)
    
    # Extrude
    extrusion_dir = model.createIfcDirection((0.0, 0.0, 1.0))
    extrusion_pos = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((0.0, 0.0, 0.0)))
    solid = model.createIfcExtrudedAreaSolid(profile, extrusion_pos, extrusion_dir, height)
    
    rep = model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
    model.createIfcProductDefinitionShape(None, None, [rep])
    obj.Representation = model.by_type("IfcProductDefinitionShape")[-1]
    
    # Apply placement
    matrix = [[1.0, 0.0, 0.0, x], 
              [0.0, 1.0, 0.0, y], 
              [0.0, 0.0, 1.0, z], 
              [0.0, 0.0, 0.0, 1.0]]
    ifcopenshell.api.run("geometry.edit_object_placement", model, product=obj, matrix=matrix)
    
    # Apply color
    ifcopenshell.api.run("style.assign_representation_styles", model, shape_representation=rep, styles=[style])
    return obj

# 5. Build the Bed Assembly
bed_assembly = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcFurniture", name="Premium Bed")
ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=[bed_assembly])

# Parts
frame = create_styled_box("Frame", 0, 0, 0.1, 1.6, 2.1, 0.2, wood_style)
headboard = create_styled_box("Headboard", 0, 2.05, 0.1, 1.6, 0.15, 1.1, wood_style)
mattress = create_styled_box("Mattress", 0.05, 0.05, 0.3, 1.5, 2.0, 0.25, fabric_white)
pillow_1 = create_styled_box("Pillow Left", 0.2, 1.6, 0.55, 0.5, 0.35, 0.1, fabric_blue)
pillow_2 = create_styled_box("Pillow Right", 0.9, 1.6, 0.55, 0.5, 0.35, 0.1, fabric_blue)
runner = create_styled_box("Bed Runner", 0.05, 0.3, 0.55, 1.5, 0.5, 0.02, fabric_blue)
legs = [create_styled_box(f"Leg_{i}", x, y, 0, 0.08, 0.08, 0.1, wood_style) 
        for i, (x, y) in enumerate([(0.05, 0.05), (1.47, 0.05), (0.05, 1.97), (1.47, 1.97)])]

# Group parts into the assembly
parts = [frame, headboard, mattress, pillow_1, pillow_2, runner] + legs
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=bed_assembly, products=parts)

# 6. Export
output_file = "bed.ifc"
model.write(output_file)
print(f"✅ Success! Advanced IFC exported: {output_file}")