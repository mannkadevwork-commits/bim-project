# Resize UX v22

This version keeps the existing resize math and changes only the interaction/visual layer.

## Behavior
- Selection uses cyan rather than HCI orange for 3D selection semantics.
- Resize initially shows six primary face grips only.
- Hover highlights a grip but does not reveal additional controls.
- Clicking a face grip reveals the adjacent edge/corner grips for that side.
- The clicked face can still be dragged immediately; there is no extra arming step.
- After drag, the clicked face's related controls remain visible until another face is clicked or selection is cleared.
- Face/edge/corner grips carry semantic metadata and visual shapes.
- Live resize feedback shows dimensions in meters during drag.
- Local-axis handle placement follows the object's Y rotation (existing behavior preserved).
