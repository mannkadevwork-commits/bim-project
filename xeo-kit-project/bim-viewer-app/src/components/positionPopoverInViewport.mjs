/**
 * Position a fixed popover relative to its trigger while staying inside the
 * visual viewport (including browser zoom / virtual viewport offsets).
 */
export function positionPopoverInViewport({
  anchor,
  popover,
  viewport,
  preferredSide = 'above',
  requestedMaxHeight = 560,
  margin = 12,
  gap = 10,
}) {
  if (!anchor || !popover || !viewport) return null;
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const viewportLeft = Number(viewport.left) || 0;
  const viewportTop = Number(viewport.top) || 0;
  const safeTop = viewportTop + margin;
  const safeBottom = viewportTop + height - margin;
  const safeLeft = viewportLeft + margin;
  const safeRight = viewportLeft + width - margin;
  const maxHeight = Math.min(requestedMaxHeight, Math.max(1, height - margin * 2));
  // Prefer intrinsic content height over getBoundingClientRect().height. A
  // popover may already be clipped by its initial max-height when measured;
  // using only that clipped height can make it overlap its trigger after the
  // final max-height is applied.
  const contentHeight = Number(popover.contentHeight ?? popover.scrollHeight ?? popover.height) || maxHeight;
  const desiredHeight = Math.min(contentHeight, maxHeight);
  const aboveSpace = Math.max(0, Number(anchor.top) - safeTop - gap);
  const belowSpace = Math.max(0, safeBottom - Number(anchor.bottom) - gap);
  const preferredAvailable = preferredSide === 'above' ? aboveSpace : belowSpace;
  const oppositeAvailable = preferredSide === 'above' ? belowSpace : aboveSpace;
  const neededHeight = desiredHeight;

  const side = preferredAvailable >= neededHeight
    ? preferredSide
    : oppositeAvailable >= neededHeight
      ? (preferredSide === 'above' ? 'below' : 'above')
      : aboveSpace >= belowSpace ? 'above' : 'below';
  const available = side === 'above' ? aboveSpace : belowSpace;
  const finalMaxHeight = Math.max(1, Math.min(maxHeight, available));
  const renderedHeight = Math.min(desiredHeight, finalMaxHeight);
  let top = side === 'above'
    ? Number(anchor.top) - renderedHeight - gap
    : Number(anchor.bottom) + gap;
  top = Math.max(safeTop, Math.min(top, safeBottom - renderedHeight));

  const popoverWidth = Math.min(Number(popover.width) || 330, Math.max(1, width - margin * 2));
  let left = Number(anchor.right) - popoverWidth;
  left = Math.max(safeLeft, Math.min(left, safeRight - popoverWidth));

  return { left, top, side, maxHeight: finalMaxHeight, width: popoverWidth };
}
