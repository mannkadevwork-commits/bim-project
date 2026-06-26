import ifcopenshell
import ifcopenshell.api

# 1. Initialize File & Project
model = ifcopenshell.file(schema="IFC4")
project = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Flat Plan Project")
ifcopenshell.api.run("unit.assign_unit", model)

# 2. Simple Main Context (No SubContexts, matching input.ifc)
origin = model.createIfcCartesianPoint((0.0, 0.0, 0.0))
wcs = model.createIfcAxis2Placement3D(origin)
context = model.createIfcGeometricRepresentationContext(
    ContextIdentifier='Model', ContextType='Model', 
    CoordinateSpaceDimension=3, Precision=1e-05, WorldCoordinateSystem=wcs
)
project.RepresentationContexts = [context]

# 3. Simple Spatial Hierarchy
site = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcSite", name="My Site")
building = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuilding", name="Building A")
storey = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcBuildingStorey", name="Ground Floor")

ifcopenshell.api.run("aggregate.assign_object", model, relating_object=project, products=[site])
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=site, products=[building])
ifcopenshell.api.run("aggregate.assign_object", model, relating_object=building, products=[storey])

# 4. Create the ONE Absolute Global Placement (matching line #22 in input.ifc)
global_origin = model.createIfcCartesianPoint((0.0, 0.0, 0.0))
global_z = model.createIfcDirection((0.0, 0.0, 1.0))
global_x = model.createIfcDirection((1.0, 0.0, 0.0))
global_axis = model.createIfcAxis2Placement3D(global_origin, global_z, global_x)
# Explicitly omitting the 'PlacementRelTo' argument creates an absolute placement ($)
absolute_placement = model.createIfcLocalPlacement(None, global_axis)

# 5. Helper Function for Absolute Polylines
def create_absolute_element(ifc_class, name, points, height):
    obj = ifcopenshell.api.run("root.create_entity", model, ifc_class=ifc_class, name=name)
    
    # Draw points exactly at absolute world coordinates
    ifc_pts = [model.createIfcCartesianPoint((float(p[0]), float(p[1]))) for p in points]
    ifc_pts.append(ifc_pts[0]) # Close the loop
    polyline = model.createIfcPolyline(ifc_pts)
    profile = model.createIfcArbitraryClosedProfileDef("AREA", None, polyline)
    
    # Extrude straight up from 0,0,0
    extrusion_dir = model.createIfcDirection((0.0, 0.0, 1.0))
    extrusion_pos = model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((0.0, 0.0, 0.0)))
    solid = model.createIfcExtrudedAreaSolid(profile, extrusion_pos, extrusion_dir, height)
    
    # Assign geometry to the main context
    rep = model.createIfcShapeRepresentation(context, "Body", "SweptSolid", [solid])
    model.createIfcProductDefinitionShape(None, None, [rep])
    obj.Representation = model.by_type("IfcProductDefinitionShape")[-1]
    
    # Hardcode the absolute placement ($)
    obj.ObjectPlacement = absolute_placement
    return obj

# 6. Build the Geometry with Absolute Corner Coordinates
elements_to_contain = []

# Room Volume (10x15)
room = create_absolute_element("IfcSpace", "10x15_Room", [(0,0), (10,0), (10,15), (0,15)], 3.0)
elements_to_contain.append(room)

# Walls (0.2 thick)
south_wall = create_absolute_element("IfcWall", "South_Wall", [(0,0), (10,0), (10,0.2), (0,0.2)], 3.0)
north_wall = create_absolute_element("IfcWall", "North_Wall", [(0,14.8), (10,14.8), (10,15.0), (0,15.0)], 3.0)
west_wall = create_absolute_element("IfcWall", "West_Wall", [(0,0.2), (0.2,0.2), (0.2,14.8), (0,14.8)], 3.0)
east_wall = create_absolute_element("IfcWall", "East_Wall", [(9.8,0.2), (10,0.2), (10,14.8), (9.8,14.8)], 3.0)
elements_to_contain.extend([south_wall, north_wall, west_wall, east_wall])

# Bed (1.5 x 2.0, placed roughly in the middle)
bed = create_absolute_element("IfcFurnishingElement", "Bed", [(4.25,6.5), (5.75,6.5), (5.75,8.5), (4.25,8.5)], 0.5)
elements_to_contain.append(bed)

# 7. Batch assign EVERYTHING directly to the Storey (matching input.ifc #13)
ifcopenshell.api.run("spatial.assign_container", model, relating_structure=storey, products=elements_to_contain)

# 8. Export
output_file = "Viewer_Friendly_10x15.ifc"
model.write(output_file)
print(f"Generated flattened IFC file: {output_file}")