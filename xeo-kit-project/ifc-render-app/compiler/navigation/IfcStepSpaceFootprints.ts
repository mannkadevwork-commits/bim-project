/**
 * Minimal, defensive IFC STEP reader for explicit IfcSpace floor footprints.
 *
 * This is intentionally independent of web-ifc GetLine() object wrappers.
 * It supports the common Coordination View pattern used by HCI default models:
 * IfcSpace -> IfcProductDefinitionShape -> IfcShapeRepresentation('Body' or
 * 'FootPrint') -> IfcExtrudedAreaSolid -> IfcArbitraryClosedProfileDef ->
 * IfcPolyline -> IfcCartesianPoint.
 *
 * Wall-mesh reconstruction remains the primary fallback for IFCs without these
 * explicit profiles. Unsupported curves/solids are reported, not guessed.
 */

import * as fs from "fs";

export interface StepRoomPoint {
  x: number;
  y: number;
}

export interface StepSpaceFootprint {
  expressId: number;
  name: string;
  polygon: StepRoomPoint[];
  areaM2: number;
  representation: "Body" | "FootPrint";
}

type StepRef = { ref: number };
type StepValue = null | number | string | StepRef | StepValue[];
interface StepEntity {
  id: number;
  type: string;
  args: StepValue[];
}
interface Vec3 { x: number; y: number; z: number }
interface Frame {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  zAxis: Vec3;
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "'") {
      if (quoted && input[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail || input.trim()) parts.push(tail);
  return parts;
}

function parseStepValue(token: string): StepValue {
  const value = token.trim();
  if (!value || value === "$" || value === "*") return null;
  const reference = value.match(/^#(\d+)$/);
  if (reference) return { ref: Number(reference[1]) };
  if (value.startsWith("(") && value.endsWith(")")) {
    const inside = value.slice(1, -1).trim();
    return inside ? splitTopLevel(inside).map(parseStepValue) : [];
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (value.startsWith(".") && value.endsWith(".")) return value.slice(1, -1).toUpperCase();
  return value;
}

function parseEntities(stepText: string): Map<number, StepEntity> {
  const entities = new Map<number, StepEntity>();
  const recordPattern = /^\s*#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = recordPattern.exec(stepText))) {
    const id = Number(match[1]);
    const type = match[2].toUpperCase();
    const openParenIndex = recordPattern.lastIndex - 1;
    let depth = 1;
    let quoted = false;
    let end = -1;
    for (let i = openParenIndex + 1; i < stepText.length; i++) {
      const char = stepText[i];
      if (char === "'") {
        if (quoted && stepText[i + 1] === "'") { i++; continue; }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    const argsRaw = stepText.slice(openParenIndex + 1, end);
    const args = splitTopLevel(argsRaw).map(parseStepValue);
    entities.set(id, { id, type, args });
    // Move the global matcher past this complete record. STEP strings can
    // contain text that resembles #123=..., so don't scan inside the record.
    recordPattern.lastIndex = end + 1;
    const semicolon = stepText.indexOf(";", end + 1);
    if (semicolon >= 0) recordPattern.lastIndex = semicolon + 1;
  }
  return entities;
}

function ref(value: StepValue | undefined): number | null {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as StepRef).ref === "number"
    ? (value as StepRef).ref
    : null;
}

function array(value: StepValue | undefined): StepValue[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: StepValue | undefined, fallback = Number.NaN): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalized(vector: Vec3, fallback: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length < 1e-10) return fallback;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function transformVector(frame: Frame, vector: Vec3): Vec3 {
  return {
    x: frame.xAxis.x * vector.x + frame.yAxis.x * vector.y + frame.zAxis.x * vector.z,
    y: frame.xAxis.y * vector.x + frame.yAxis.y * vector.y + frame.zAxis.y * vector.z,
    z: frame.xAxis.z * vector.x + frame.yAxis.z * vector.y + frame.zAxis.z * vector.z,
  };
}
function compose(parent: Frame, local: Frame): Frame {
  const translated = transformVector(parent, local.origin);
  return {
    origin: {
      x: parent.origin.x + translated.x,
      y: parent.origin.y + translated.y,
      z: parent.origin.z + translated.z,
    },
    xAxis: normalized(transformVector(parent, local.xAxis), parent.xAxis),
    yAxis: normalized(transformVector(parent, local.yAxis), parent.yAxis),
    zAxis: normalized(transformVector(parent, local.zAxis), parent.zAxis),
  };
}

function createStepReader(entities: Map<number, StepEntity>) {
  const readPoint = (id: number | null): Vec3 => {
    const entity = id == null ? null : entities.get(id);
    if (!entity || entity.type !== "IFCCARTESIANPOINT") return { x: 0, y: 0, z: 0 };
    const coords = array(entity.args[0]).map((v) => numberValue(v));
    return { x: coords[0] || 0, y: coords[1] || 0, z: coords[2] || 0 };
  };
  const readDirection = (id: number | null, fallback: Vec3): Vec3 => {
    const entity = id == null ? null : entities.get(id);
    if (!entity || entity.type !== "IFCDIRECTION") return fallback;
    const ratios = array(entity.args[0]).map((v) => numberValue(v));
    return normalized({ x: ratios[0] ?? fallback.x, y: ratios[1] ?? fallback.y, z: ratios[2] ?? fallback.z }, fallback);
  };
  const readAxisPlacement = (id: number | null): Frame | null => {
    const entity = id == null ? null : entities.get(id);
    if (!entity) return null;
    if (entity.type === "IFCAXIS2PLACEMENT3D") {
      const origin = readPoint(ref(entity.args[0]));
      const zAxis = readDirection(ref(entity.args[1]), { x: 0, y: 0, z: 1 });
      const reference = readDirection(ref(entity.args[2]), { x: 1, y: 0, z: 0 });
      const projection = dot(reference, zAxis);
      const xAxis = normalized({
        x: reference.x - zAxis.x * projection,
        y: reference.y - zAxis.y * projection,
        z: reference.z - zAxis.z * projection,
      }, { x: 1, y: 0, z: 0 });
      const yAxis = normalized(cross(zAxis, xAxis), { x: 0, y: 1, z: 0 });
      return { origin, xAxis, yAxis, zAxis };
    }
    if (entity.type === "IFCAXIS2PLACEMENT2D") {
      const origin = readPoint(ref(entity.args[0]));
      const refDirEntity = ref(entity.args[1]);
      const refDirection = readDirection(refDirEntity, { x: 1, y: 0, z: 0 });
      const xAxis = normalized({ x: refDirection.x, y: refDirection.y, z: 0 }, { x: 1, y: 0, z: 0 });
      const zAxis = { x: 0, y: 0, z: 1 };
      const yAxis = normalized(cross(zAxis, xAxis), { x: 0, y: 1, z: 0 });
      return { origin, xAxis, yAxis, zAxis };
    }
    return null;
  };
  const placementCache = new Map<number, Frame | null>();
  const readLocalPlacement = (id: number | null, depth = 0): Frame | null => {
    if (id == null || depth > 40) return null;
    if (placementCache.has(id)) return placementCache.get(id) || null;
    const entity = entities.get(id);
    if (!entity || entity.type !== "IFCLOCALPLACEMENT") return null;
    const parentId = ref(entity.args[0]);
    const relative = readAxisPlacement(ref(entity.args[1]));
    if (!relative) return null;
    const parent = parentId == null ? null : readLocalPlacement(parentId, depth + 1);
    const result = parent ? compose(parent, relative) : relative;
    placementCache.set(id, result);
    return result;
  };
  return { readPoint, readAxisPlacement, readLocalPlacement };
}

function polygonArea(points: StepRoomPoint[]): number {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    twiceArea += points[i].x * next.y - next.x * points[i].y;
  }
  return Math.abs(twiceArea) * 0.5;
}

function readPolyline(entities: Map<number, StepEntity>, curveId: number): StepRoomPoint[] {
  const curve = entities.get(curveId);
  if (!curve || curve.type !== "IFCPOLYLINE") return [];
  const points: StepRoomPoint[] = [];
  for (const pointValue of array(curve.args[0])) {
    const pointId = ref(pointValue);
    const point = pointId == null ? null : entities.get(pointId);
    if (!point || point.type !== "IFCCARTESIANPOINT") continue;
    const coords = array(point.args[0]).map((v) => numberValue(v));
    const x = coords[0];
    const y = coords[1];
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-7) points.pop();
  }
  return points.length >= 3 ? points : [];
}

/**
 * Parse explicit space footprints from an IFC STEP file. Unit conversion is
 * passed from the same IFC unit resolver used by the geometry detector.
 */
export function readIfcStepSpaceFootprints(
  filePath: string,
  unitToMeters = 1,
): { footprints: Map<number, StepSpaceFootprint>; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const footprints = new Map<number, StepSpaceFootprint>();
  if (!filePath || !fs.existsSync(filePath)) {
    return { footprints, diagnostics: ["IFC STEP footprint fallback skipped: source file path is unavailable."] };
  }

  let entities: Map<number, StepEntity>;
  try {
    entities = parseEntities(fs.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    return { footprints, diagnostics: [`IFC STEP footprint fallback could not parse source: ${String(error?.message || error)}`] };
  }
  const { readAxisPlacement, readLocalPlacement } = createStepReader(entities);
  const safeScale = Number.isFinite(unitToMeters) && unitToMeters > 0 ? unitToMeters : 1;
  let spaceCount = 0;
  let profileCandidates = 0;

  const transformPlanPoint = (frame: Frame, point: StepRoomPoint): StepRoomPoint => {
    const worldX = frame.origin.x + frame.xAxis.x * point.x + frame.yAxis.x * point.y;
    const worldY = frame.origin.y + frame.xAxis.y * point.x + frame.yAxis.y * point.y;
    // Source IFC is Z-up; the editor's horizontal plan is X/Z, with IFC Y
    // inverted to preserve the same plan handedness as the existing detector.
    return { x: worldX * safeScale, y: -worldY * safeScale };
  };

  for (const entity of entities.values()) {
    if (entity.type !== "IFCSPACE") continue;
    spaceCount++;
    const name = String(entity.args[7] ?? entity.args[2] ?? `IFC Space ${entity.id}`);
    const objectFrame = readLocalPlacement(ref(entity.args[5]));
    const productShape = entities.get(ref(entity.args[6]) ?? -1);
    if (!objectFrame || !productShape || productShape.type !== "IFCPRODUCTDEFINITIONSHAPE") continue;

    let best: StepSpaceFootprint | null = null;
    for (const representationValue of array(productShape.args[2])) {
      const representation = entities.get(ref(representationValue) ?? -1);
      if (!representation || representation.type !== "IFCSHAPEREPRESENTATION") continue;
      const identifier = String(representation.args[1] ?? "").toUpperCase();
      const representationType = identifier === "FOOTPRINT" ? "FootPrint" : "Body";
      if (identifier && identifier !== "BODY" && identifier !== "FOOTPRINT") continue;

      for (const itemValue of array(representation.args[3])) {
        const itemId = ref(itemValue);
        const item = itemId == null ? null : entities.get(itemId);
        if (!item) continue;
        let localPolygon: StepRoomPoint[] = [];
        let itemFrame: Frame = objectFrame;

        if (representationType === "FootPrint" && item.type === "IFCPOLYLINE" && itemId != null) {
          localPolygon = readPolyline(entities, itemId);
        } else if (representationType === "Body" && item.type === "IFCEXTRUDEDAREASOLID") {
          const profile = entities.get(ref(item.args[0]) ?? -1);
          if (!profile || (profile.type !== "IFCARBITRARYCLOSEDPROFILEDEF" && profile.type !== "IFCARBITRARYPROFILEDEFWITHVOIDS")) continue;
          const curveId = ref(profile.args[2]);
          if (curveId == null) continue;
          localPolygon = readPolyline(entities, curveId);
          const solidFrame = readAxisPlacement(ref(item.args[1]));
          if (solidFrame) itemFrame = compose(objectFrame, solidFrame);
        }

        if (localPolygon.length < 3) continue;
        profileCandidates++;
        const polygon = localPolygon.map((point) => transformPlanPoint(itemFrame, point));
        const areaM2 = polygonArea(polygon);
        if (!Number.isFinite(areaM2) || areaM2 < 0.05) continue;
        if (!best || areaM2 > best.areaM2) {
          best = { expressId: entity.id, name, polygon, areaM2, representation: representationType };
        }
      }
    }
    if (best) footprints.set(entity.id, best);
  }

  diagnostics.push(`IFC STEP profile fallback inspected ${spaceCount} IfcSpace entities and ${profileCandidates} supported profile candidate(s); recovered ${footprints.size} room footprint(s).`);
  if (spaceCount && footprints.size < spaceCount) {
    const missing = Array.from(entities.values())
      .filter((entity) => entity.type === "IFCSPACE" && !footprints.has(entity.id))
      .map((entity) => `${String(entity.args[7] ?? entity.args[2] ?? `IFC Space ${entity.id}`)} (#${entity.id})`);
    diagnostics.push(`${missing.length} IfcSpace entity/entities do not expose a supported explicit FootPrint/Body profile in source STEP (${missing.join(", ")}); these spaces remain eligible for wall-graph association.`);
  }
  return { footprints, diagnostics };
}
