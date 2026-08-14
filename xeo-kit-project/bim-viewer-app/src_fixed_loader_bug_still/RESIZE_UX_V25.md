# Resize UX v25

- Resize starts in Face mode: only 6 primary face grips are visible/pickable.
- Tooltip exposes a compact Resize by control only while Resize is active:
  - Face = 1 axis
  - Edge = 2 axes
  - Corner = 3 axes
- Switching the submode immediately updates visibility/pickability; no hover-based disclosure.
- Existing applyScale / anchored stretch math is unchanged.
- Edge and Corner handle metadata are normalized to `edge` and `corner` so the existing pointer drag path can consume them.
- Entering Resize from another transform tool resets the submode to Face.
