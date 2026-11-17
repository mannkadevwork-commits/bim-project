const finiteVector = (value, fallback = null) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return fallback;
  if (value.length !== 3) return fallback;
  const result = Array.from(value, Number);
  return result.every(Number.isFinite) ? result : fallback;
};

const normalizedText = (...values) => values
  .filter((value) => value !== null && value !== undefined)
  .map((value) => String(value))
  .join(' ')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

export const classifyNativeIfcReplacement = (type, name) => {
  const typeText = normalizedText(type).replace(/\s+/g, '');
  const nameText = normalizedText(name);

  // Doors require their own opening/hinge workflow and must never enter the
  // generic replacement path.
  if (/ifcdoor|ifcopeningelement/.test(typeText) || /\bdoor\b/.test(nameText)) return null;
  if (/ifcwindow/.test(typeText) || /\b(window|glazing|casement|sash window)\b/.test(nameText)) return 'window';
  if (/ifcwall|ifccurtainwall/.test(typeText) || /\b(wall|partition)\b/.test(nameText)) return 'wall';

  const furnitureClass = /ifcfurnishingelement|ifcfurniture|ifcsystemfurniture|ifcdiscreteaccessory|ifctransportelement/;
  const furnitureName = /\b(bed|sofa|couch|chair|armchair|table|cabinet|desk|wardrobe|shelf|stool|dresser|nightstand|ottoman|commode|sink|mirror)\b/;
  if (furnitureClass.test(typeText) || furnitureName.test(nameText)) return 'furniture';
  return null;
};

export const normalizeNativeReplacementInfo = (payload, expectedKind) => {
  const replacement = payload?.replacement;
  if (!replacement || replacement.kind !== expectedKind) {
    throw new Error('The selected IFC element is not a supported replacement type. Refresh the selection and try again.');
  }
  if (replacement.frameAvailable !== true || !replacement.frame) {
    throw new Error(replacement.frameError || 'The IFC element has no reliable geometric placement frame and cannot be replaced safely.');
  }

  const position = finiteVector(replacement.frame.position);
  const rotation = finiteVector(replacement.frame.rotation);
  const dimensions = finiteVector(replacement.frame.dimensions);
  if (!position || !rotation || !dimensions || dimensions.some((value) => value <= 0)) {
    throw new Error('The IFC element returned invalid position, orientation or dimensions. Replacement was cancelled.');
  }
  if (replacement.frame.coordinateSystem !== 'hci-y-up' || replacement.frame.unit !== 'm') {
    throw new Error('The IFC replacement frame uses an unsupported coordinate system or unit.');
  }

  return {
    ...replacement,
    frame: { ...replacement.frame, position, rotation, dimensions },
  };
};

export const isCompatibleCatalogReplacement = (item, kind) => {
  const text = normalizedText(
    item?.name,
    item?.category,
    item?.description,
    item?._categoryPath,
    item?.type,
  );
  if (!text) return false;

  const fileType = String(item?._fileType || item?.file_type || item?.fileType || '').toLowerCase();
  if (fileType && !['glb', 'gltf', 'ifc'].includes(fileType)) return false;

  const isDoor = /\bdoor(s)?\b|door frame|door leaf|doormat|doorstop/.test(text);
  if (isDoor) return false;

  if (kind === 'window') {
    return /\b(window|windows|glazing|casement|sash|slider|sliding window|bay window|picture window|skylight|rooflight)\b/.test(text);
  }
  if (kind === 'wall') {
    return /\b(wall|walls|partition|masonry|brick wall|drywall|gypsum wall|concrete wall|cladding panel)\b/.test(text)
      && !/wall art|wall lamp|wall light|wall sconce|wall clock|wall mirror|wall shelf|wall mounted/.test(text);
  }
  if (kind === 'furniture') {
    const isStructural = /\b(window|glazing|wall|partition|slab|ceiling|roof|door|beam|column)\b/.test(text);
    const isFurniture = /\b(bed|sofa|couch|chair|armchair|table|cabinet|desk|wardrobe|shelf|stool|dresser|nightstand|ottoman|commode|furniture|furnishing|recliner|bench|bookcase|sideboard|tv unit)\b/.test(text);
    return isFurniture && !isStructural;
  }
  return false;
};

export const computeFitScale = (sourceDimensions, targetDimensions) => {
  const source = finiteVector(sourceDimensions);
  const target = finiteVector(targetDimensions);
  if (!source || !target || source.some((value) => value <= 1e-6) || target.some((value) => value <= 1e-6)) {
    throw new Error('Cannot fit replacement: source or target dimensions are invalid.');
  }
  return source.map((value, index) => target[index] / value);
};
