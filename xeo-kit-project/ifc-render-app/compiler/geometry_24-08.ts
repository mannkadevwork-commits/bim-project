import * as WebIFC from 'web-ifc';
import { Document, Accessor, Node, Buffer } from '@gltf-transform/core';

interface StructuralEditEntry {
    visible?: boolean;
}

interface MaterialOverrideEntry {
    rgb: [number, number, number];
}

export interface ExtractGeometryOptions {
    structuralEdits?: Record<string, StructuralEditEntry>;
    materialOverrides?: Record<string, MaterialOverrideEntry>;
}

function applyMatrix(x: number, y: number, z: number, m: number[]) {
    return {
        x: x * m[0] + y * m[4] + z * m[8] + m[12],
        y: x * m[1] + y * m[5] + z * m[9] + m[13],
        z: x * m[2] + y * m[6] + z * m[10] + m[14]
    };
}

function getGlobalId(ifcApi: WebIFC.IfcAPI, modelId: number, expressID: number): string | null {
    try {
        const line = ifcApi.GetLine(modelId, expressID);
        const globalId = line?.GlobalId?.value;
        return typeof globalId === 'string' ? globalId : null;
    } catch {
        return null;
    }
}

export function extractGeometry(
    ifcApi: WebIFC.IfcAPI,
    modelId: number,
    doc: Document,
    buffer: Buffer,
    nodeName: string,
    options?: ExtractGeometryOptions
): Node {
    const rootNode = doc.createNode(nodeName);
    const structuralEdits = options?.structuralEdits;
    const materialOverrides = options?.materialOverrides;
    const needsGlobalId = Boolean(structuralEdits || materialOverrides);

    ifcApi.StreamAllMeshes(modelId, (flatMesh: WebIFC.FlatMesh) => {
        const globalId = needsGlobalId ? getGlobalId(ifcApi, modelId, flatMesh.expressID) : null;
        if (globalId) {
    console.log(
        "[extractGeometry]",
        nodeName,
        globalId
    );
}

        if (structuralEdits && globalId && structuralEdits[globalId]?.visible === false) {
            return;
        }

        const colorOverride = materialOverrides && globalId ? materialOverrides[globalId] : undefined;

        const size = flatMesh.geometries.size();

        for (let i = 0; i < size; i++) {
            const placedGeometry = flatMesh.geometries.get(i);
            const geometry = ifcApi.GetGeometry(modelId, placedGeometry.geometryExpressID);

            const indicesWASM = ifcApi.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
            const verticesWASM = ifcApi.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());

            const numVertices = verticesWASM.length / 6;
            const positions = new Float32Array(numVertices * 3);
            const normals = new Float32Array(numVertices * 3);

            const matrix = Array.from(placedGeometry.flatTransformation);

            for (let v = 0; v < numVertices; v++) {
                const rawX = verticesWASM[v * 6 + 0];
                const rawY = verticesWASM[v * 6 + 1];
                const rawZ = verticesWASM[v * 6 + 2];

                const bakedPos = applyMatrix(rawX, rawY, rawZ, matrix);

                positions[v * 3 + 0] = bakedPos.x;
                positions[v * 3 + 1] = bakedPos.y;
                positions[v * 3 + 2] = bakedPos.z;

                const rawNx = verticesWASM[v * 6 + 3];
                const rawNy = verticesWASM[v * 6 + 4];
                const rawNz = verticesWASM[v * 6 + 5];

                normals[v * 3 + 0] = rawNx * matrix[0] + rawNy * matrix[4] + rawNz * matrix[8];
                normals[v * 3 + 1] = rawNx * matrix[1] + rawNy * matrix[5] + rawNz * matrix[9];
                normals[v * 3 + 2] = rawNx * matrix[2] + rawNy * matrix[6] + rawNz * matrix[10];
            }

            const indexAccessor = doc.createAccessor()
                .setType(Accessor.Type.SCALAR)
                .setArray(new Uint32Array(indicesWASM))
                .setBuffer(buffer);

            const positionAccessor = doc.createAccessor()
                .setType(Accessor.Type.VEC3)
                .setArray(positions)
                .setBuffer(buffer);

            const normalAccessor = doc.createAccessor()
                .setType(Accessor.Type.VEC3)
                .setArray(normals)
                .setBuffer(buffer);

            const { x: r, y: g, z: b, w: a } = placedGeometry.color;
            const safeAlpha = (a === 0 || a === undefined) ? 1.0 : a;
            const [finalR, finalG, finalB] = colorOverride ? colorOverride.rgb : [r, g, b];

            const material = doc.createMaterial(`Mat_${flatMesh.expressID}`)
                .setBaseColorFactor([finalR, finalG, finalB, safeAlpha])
                .setDoubleSided(true)
                .setRoughnessFactor(0.8)
                .setMetallicFactor(0.1);

            const primitive = doc.createPrimitive()
                .setAttribute('POSITION', positionAccessor)
                .setAttribute('NORMAL', normalAccessor)
                .setIndices(indexAccessor)
                .setMaterial(material);

            const gltfMesh = doc.createMesh(`Mesh_${flatMesh.expressID}`).addPrimitive(primitive);

            const geometryNode = doc.createNode(`Geom_${flatMesh.expressID}_${i}`)
                .setMesh(gltfMesh);

            rootNode.addChild(geometryNode);
        }
    });

    return rootNode;
}