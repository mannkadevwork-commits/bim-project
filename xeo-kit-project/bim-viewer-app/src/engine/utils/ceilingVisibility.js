const normalized = (value) => String(value ?? '').trim().toUpperCase().replace(/[\s_-]+/g, ' ');

const unwrapValue = (property) => {
  if (property == null) return '';
  if (typeof property !== 'object') return property;
  if ('value' in property) return unwrapValue(property.value);
  if ('nominalValue' in property) return unwrapValue(property.nominalValue);
  if ('wrappedValue' in property) return unwrapValue(property.wrappedValue);
  return '';
};

const getProperty = (metaObject, propertyNames) => {
  const wanted = new Set(propertyNames.map(normalized));
  const propertySets = metaObject?.propertySets;
  if (!propertySets) return '';
  const sets = Array.isArray(propertySets) ? propertySets : Object.values(propertySets);
  for (const set of sets) {
    const properties = set?.properties || set?.hasProperties || set;
    const entries = Array.isArray(properties)
      ? properties.map((entry) => [entry?.name || entry?.Name, entry])
      : Object.entries(properties || {});
    for (const [name, value] of entries) {
      if (wanted.has(normalized(name))) return unwrapValue(value);
    }
  }
  return '';
};

const isCeilingOrRoofMetaObject = (metaObject, entity) => {
  const type = normalized(metaObject?.type || entity?.type || entity?.ifcType);
  const name = normalized(metaObject?.name || entity?.name || '');
  const predefinedType = normalized(getProperty(metaObject, ['PredefinedType', 'ObjectType', 'ElementType']));
  const explicitlyNamed = /\b(CEILING|SOFFIT|ROOF)\b/.test(name);
  if (type === 'IFCROOF') return true;
  if (type === 'IFCCOVERING') return predefinedType === 'CEILING' || /\b(CEILING|SOFFIT)\b/.test(name);
  if (type === 'IFCSLAB') return predefinedType === 'ROOF' || explicitlyNamed;
  if (['IFCBUILDINGELEMENTPROXY', 'IFCPLATE', 'IFCMEMBER'].includes(type)) return explicitlyNamed;
  return explicitlyNamed && /IFC/.test(type);
};

/** Returns only the main building model's likely ceiling/roof IFC entities. */
export const findCeilingEntities = (viewer, mainModel) => {
  if (!viewer?.scene?.objects || !mainModel) return [];
  const metaObjects = viewer.metaScene?.metaObjects || {};
  return Object.values(viewer.scene.objects).filter((entity) => {
    if (!entity || entity.model !== mainModel) return false;
    return isCeilingOrRoofMetaObject(metaObjects[entity.id] || null, entity);
  });
};
