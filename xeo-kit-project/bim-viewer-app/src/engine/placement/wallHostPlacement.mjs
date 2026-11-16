export const WALL_HOST_SCHEMA_VERSION = 1;

const EPSILON = 1e-8;

const finiteVec3 = (value) => (
  (Array.isArray(value) || ArrayBuffer.isView(value)) && value.length >= 3 &&
  Array.from(value).slice(0, 3).every((entry) => Number.isFinite(Number(entry)))
);

export const normalize3 = (value, fallback = [0, 0, 0]) => {
  if (!finiteVec3(value)) return [...fallback];
  const vector = Array.from(value).slice(0, 3).map(Number);
  const length = Math.hypot(...vector);
  return length > EPSILON ? vector.map((entry) => entry / length) : [...fallback];
};

export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const isVerticalWallNormal = (normal, maxVerticalComponent = 0.28) => {
  if (!finiteVec3(normal)) return false;
  const n = normalize3(normal);
  const horizontalLength = Math.hypot(n[0], n[2]);
  return horizontalLength >= 0.94 && Math.abs(n[1]) <= maxVerticalComponent;
};

export const readAabb = (aabb) => {
  if (!aabb || aabb.length < 6) return null;
  const values = Array.from(aabb).slice(0, 6).map(Number);
  if (!values.every(Number.isFinite)) return null;
  const min = [values[0], values[1], values[2]];
  const max = [values[3], values[4], values[5]];
  if (max.some((value, index) => value < min[index])) return null;
  const size = max.map((value, index) => value - min[index]);
  return {
    min,
    max,
    size,
    center: min.map((value, index) => (value + max[index]) / 2),
    horizontalSpan: Math.max(size[0], size[2]),
    horizontalThickness: Math.min(size[0], size[2]),
    height: size[1],
  };
};

const normalizeText = (...values) => values
  .filter((value) => value !== undefined && value !== null)
  .map((value) => String(value).trim().toLowerCase())
  .filter(Boolean)
  .join(' ');

const IFC_WALL_TYPES = new Set(['ifcwall', 'ifcwallstandardcase', 'ifccurtainwall']);
const WALL_NAME_PATTERN = /\b(wall|partition|facade|façade|curtain\s*wall|shear\s*wall)\b/i;
const NON_ARCHITECTURAL_ASSET_CATEGORIES = new Set([
  'furniture', 'lighting', 'decor', 'decoration', 'appliance', 'sanitaryware', 'plumbing', 'equipment',
]);

/**
 * Classifies a picked vertical surface as a plausible wall host.
 * IFC class metadata is authoritative. GLB hosts require architectural metadata,
 * a wall-like node name, or a conservative tall/thin geometry signature.
 */
export const classifyWallHost = ({
  entityId,
  entityName,
  entityType,
  modelMeta = null,
  aabb = null,
  allowGeometricFallback = true,
} = {}) => {
  const type = String(entityType || '').replace(/\s+/g, '').toLowerCase();
  const text = normalizeText(entityName, entityId, modelMeta?.name, modelMeta?.assetRole, modelMeta?.assetCategory);
  const bounds = readAabb(aabb);

  if (IFC_WALL_TYPES.has(type)) {
    return { accepted: true, hostType: 'ifc', confidence: 0.99, reason: 'ifc-wall-class', bounds };
  }

  if (WALL_NAME_PATTERN.test(normalizeText(entityName, entityId))) {
    return { accepted: true, hostType: modelMeta?.fileType === 'glb' ? 'glb' : 'named-structural', confidence: 0.91, reason: 'wall-node-name', bounds };
  }

  const role = String(modelMeta?.assetRole || '').toLowerCase();
  const category = String(modelMeta?.assetCategory || '').toLowerCase();
  const explicitlyArchitectural = modelMeta?.isArchitecturalModel === true ||
    modelMeta?.wallHostEligible === true ||
    ['architecture', 'structural-model', 'building-shell'].includes(role) ||
    ['structural', 'architecture', 'building'].includes(category);

  if (explicitlyArchitectural && bounds && bounds.height >= 1.35 && bounds.horizontalSpan >= 0.65) {
    return { accepted: true, hostType: modelMeta?.fileType === 'glb' ? 'glb' : 'structural', confidence: 0.88, reason: 'architectural-model-metadata', bounds };
  }

  const modelIsGLB = String(modelMeta?.fileType || modelMeta?.assetFormat || '').toLowerCase() === 'glb';
  if (allowGeometricFallback && modelIsGLB && !NON_ARCHITECTURAL_ASSET_CATEGORIES.has(category) && bounds) {
    const plausibleWall = bounds.height >= 1.8 &&
      bounds.horizontalSpan >= 1.1 &&
      bounds.horizontalThickness <= 0.85 &&
      bounds.horizontalSpan >= Math.max(0.75, bounds.horizontalThickness * 1.45);
    if (plausibleWall) {
      return { accepted: true, hostType: 'glb', confidence: 0.76, reason: 'glb-wall-geometry-signature', bounds };
    }
  }

  return { accepted: false, hostType: null, confidence: 0, reason: bounds ? 'not-a-verified-wall-host' : 'missing-wall-host-metadata-and-bounds', bounds };
};

const forwardYawDegrees = (normal, forwardAxis = '-Z') => {
  const n = normalize3([normal[0], 0, normal[2]], [0, 0, 1]);
  const radians = String(forwardAxis).toUpperCase() === '+Z'
    ? Math.atan2(n[0], n[2])
    : Math.atan2(-n[0], -n[2]);
  return radians * (180 / Math.PI);
};

/**
 * Creates a serializable attachment frame. `position` is the asset centre,
 * not its floor-contact point; loaders must use a centre pivot for wall assets.
 */
export const createWallHostPlacement = ({
  position,
  normal,
  entityId,
  modelId = null,
  globalId = null,
  hostType = 'glb',
  bounds = null,
  confidence = 1,
  reason = 'verified-wall-host',
  forwardAxis = '-Z',
  standoff = 0.06,
} = {}) => {
  if (!finiteVec3(position) || !isVerticalWallNormal(normal)) return null;
  const hitPoint = Array.from(position).slice(0, 3).map(Number);
  const horizontalNormal = normalize3([Number(normal[0]), 0, Number(normal[2])], [0, 0, 1]);
  const up = [0, 1, 0];
  const tangent = normalize3(cross3(up, horizontalNormal), [1, 0, 0]);
  const safeStandoff = Math.max(0.005, Math.min(0.35, Number(standoff) || 0.06));
  const worldPosition = hitPoint.map((value, index) => value + horizontalNormal[index] * safeStandoff);
  const safeBounds = bounds ? {
    min: [...bounds.min],
    max: [...bounds.max],
  } : null;
  const anchorCenter = bounds?.center || hitPoint;
  const localU = dot3(hitPoint.map((value, index) => value - anchorCenter[index]), tangent);
  const localV = bounds ? hitPoint[1] - bounds.min[1] : 0;

  return {
    position: worldPosition,
    rotation: [0, forwardYawDegrees(horizontalNormal, forwardAxis), 0],
    wallHost: {
      schemaVersion: WALL_HOST_SCHEMA_VERSION,
      hostType,
      hostEntityId: entityId ? String(entityId) : null,
      hostModelId: modelId ? String(modelId) : null,
      hostGlobalId: globalId ? String(globalId) : null,
      hitPoint,
      normal: horizontalNormal,
      tangent,
      up,
      localAnchor: { u: localU, v: localV },
      bounds: safeBounds,
      anchorMode: 'center',
      forwardAxis: String(forwardAxis).toUpperCase() === '+Z' ? '+Z' : '-Z',
      standoff: safeStandoff,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      classification: String(reason || 'verified-wall-host'),
    },
  };
};

const textOf = (...values) => normalizeText(...values);
const WINDOW_PATTERN = /\b(window|glazing|glazed\s*panel|skylight)\b/i;
const DOOR_PATTERN = /\b(door|doorframe|door\s*leaf)\b/i;
const WINDOW_ACCESSORY_PATTERN = /\b(blind|curtain|drape|shade|valance)\b/i;
const WALL_MOUNT_PATTERN = /\b(wall\s*lamp|wall\s*light|wall\s*mounted\s*(lamp|light|tv)|tv\s*wall\s*mount|sconce|wall\s*washer|mirror|wall\s*shelf|floating\s*shelf|picture|artwork|wall\s*art|wall\s*clock|wall\s*panel)\b/i;

/** Infer catalog placement intent without hijacking the existing door path. */
export const resolveWallPlacementIntent = (asset = {}) => {
  const text = textOf(asset.id, asset.catalogId, asset.name, asset.type, asset.category, asset.assetCategory);
  const normalizedType = String(asset.type || asset.ifcClass || asset.ifc_class || '').toLowerCase().replace(/[^a-z]/g, '');
  if (DOOR_PATTERN.test(text) || normalizedType === 'door' || normalizedType === 'ifcdoor') return null;

  const explicitSurface = String(asset.placementSurface || asset.placement_surface || '').toLowerCase();
  const explicitMount = String(asset.mountingType || asset.mounting_type || asset.wallMountType || asset.wall_mount_type || '').toLowerCase();
  const isWindow = asset.isWindow === true || normalizedType === 'window' || normalizedType === 'ifcwindow' ||
    ['window', 'windows', 'glazing'].includes(String(asset.category || '').toLowerCase()) ||
    (!WINDOW_ACCESSORY_PATTERN.test(text) && WINDOW_PATTERN.test(text));

  if (isWindow) {
    return {
      placementSurface: 'wall',
      wallPlacementKind: 'opening',
      label: 'Window',
    };
  }

  const explicitWallMount = explicitSurface === 'wall' || explicitMount === 'wall' ||
    asset.wallMounted === true || asset.wall_mounted === true;
  const inferredWallMount = WALL_MOUNT_PATTERN.test(text);
  if (explicitWallMount || inferredWallMount) {
    return {
      placementSurface: 'wall',
      wallPlacementKind: 'surface',
      label: 'Wall-mounted item',
    };
  }
  return null;
};

export const sanitizeWallHostRecord = (value) => {
  if (!value || Number(value.schemaVersion) !== WALL_HOST_SCHEMA_VERSION) return null;
  const finiteArray = (items, length = 3) => Array.isArray(items) && items.length === length && items.every((item) => Number.isFinite(Number(item)))
    ? items.map(Number)
    : null;
  const hitPoint = finiteArray(value.hitPoint);
  const normal = finiteArray(value.normal);
  const tangent = finiteArray(value.tangent);
  const up = finiteArray(value.up);
  if (!hitPoint || !normal || !tangent || !up || !value.hostEntityId) return null;
  return {
    schemaVersion: WALL_HOST_SCHEMA_VERSION,
    hostType: ['ifc', 'glb', 'structural', 'named-structural'].includes(value.hostType) ? value.hostType : 'glb',
    hostEntityId: String(value.hostEntityId),
    hostModelId: value.hostModelId ? String(value.hostModelId) : null,
    hostGlobalId: value.hostGlobalId ? String(value.hostGlobalId) : null,
    hitPoint,
    normal,
    tangent,
    up,
    localAnchor: {
      u: Number.isFinite(Number(value.localAnchor?.u)) ? Number(value.localAnchor.u) : 0,
      v: Number.isFinite(Number(value.localAnchor?.v)) ? Number(value.localAnchor.v) : 0,
    },
    bounds: value.bounds && finiteArray(value.bounds.min) && finiteArray(value.bounds.max)
      ? { min: finiteArray(value.bounds.min), max: finiteArray(value.bounds.max) }
      : null,
    anchorMode: 'center',
    forwardAxis: value.forwardAxis === '+Z' ? '+Z' : '-Z',
    standoff: Math.max(0.005, Math.min(0.35, Number(value.standoff) || 0.06)),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    classification: String(value.classification || 'verified-wall-host').slice(0, 64),
  };
};
