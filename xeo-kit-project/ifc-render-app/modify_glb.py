#!/usr/bin/env python3
import argparse
import math
from gltflib import GLTF

# The node index for "PALAZZO SOFA" based on your previous run
SOFA_NODE_INDEX = 76 

def rotate_x_in_place(matrix, angle_degrees):
    """
    Rotates a 4x4 column-major GLTF matrix around the X axis 
    without altering its translation coordinates.
    """
    rad = math.radians(angle_degrees)
    c = math.cos(rad)
    s = math.sin(rad)
    
    new_mat = list(matrix)
    
    # Extract translation to keep it locked in place
    tx = new_mat[12]
    ty = new_mat[13]
    tz = new_mat[14]

    # Rotate the X, Y, Z basis vectors around the X-axis
    for col in range(3):
        x = matrix[col * 4 + 0]
        y = matrix[col * 4 + 1]
        z = matrix[col * 4 + 2]
        
        new_mat[col * 4 + 0] = x
        new_mat[col * 4 + 1] = y * c - z * s
        new_mat[col * 4 + 2] = y * s + z * c

    # Restore the exact translation
    new_mat[12] = tx
    new_mat[13] = ty
    new_mat[14] = tz
    
    return new_mat

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="scene-zup.glb")
    parser.add_argument("--output", default="scene_test.glb")
    parser.add_argument("--x", type=float, default=0.0)
    parser.add_argument("--y", type=float, default=0.0)
    parser.add_argument("--z", type=float, default=0.0)
    parser.add_argument("--rot_x", type=float, default=0.0, help="Rotation around X-axis in degrees")
    args = parser.parse_args()

    gltf = GLTF.load(args.input)
    node = gltf.model.nodes[SOFA_NODE_INDEX]
    
    print(f"Targeting: {node.name}")

    # Apply relative translation offsets
    node.matrix[12] += args.x
    node.matrix[13] += args.y
    node.matrix[14] += args.z

    # Apply X-axis rotation
    if args.rot_x != 0.0:
        node.matrix = rotate_x_in_place(node.matrix, args.rot_x)

    gltf.export(args.output)
    
    print(f"Applied Offset: X={args.x}, Y={args.y}, Z={args.z}")
    print(f"Applied Rotation: {args.rot_x}° around X-axis")

if __name__ == "__main__":
    main()