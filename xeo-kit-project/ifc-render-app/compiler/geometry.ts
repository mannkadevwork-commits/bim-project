import * as WebIFC from 'web-ifc';
import * as fs from 'fs';
import * as path from 'path';
import { Document, Accessor, Node, Buffer, Texture } from '@gltf-transform/core';

interface StructuralEditEntry { visible?: boolean; }
interface MaterialDefinition {
    kind?: 'color' | 'fabric' | 'texture';
    color?: string;
    rgb: [number, number, number];
    texture?: { id?: string; name?: string; src?: string; repeat?: [number, number] } | null;
    roughness?: number;
    metallic?: number;
}

interface MaterialOverrideEntry extends MaterialDefinition {
    surfaceScope?: 'interior' | 'exterior' | 'both' | 'scoped' | null;
    surfaces?: {
        interior?: MaterialDefinition;
        exterior?: MaterialDefinition;
    };
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
        let u: number; let v: number;
        if (ny >= nx && ny >= nz) { u = x; v = z; }
        else if (nx >= nz) { u = z; v = y; }
        else { u = x; v = y; }
        uv[i * 2] = u * rx;
        uv[i * 2 + 1] = v * rz;
    }
    return uv;
}

interface WallContext {
    axis: 0 | 2;
    axisMin: number;
    axisMax: number;
    center: number;
    thickness: number;
    isExterior: boolean;
    interiorIsMinSide: boolean;
}

type Bounds6 = [number, number, number, number, number, number];

function expandBounds(bounds: Bounds6, p: { x: number; y: number; z: number }) {
    bounds[0] = Math.min(bounds[0], p.x);
    bounds[1] = Math.min(bounds[1], p.y);
    bounds[2] = Math.min(bounds[2], p.z);
    bounds[3] = Math.max(bounds[3], p.x);
    bounds[4] = Math.max(bounds[4], p.y);
    bounds[5] = Math.max(bounds[5], p.z);
}

function buildWallContexts(
    ifcApi: WebIFC.IfcAPI,
    modelId: number,
    materialOverrides: Record<string, MaterialOverrideEntry>,
): Map<number, WallContext> {
    const scopedGlobalIds = new Set(
        Object.entries(materialOverrides)
            .filter(([, value]) => value?.surfaceScope === 'scoped' || ['interior', 'exterior', 'both'].includes(String(value?.surfaceScope)))
            .map(([globalId]) => globalId)
    );
    if (!scopedGlobalIds.size) return new Map();

    const wallExpressIds = new Set<number>();
    for (const type of [WebIFC.IFCWALL, WebIFC.IFCWALLSTANDARDCASE]) {
        const ids = ifcApi.GetLineIDsWithType(modelId, type) as any;
        for (const id of (Array.from(ids || []) as unknown[])) wallExpressIds.add(Number(id));
    }

    const relevantWallIds = new Set<number>();
    for (const globalId of scopedGlobalIds) {
        try {
            const expressId = Number(ifcApi.GetExpressIdFromGuid(modelId, globalId));
            if (wallExpressIds.has(expressId)) relevantWallIds.add(expressId);
        } catch (_) {
            // Ignore stale/non-wall material entries.
        }
    }
    if (!relevantWallIds.size) return new Map();

    // Build a compact geometric footprint for all walls so an exterior wall can
    // be distinguished from an interior partition without relying on triangle
    // winding. We deliberately collect only wall bounds here; the main pass
    // still owns all final GLTF geometry creation.
    const wallBounds = new Map<number, Bounds6>();
    const allWallBounds: Bounds6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

    const allWallIdsArray = Array.from(wallExpressIds);
    ifcApi.StreamMeshes(modelId, allWallIdsArray, (flatMesh: WebIFC.FlatMesh) => {
        const expressID = Number(flatMesh.expressID);
        if (!wallExpressIds.has(expressID)) return;

        let bounds = wallBounds.get(expressID);
        if (!bounds) {
            bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            wallBounds.set(expressID, bounds);
        }

        const geometries = flatMesh?.geometries;
        if (!geometries) return;
        for (let i = 0; i < geometries.size(); i++) {
            const placed = geometries.get(i);
            const geometry = ifcApi.GetGeometry(modelId, placed.geometryExpressID);
            try {
                const vertexData = ifcApi.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
                const matrix = Array.from(placed.flatTransformation || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]) as number[];
                for (let v = 0; v < vertexData.length / 6; v++) {
                    const p = applyMatrix(vertexData[v * 6], vertexData[v * 6 + 1], vertexData[v * 6 + 2], matrix);
                    expandBounds(bounds, p);
                    expandBounds(allWallBounds, p);
                }
            } finally {
                try { geometry.delete(); } catch (_) {}
            }
        }
    });

    if (!Number.isFinite(allWallBounds[0])) return new Map();

    const result = new Map<number, WallContext>();
    for (const expressID of relevantWallIds) {
        const bounds = wallBounds.get(expressID);
        if (!bounds || !Number.isFinite(bounds[0])) continue;

        const sizeX = bounds[3] - bounds[0];
        const sizeZ = bounds[5] - bounds[2];
        const axis: 0 | 2 = sizeX <= sizeZ ? 0 : 2;
        const axisMin = bounds[axis];
        const axisMax = bounds[axis + 3];
        const center = (axisMin + axisMax) * 0.5;
        const thickness = Math.max(axisMax - axisMin, 1e-5);

        // A wall is external when its centre lies near the outer envelope in
        // the wall thickness direction. Internal partitions have clearance on
        // both sides of the overall wall envelope and therefore treat both
        // faces as interior surfaces.
        const globalMin = allWallBounds[axis];
        const globalMax = allWallBounds[axis + 3];
        const exteriorTolerance = Math.max(thickness * 1.5, 0.05);
        const nearMinBoundary = Math.abs(center - globalMin) <= exteriorTolerance;
        const nearMaxBoundary = Math.abs(center - globalMax) <= exteriorTolerance;
        const isExterior = nearMinBoundary || nearMaxBoundary;
        const globalCenter = (globalMin + globalMax) * 0.5;
        const interiorIsMinSide = globalCenter <= center;

        result.set(expressID, {
            axis,
            axisMin,
            axisMax,
            center,
            thickness,
            isExterior,
            interiorIsMinSide,
        });
    }
    return result;
}

function isScopedOverride(override?: MaterialOverrideEntry): boolean {
    return !!override && (
        override.surfaceScope === 'scoped' ||
        override.surfaceScope === 'interior' ||
        override.surfaceScope === 'exterior' ||
        override.surfaceScope === 'both'
    );
}

function getRequestedSurfaceDefinitions(override: MaterialOverrideEntry): Array<{ side: 'interior' | 'exterior'; definition: MaterialDefinition }> {
    if (override.surfaceScope === 'scoped' || override.surfaces) {
        const result: Array<{ side: 'interior' | 'exterior'; definition: MaterialDefinition }> = [];
        if (override.surfaces?.interior) result.push({ side: 'interior', definition: override.surfaces.interior });
        if (override.surfaces?.exterior) result.push({ side: 'exterior', definition: override.surfaces.exterior });
        return result;
    }
    if (override.surfaceScope === 'interior') return [{ side: 'interior', definition: override }];
    if (override.surfaceScope === 'exterior') return [{ side: 'exterior', definition: override }];
    if (override.surfaceScope === 'both') return [{ side: 'interior', definition: override }, { side: 'exterior', definition: override }];
    return [];
}

function createMaterialFromDefinition(
    doc: Document,
    definition: MaterialDefinition,
    sourceColor: [number, number, number, number],
    assetsDirectory?: string,
    idPrefix = 'material',
): { material: any; texture: Texture | null } {
    const [r, g, b] = Array.isArray(definition.rgb) ? definition.rgb : [sourceColor[0], sourceColor[1], sourceColor[2]];
    const alpha = sourceColor[3] === 0 || sourceColor[3] === undefined ? 1 : sourceColor[3];
    const material = doc.createMaterial(idPrefix)
        .setBaseColorFactor([r, g, b, alpha])
        .setDoubleSided(true)
        .setRoughnessFactor(definition.roughness ?? 0.8)
        .setMetallicFactor(definition.metallic ?? 0.1);

    let texture: Texture | null = null;
    if ((definition.kind === 'fabric' || definition.kind === 'texture') && definition.texture?.src) {
        const texturePath = resolveTexturePath(definition.texture.src, assetsDirectory);
        if (texturePath) {
            texture = createTexture(doc, texturePath, `Tex_${idPrefix}_${definition.texture.id || 'material'}`);
            material.setBaseColorTexture(texture);
        }
    }
    return { material, texture };
}

function addTrianglePrimitive(
    doc: Document,
    buffer: Buffer,
    rootNode: Node,
    positions: number[],
    normals: number[],
    indices: number[],
    sourceColor: [number, number, number, number],
    definition: MaterialDefinition,
    assetsDirectory: string | undefined,
    nodeName: string,
): void {
    if (!positions.length) return;
    const positionArray = new Float32Array(positions);
    const normalArray = new Float32Array(normals);
    const uv = buildBoxProjectedUVs(positionArray, normalArray, definition.texture?.repeat || [1, 1]);
    const indexAccessor = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint32Array(indices)).setBuffer(buffer);
    const positionAccessor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positionArray).setBuffer(buffer);
    const normalAccessor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(normalArray).setBuffer(buffer);
    const uvAccessor = doc.createAccessor().setType(Accessor.Type.VEC2).setArray(uv).setBuffer(buffer);
    const { material, texture } = createMaterialFromDefinition(doc, definition, sourceColor, assetsDirectory, nodeName);
    const primitive = doc.createPrimitive()
        .setAttribute('POSITION', positionAccessor)
        .setAttribute('NORMAL', normalAccessor)
        .setAttribute('TEXCOORD_0', uvAccessor)
        .setIndices(indexAccessor)
        .setMaterial(material);
    const gltfMesh = doc.createMesh(`Mesh_${nodeName}`).addPrimitive(primitive);
    const geometryNode = doc.createNode(`Geom_${nodeName}`).setMesh(gltfMesh);
    rootNode.addChild(geometryNode);
    // Keep texture owned by the document graph; no explicit destroy needed.
    void texture;
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
    const hasScopedWalls = Object.values(materialOverrides || {}).some(isScopedOverride);
    const wallContexts = hasScopedWalls ? buildWallContexts(ifcApi, modelId, materialOverrides || {}) : new Map<number, WallContext>();

    ifcApi.StreamAllMeshes(modelId, (flatMesh: WebIFC.FlatMesh) => {
        const globalId = needsGlobalId ? getGlobalId(ifcApi, modelId, flatMesh.expressID) : null;
        if (structuralEdits && globalId && structuralEdits[globalId]?.visible === false) return;

        const materialOverride = materialOverrides && globalId ? materialOverrides[globalId] : undefined;
        const size = flatMesh.geometries.size();
        const wallContext = materialOverride && wallContexts.get(Number(flatMesh.expressID));

        for (let i = 0; i < size; i++) {
            const placedGeometry = flatMesh.geometries.get(i);
            const geometry = ifcApi.GetGeometry(modelId, placedGeometry.geometryExpressID);
            const indicesWASM = ifcApi.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize()) as unknown as number[];
            const verticesWASM = ifcApi.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize()) as unknown as number[];
            const numVertices = verticesWASM.length / 6;
            const positions = new Float32Array(numVertices * 3);
            const normals = new Float32Array(numVertices * 3);
            const matrix = Array.from(placedGeometry.flatTransformation) as number[];

            try {
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

                const { x: r, y: g, z: b, w: a } = placedGeometry.color;
                const safeAlpha = (a === 0 || a === undefined) ? 1.0 : a;

                if (wallContext && isScopedOverride(materialOverride)) {
                    const requested = getRequestedSurfaceDefinitions(materialOverride);
                    const requestedBySide = new Map<'interior' | 'exterior', MaterialDefinition>();

                    for (const entry of requested) {
                        requestedBySide.set(entry.side, entry.definition);
                    }

                    // Build ONE complete wall primitive set. A scoped finish changes
                    // only the requested surface; the opposite wall face and all
                    // non-side geometry must remain present with the original IFC
                    // appearance. The previous implementation emitted only the
                    // requested face and therefore made the opposite face disappear
                    // in the 360 render.
                    const buckets = new Map<string, {
                        positions: number[];
                        normals: number[];
                        indices: number[];
                        definition: MaterialDefinition;
                    }>();

                    const nativeDefinition: MaterialDefinition = {
                        rgb: [r, g, b],
                        roughness: 0.8,
                        metallic: 0.1,
                    };

                    const getBucket = (key: string, definition: MaterialDefinition) => {
                        let bucket = buckets.get(key);
                        if (!bucket) {
                            bucket = {
                                positions: [],
                                normals: [],
                                indices: [],
                                definition,
                            };
                            buckets.set(key, bucket);
                        }
                        return bucket;
                    };

                    const addTriangle = (
                        bucket: {
                            positions: number[];
                            normals: number[];
                            indices: number[];
                            definition: MaterialDefinition;
                        },
                        ia: number,
                        ib: number,
                        ic: number,
                    ) => {
                        for (const index of [ia, ib, ic]) {
                            bucket.positions.push(
                                positions[index * 3],
                                positions[index * 3 + 1],
                                positions[index * 3 + 2],
                            );
                            bucket.normals.push(
                                normals[index * 3],
                                normals[index * 3 + 1],
                                normals[index * 3 + 2],
                            );
                            bucket.indices.push(bucket.indices.length);
                        }
                    };

                    const axis = wallContext.axis;
                    const axisMin = wallContext.axisMin;
                    const axisMax = wallContext.axisMax;
                    const sideTolerance = Math.max(wallContext.thickness * 0.25, 0.002);

                    for (let t = 0; t < indicesWASM.length; t += 3) {
                        const ia = Number(indicesWASM[t]);
                        const ib = Number(indicesWASM[t + 1]);
                        const ic = Number(indicesWASM[t + 2]);

                        const p0Axis = positions[ia * 3 + axis];
                        const p1Axis = positions[ib * 3 + axis];
                        const p2Axis = positions[ic * 3 + axis];
                        const triCenterAxis = (p0Axis + p1Axis + p2Axis) / 3;

                        const e1x = positions[ib * 3] - positions[ia * 3];
                        const e1y = positions[ib * 3 + 1] - positions[ia * 3 + 1];
                        const e1z = positions[ib * 3 + 2] - positions[ia * 3 + 2];
                        const e2x = positions[ic * 3] - positions[ia * 3];
                        const e2y = positions[ic * 3 + 1] - positions[ia * 3 + 1];
                        const e2z = positions[ic * 3 + 2] - positions[ia * 3 + 2];

                        const fnx = e1y * e2z - e1z * e2y;
                        const fny = e1z * e2x - e1x * e2z;
                        const fnz = e1x * e2y - e1y * e2x;
                        const fl = Math.hypot(fnx, fny, fnz);

                        let side: 'interior' | 'exterior' | null = null;

                        // Only the two large wall faces aligned with the wall
                        // thickness axis are classified as interior/exterior.
                        // Header, sill, and other thickness-direction geometry
                        // continue using the native IFC material.
                        if (fl >= 1e-9) {
                            const thicknessNormal =
                                axis === 0
                                    ? Math.abs(fnx) / fl
                                    : Math.abs(fnz) / fl;

                            const distMin = Math.abs(triCenterAxis - axisMin);
                            const distMax = Math.abs(triCenterAxis - axisMax);
                            const nearSide = Math.min(distMin, distMax) <= sideTolerance;

                            if (thicknessNormal >= 0.65 && nearSide) {
                                const minSide = distMin <= distMax;

                                if (!wallContext.isExterior) {
                                    // Interior partition: both physical faces
                                    // are interior surfaces.
                                    side = 'interior';
                                } else {
                                    const isInteriorFace =
                                        minSide === wallContext.interiorIsMinSide;
                                    side = isInteriorFace ? 'interior' : 'exterior';
                                }
                            }
                        }

                        // If the user requested a scoped side and this triangle is
                        // that side, render it with the scoped definition. Otherwise
                        // preserve the original IFC appearance.
                        const overrideDefinition = side ? requestedBySide.get(side) : undefined;
                        const definition = overrideDefinition || nativeDefinition;
                        const bucketKey = overrideDefinition
                            ? `override:${side}`
                            : 'native';

                        addTriangle(getBucket(bucketKey, definition), ia, ib, ic);
                    }

                    for (const [key, bucket] of buckets) {
                        addTrianglePrimitive(
                            doc,
                            buffer,
                            rootNode,
                            bucket.positions,
                            bucket.normals,
                            bucket.indices,
                            [r, g, b, safeAlpha],
                            bucket.definition,
                            assetsDirectory,
                            `${flatMesh.expressID}_${i}_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
                        );
                    }

                    continue;
                }

                const indexAccessor = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint32Array(indicesWASM)).setBuffer(buffer);
                const positionAccessor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positions).setBuffer(buffer);
                const normalAccessor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(normals).setBuffer(buffer);

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
            } finally {
                try { geometry.delete(); } catch (_) {}
            }
        }
    });

    return rootNode;
}
