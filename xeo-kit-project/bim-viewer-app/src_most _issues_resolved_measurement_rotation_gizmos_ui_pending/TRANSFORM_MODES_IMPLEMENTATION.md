# Transform modes - integrated implementation

This version fixes the previous incomplete mode integration.

## What was wrong
The UI tooltip existed, but `useBIMEngine` did not expose a `transformMode` state
or a `setTransformMode` action. Therefore the buttons had no functional engine
behind them.

The previous stretch implementation also rebuilt `model.matrix` with scale +
translation, which discarded the model's existing rotation.

## Current behavior

- Move: selected dropped asset can be dragged over the XZ floor plane.
- Rotate: selected dropped asset can be rotated around Y by horizontal drag.
- Stretch: only stretch face/edge/corner handles are active.
- Switching mode disables the previous mode's interaction.
- Stretch updates `model.scale` and never replaces `model.matrix`.
- Stretch projects the drag onto the asset's rotated local axis.
- Stretch preserves the opposite side by applying the corresponding local-axis
  position correction.
- Move/rotate/stretch final values use the existing persistence callback.

## Interaction contract

Move -> click/drag selected asset.
Rotate -> click/drag selected asset horizontally.
Stretch -> select a visible stretch handle and drag it.

The tooltip is the mode selector; it is not merely decorative.
