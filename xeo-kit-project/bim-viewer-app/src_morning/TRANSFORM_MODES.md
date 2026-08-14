# Transform modes

Selected assets now have explicit Move / Rotate / Stretch modes.

- Move uses the existing ray-to-horizontal-plane approach and updates position.
- Rotate uses a ray/plane angle around the selected object's center.
- Stretch projects mouse movement onto the object's current local X/Y/Z axes.
- The selected mode filters gizmo visibility/picking so a stretch handle cannot move an asset.
- Existing project-state persistence remains the source of saved furniture transforms.
