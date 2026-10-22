/**
 * Stable identity for the transform represented by a persisted furniture item.
 * This is bookkeeping only: it never reads or changes a live model transform.
 *
 * Keep this contract aligned with useBIMEngine's existing reconciler so a model
 * positioned by AssetManager can be marked as already matching project state.
 */
export function assetTransformSignature(item) {
  if (!item) return null;

  const isNativeIsolation = !!item.isNativeIsolation;
  return JSON.stringify({
    position: Array.isArray(item.position) ? item.position : [0, 0, 0],
    rotation: Array.isArray(item.rotation) ? item.rotation : [0, 0, 0],
    scale: Array.isArray(item.scale) ? item.scale : [1, 1, 1],
    isNativeIsolation,
    // Native-isolated IFCs use an authoritative matrix. Ordinary catalogue IFCs
    // and hosted doors deliberately keep their persisted semantic TRS contract.
    matrix: isNativeIsolation && Array.isArray(item.matrix) && item.matrix.length === 16
      ? item.matrix
      : null,
  });
}

/** Mark the transform that the loader (or a completed reconcile) has applied. */
export function markAssetTransformApplied(model, item) {
  if (!model || !item) return null;

  const signature = assetTransformSignature(item);
  if (!signature) return null;

  model._assetMeta = {
    ...(model._assetMeta || {}),
    lastAppliedTransformKey: signature,
  };
  return signature;
}
