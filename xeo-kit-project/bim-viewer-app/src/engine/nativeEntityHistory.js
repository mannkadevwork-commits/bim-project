/**
 * Stable references for native IFC entities during isolation/cut-wall edits.
 *
 * Xeokit's scene.objects lookup is keyed by entity id. Loading an isolated IFC
 * with the same IFC GlobalId can replace that lookup entry even though the
 * original main-model entity is still alive. Undo/redo must therefore restore
 * the original entity through a direct reference rather than looking it up by
 * id after an isolated model has been loaded.
 */
export const rememberNativeEntityRef = (context, entityId) => {
  const { viewerRef, currentModelRef, nativeEntityRefsRef } = context || {};
  const viewer = viewerRef?.current;
  const mainModel = currentModelRef?.current;
  const refs = nativeEntityRefsRef?.current;
  if (!entityId || !viewer || !mainModel || !refs) return null;

  const cached = refs.get(entityId);
  if (cached && cached.model === mainModel && cached.entity && cached.entity.destroyed !== true) {
    return cached;
  }

  const entity = Object.values(viewer.scene?.objects || {}).find((object) => (
    object?.id === entityId && object.model === mainModel
  ));
  if (!entity) return null;

  const originalVisible = typeof entity.__hciDoorOriginalVisible === 'boolean'
    ? entity.__hciDoorOriginalVisible
    : entity.visible !== false;
  entity.__hciDoorOriginalVisible = originalVisible;

  const entry = { entity, model: mainModel, originalVisible };
  refs.set(entityId, entry);
  return entry;
};

export const setNativeEntityVisibleForEdit = (context, entityId, visible) => {
  const entry = rememberNativeEntityRef(context, entityId);
  if (!entry) return false;
  try {
    entry.entity.visible = Boolean(visible);
    return true;
  } catch (error) {
    console.warn('[NativeEdit] Could not set native entity visibility:', entityId, error);
    return false;
  }
};

export const restoreNativeEntityVisibility = (context, entityId) => {
  const { currentModelRef, nativeEntityRefsRef } = context || {};
  const refs = nativeEntityRefsRef?.current;
  const mainModel = currentModelRef?.current;
  const entry = refs?.get(entityId) || rememberNativeEntityRef(context, entityId);
  if (!entry || entry.model !== mainModel || !entry.entity || entry.entity.destroyed === true) return false;
  try {
    entry.entity.visible = entry.originalVisible;
    return true;
  } catch (error) {
    console.warn('[NativeEdit] Could not restore native entity visibility:', entityId, error);
    return false;
  }
};

export const reconcileNativeEntityVisibility = (context, state) => {
  const { currentModelRef, nativeEntityRefsRef } = context || {};
  const refs = nativeEntityRefsRef?.current;
  if (!refs || !currentModelRef?.current) return 0;

  const ids = new Set([
    ...refs.keys(),
    ...Object.keys(state?.structural_edits || {}),
  ]);
  let reconciled = 0;

  ids.forEach((entityId) => {
    let entry = refs.get(entityId);
    if (!entry || entry.model !== currentModelRef.current || !entry.entity || entry.entity.destroyed === true) {
      entry = rememberNativeEntityRef(context, entityId);
    }
    if (!entry || entry.model !== currentModelRef.current) return;

    const edit = state?.structural_edits?.[entityId];
    const nextVisible = edit?.visible === false ? false : entry.originalVisible;
    try {
      entry.entity.visible = nextVisible;
      reconciled += 1;
    } catch (error) {
      console.warn('[NativeEdit] Could not reconcile native entity visibility:', entityId, error);
    }
  });

  return reconciled;
};
