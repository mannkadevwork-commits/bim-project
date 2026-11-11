import * as WebIFC from 'web-ifc';
import { initializeWebIFCApi } from './webIfcRuntime';

const finite = (value) => Number.isFinite(Number(value));

function unwrap(value) {
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    if (!current || typeof current !== 'object') return current;
    if (Object.prototype.hasOwnProperty.call(current, 'value')) current = current.value;
    else return current;
  }
  return current;
}

function asId(value) {
  const raw = unwrap(value);
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function asArray(value) {
  const raw = unwrap(value);
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw.size === 'function' && typeof raw.get === 'function') {
    return Array.from({ length: raw.size() }, (_, index) => raw.get(index));
  }
  if (raw && typeof raw.length === 'number') return Array.from(raw);
  return [];
}

function lineText(line, field) {
  const value = unwrap(line?.[field]);
  return typeof value === 'string' ? value.trim() : '';
}

function direction(api, modelId, expressId, fallback) {
  if (!expressId) return fallback;
  const line = api.GetLine(modelId, expressId);
  const values = asArray(line?.DirectionRatios).map(Number);
  const candidate = [values[0], values[1], values[2] ?? 0];
  const length = Math.hypot(...candidate);
  return length > 1e-9 ? candidate.map((value) => value / length) : fallback;
}

function axisFrame(api, modelId, axisId) {
  if (!axisId) return null;
  const axis = api.GetLine(modelId, axisId);
  const locationId = asId(axis?.Location);
  if (!locationId) return null;
  const location = api.GetLine(modelId, locationId);
  const coordinates = asArray(location?.Coordinates).map(Number);
  const origin = [coordinates[0] || 0, coordinates[1] || 0, coordinates[2] || 0];
  const z = direction(api, modelId, asId(axis?.Axis), [0, 0, 1]);
  const ref = direction(api, modelId, asId(axis?.RefDirection), [1, 0, 0]);
  const dot = ref[0] * z[0] + ref[1] * z[1] + ref[2] * z[2];
  const x0 = [ref[0] - dot * z[0], ref[1] - dot * z[1], ref[2] - dot * z[2]];
  const xLen = Math.hypot(...x0) || 1;
  const x = x0.map((value) => value / xLen);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { origin, x, y, z };
}

function compose(parent, local) {
  const transform = (v) => [
    parent.x[0] * v[0] + parent.y[0] * v[1] + parent.z[0] * v[2],
    parent.x[1] * v[0] + parent.y[1] * v[1] + parent.z[1] * v[2],
    parent.x[2] * v[0] + parent.y[2] * v[1] + parent.z[2] * v[2],
  ];
  const shifted = transform(local.origin);
  return {
    origin: parent.origin.map((value, index) => value + shifted[index]),
    x: transform(local.x),
    y: transform(local.y),
    z: transform(local.z),
  };
}

function worldPlacement(api, modelId, placementId, depth = 0) {
  if (!placementId || depth > 32) return null;
  const placement = api.GetLine(modelId, placementId);
  const relativeId = asId(placement?.RelativePlacement);
  if (!relativeId) return null;
  const local = axisFrame(api, modelId, relativeId);
  if (!local) return null;
  const parentId = asId(placement?.PlacementRelTo);
  const parent = parentId ? worldPlacement(api, modelId, parentId, depth + 1) : null;
  return parent ? compose(parent, local) : local;
}

function convexHull(points) {
  const sorted = [...new Map(points
    .filter((point) => finite(point.x) && finite(point.y))
    .map((point) => [`${Number(point.x).toFixed(5)}:${Number(point.y).toFixed(5)}`, point]))
    .values()]
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 2) return sorted;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 1e-9) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 1e-9) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function applyMatrix(x, y, z, matrix) {
  if (matrix.length < 16) return { x, y, z };
  return {
    x: x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12],
    y: x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13],
    z: x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14],
  };
}

function idsWithType(api, modelId, type) {
  if (!Number.isFinite(type)) return [];
  return Array.from(api.GetLineIDsWithType(modelId, type) || []).map(Number);
}

/**
 * Builds a non-editable upload-time floor-plan preview directly from IFC data.
 * It intentionally displays extracted wall footprints plus IfcSpace placement
 * labels; it does not invent room polygons when the IFC does not provide them.
 */
export async function buildIfcFloorPlanPreview(file) {
  if (!file || !(file instanceof Blob)) throw new TypeError('An IFC File or Blob is required.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const api = new WebIFC.IfcAPI();
  await initializeWebIFCApi(api);
  const modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });

  try {
    const wallTypes = [WebIFC.IFCWALL, WebIFC.IFCWALLSTANDARDCASE].filter(Number.isFinite);
    const slabTypes = [WebIFC.IFCSLAB, WebIFC.IFCBASESLAB].filter(Number.isFinite);
    const wallIds = new Set(wallTypes.flatMap((type) => idsWithType(api, modelId, type)));
    const slabIds = new Set(slabTypes.flatMap((type) => idsWithType(api, modelId, type)));
    const spaces = idsWithType(api, modelId, WebIFC.IFCSPACE).map((expressId) => {
      const line = api.GetLine(modelId, expressId);
      const placement = worldPlacement(api, modelId, asId(line?.ObjectPlacement));
      if (!placement) return null;
      // HCI's current viewer plan plane is X/Z. WebIFC geometry's flat
      // transformations are already in the viewer world frame; IFC placements
      // are converted from source Z-up by [x, z, -y].
      return {
        id: String(unwrap(line?.GlobalId) || expressId),
        name: lineText(line, 'LongName') || lineText(line, 'Name') || `Space ${expressId}`,
        x: placement.origin[0],
        y: -placement.origin[1],
      };
    }).filter(Boolean);

    const wallPoints = new Map();
    const slabPoints = new Map();
    const targetIds = new Set([...wallIds, ...slabIds]);
    api.StreamAllMeshes(modelId, (flatMesh) => {
      const expressId = Number(flatMesh?.expressID);
      if (!targetIds.has(expressId)) return;
      const bucket = wallIds.has(expressId) ? wallPoints : slabPoints;
      const current = bucket.get(expressId) || [];
      const geometries = flatMesh.geometries;
      for (let index = 0; index < geometries.size(); index += 1) {
        const placed = geometries.get(index);
        const geometry = api.GetGeometry(modelId, placed.geometryExpressID);
        try {
          const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
          const matrix = Array.from(placed.flatTransformation || []);
          for (let vertex = 0; vertex < vertices.length; vertex += 6) {
            const point = applyMatrix(vertices[vertex], vertices[vertex + 1], vertices[vertex + 2], matrix);
            if (Number.isFinite(point.x) && Number.isFinite(point.z)) current.push({ x: point.x, y: point.z });
          }
        } finally {
          geometry?.delete?.();
        }
      }
      bucket.set(expressId, current);
    });

    const wallPolygons = Array.from(wallPoints.values()).map(convexHull).filter((polygon) => polygon.length >= 3);
    const slabPolygons = Array.from(slabPoints.values()).map(convexHull).filter((polygon) => polygon.length >= 3);
    const allWallPoints = wallPolygons.flat();
    const allSlabPoints = slabPolygons.flat();
    const domainPoints = allWallPoints.length ? allWallPoints : allSlabPoints;
    if (domainPoints.length < 3) {
      throw new Error('This IFC did not expose enough wall or slab geometry to build a floor-plan preview. You can still create the project and inspect it in the 3D viewer.');
    }

    const xs = domainPoints.map((point) => point.x);
    const ys = domainPoints.map((point) => point.y);
    const bounds = {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minY: Math.min(...ys), maxY: Math.max(...ys),
    };
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width < 0.1 || height < 0.1) {
      throw new Error('The IFC geometry does not form a horizontal floor-plan extent in the expected X/Z viewer plane.');
    }
    return {
      source: 'web-ifc-upload-preview',
      bounds,
      wallPolygons,
      slabPolygons,
      spaces,
      wallCount: wallPolygons.length,
      spaceCount: spaces.length,
      size: { width, height },
    };
  } finally {
    try { api.CloseModel(modelId); } catch { /* best effort */ }
  }
}
