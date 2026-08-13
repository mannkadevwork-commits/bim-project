import sys
import ifcopenshell
import ifcopenshell.geom

def convert_ifc_to_obj(ifc_path, obj_path):
    ifc = ifcopenshell.open(ifc_path)
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    vertices = []
    faces = []
    vertex_offset = 0

    products = ifc.by_type("IfcProduct")
    print(f"Found {len(products)} IFC products")

    for product in products:
        if product.Representation is None:
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
            geo = shape.geometry
            verts = geo.verts
            face_indices = geo.faces

            for i in range(0, len(verts), 3):
                vertices.append((verts[i], verts[i+1], verts[i+2]))

            for i in range(0, len(face_indices), 3):
                faces.append((
                    face_indices[i] + vertex_offset + 1,
                    face_indices[i+1] + vertex_offset + 1,
                    face_indices[i+2] + vertex_offset + 1
                ))

            vertex_offset += len(verts) // 3
        except Exception as e:
            print(f"  Skipping {product.is_a()}: {e}")

    print(f"Converted: {len(vertices)} vertices, {len(faces)} faces")

    with open(obj_path, 'w') as f:
        f.write(f"# IFC to OBJ conversion\n")
        f.write(f"# Vertices: {len(vertices)}, Faces: {len(faces)}\n")
        for v in vertices:
            f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        for face in faces:
            f.write(f"f {face[0]} {face[1]} {face[2]}\n")

    print(f"OBJ saved to: {obj_path}")

if __name__ == "__main__":
    ifc_path = sys.argv[1] if len(sys.argv) > 1 else "input.ifc"
    obj_path = sys.argv[2] if len(sys.argv) > 2 else "input.obj"
    convert_ifc_to_obj(ifc_path, obj_path)
