import * as WebIFC from 'web-ifc';
import * as fs from 'fs';
import * as path from 'path';
import { Document, Accessor, Node, Buffer, Texture } from '@gltf-transform/core';

interface StructuralEditEntry { visible?: boolean; }
interface MaterialOverrideEntry {
    kind?: 'color' | 'fabric' | 'texture';
    color?: string;
    rgb: [number, number, number];
    texture?: { id?: string; name?: string; src?: string; repeat?: [number, number] } | null;
    roughness?: number;
    metallic?: number;
}

export interface ExtractGeometryOptions {
    structuralEdits?: Record<string, StructuralEditEntry>;
    materialOverrides?: Record<string, MaterialOverrideEntry>;
    assetsDirectory?: string;
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

function resolveTexturePath(src: string | undefined, assetsDirectory?: string): string | null {
    if (!src) return null;
    const clean = String(src).split('?')[0].split('#')[0];
    if (clean.startsWith('/materials/')) {
        const compilerPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', clean.slice(1));
        return fs.existsSync(compilerPath) ? compilerPath : null;
    }
    if (clean.startsWith('/assets/')) {
        const candidate = path.resolve(assetsDirectory || '', clean.slice('/assets/'.length));
        return fs.existsSync(candidate) ? candidate : null;
    }
    if (path.isAbsolute(clean) && fs.existsSync(clean)) return clean;
    if (assetsDirectory) {
        const candidate = path.resolve(assetsDirectory, clean);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function mimeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    return 'image/png';
}

function createTexture(doc: Document, texturePath: string, id: string): Texture {
    return doc.createTexture(id)
        .setMimeType(mimeFor(texturePath))
        .setImage(fs.readFileSync(texturePath));
}

function buildBoxProjectedUVs(positions: Float32Array, normals: Float32Array, repeat: [number, number]): Float32Array {
    const uv = new Float32Array((positions.length / 3) * 2);
    const rx = Math.max(0.01, repeat[0]);
    const rz = Math.max(0.01, repeat[1]);
    for (let i = 0; i < positions.length / 3; i++) {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        const nx = Math.abs(normals[i * 3]), ny = Math.abs(normals[i * 3 + 1]), nz = Math.abs(normals[i * 3 + 2]);
        let u; let v;
        if (ny >= nx && ny >= nz) { u = x; v = z; }
        else if (nx >= nz) { u = z; v = y; }
        else { u = x; v = y; }
        uv[i * 2] = u * rx;
        uv[i * 2 + 1] = v * rz;
    }
    return uv;
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
    const assetsDirectory = options?.assetsDirectory;
    const needsGlobalId = Boolean(structuralEdits || materialOverrides);

    ifcApi.StreamAllMeshes(modelId, (flatMesh: WebIFC.FlatMesh) => {
        const globalId = needsGlobalId ? getGlobalId(ifcApi, modelId, flatMesh.expressID) : null;
        if (structuralEdits && globalId && structuralEdits[globalId]?.visible === false) return;

        const materialOverride = materialOverrides && globalId ? materialOverrides[globalId] : undefined;
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
                positions[v * 3] = bakedPos.x;
                positions[v * 3 + 1] = bakedPos.y;
                positions[v * 3 + 2] = bakedPos.z;
                const rawNx = verticesWASM[v * 6 + 3];
                const rawNy = verticesWASM[v * 6 + 4];
                const rawNz = verticesWASM[v * 6 + 5];
                normals[v * 3] = rawNx * matrix[0] + rawNy * matrix[4] + rawNz * matrix[8];
                normals[v * 3 + 1] = rawNx * matrix[1] + rawNy * matrix[5] + rawNz * matrix[9];
                normals[v * 3 + 2] = rawNx * matrix[2] + rawNy * matrix[6] + rawNz * matrix[10];
            }

            const indexAccessor = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint32Array(indicesWASM)).setBuffer(buffer);
            const positionAccessor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positions).setBuffer(buffer);
            const normalAccessor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(normals).setBuffer(buffer);

            const { x: r, y: g, z: b, w: a } = placedGeometry.color;
            const safeAlpha = (a === 0 || a === undefined) ? 1.0 : a;
            const [finalR, finalG, finalB] = materialOverride ? materialOverride.rgb : [r, g, b];
            const repeat = materialOverride?.texture?.repeat || [1, 1];
            const uv = buildBoxProjectedUVs(positions, normals, repeat);
            const uvAccessor = doc.createAccessor().setType(Accessor.Type.VEC2).setArray(uv).setBuffer(buffer);

            const material = doc.createMaterial(`Mat_${flatMesh.expressID}_${i}`)
                .setBaseColorFactor([finalR, finalG, finalB, safeAlpha])
                .setDoubleSided(true)
                .setRoughnessFactor(materialOverride?.roughness ?? 0.8)
                .setMetallicFactor(materialOverride?.metallic ?? 0.1);

            if ((materialOverride?.kind === 'fabric' || materialOverride?.kind === 'texture') && materialOverride.texture?.src) {
                const texturePath = resolveTexturePath(materialOverride.texture.src, assetsDirectory);
                if (texturePath) {
                    material.setBaseColorTexture(createTexture(doc, texturePath, `Tex_${materialOverride.texture.id || flatMesh.expressID}_${i}`));
                }
            }

            const primitive = doc.createPrimitive()
                .setAttribute('POSITION', positionAccessor)
                .setAttribute('NORMAL', normalAccessor)
                .setAttribute('TEXCOORD_0', uvAccessor)
                .setIndices(indexAccessor)
                .setMaterial(material);

            const gltfMesh = doc.createMesh(`Mesh_${flatMesh.expressID}_${i}`).addPrimitive(primitive);
            const geometryNode = doc.createNode(`Geom_${flatMesh.expressID}_${i}`).setMesh(gltfMesh);
            rootNode.addChild(geometryNode);
        }
    });

    return rootNode;
}
