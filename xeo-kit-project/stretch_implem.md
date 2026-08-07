# Stretch Feature Implementation

## Purpose

This document explains how the current stretch feature is implemented in our BIM viewer.

While working on this feature I mainly focused on understanding how mouse interaction works and how that mouse movement is finally converted into stretching of an object inside the scene.

This document is based on my current understanding of the implementation. It explains what is happening today, where the calculations are happening and what limitations are still there.

---

## Current flow

Current implementation works like this.

```
User selects object

↓

Object becomes active

↓

Stretch handles become visible

↓

User clicks one handle

↓

Mouse drag starts

↓

Mouse movement is tracked

↓

Mouse movement is converted into world position

↓

Movement is projected on selected axis

↓

Scale is calculated

↓

Scene updates

↓

Stretch values are saved
```

---

## Files involved

Current implementation is mainly divided into four parts.

### BIMViewer.jsx

This is the entry point of the feature.

It connects all hooks together and receives mouse events from the viewer.

Whenever an object is selected or a handle is dragged, the interaction starts from here.

---

### useBIMEngine.js

This file is responsible for viewer related work.

Currently it handles

- Viewer initialization
- IFC loading
- XKT loading
- Object selection
- Asset placement
- Camera controls
- Scene updates

Whenever an object gets selected, this hook updates the current selected object.

---

### useStretchHandles.js

This file contains the main logic for stretching.

Current responsibilities are

- Creating stretch handles
- Tracking mouse drag
- Converting screen movement into world movement
- Projecting movement on selected axis
- Calculating stretch values
- Updating the object while dragging

Most of the stretch calculations happen here.

---

### useProjectSync.js

This file is responsible for saving user changes.

Instead of changing the original IFC, we only save the user edits.

Whenever the project loads again, those saved edits are applied back on the model.

---

## Object selection

Stretching always starts after selecting an object.

Once the user clicks an object, xeokit returns the picked entity.

That entity becomes the current active object.

At this stage no stretching happens.

We only know which object should respond to the next mouse interaction.

---

## Stretch handles

After selecting an object, stretch handles become visible.

Currently every handle represents one axis.

- X
- Y
- Z

Only one handle can remain active during one drag operation.

The handle itself does not perform stretching.

It only tells the application which axis should be modified.

---

## Mouse drag

Once the user clicks on a handle, drag starts.

Current mouse position is stored.

Current scale of the object is also stored.

Both of these become the starting point of the drag operation.

After that every mouse move triggers a new calculation.

Current flow is

```
Mouse Move

↓

Generate Ray

↓

Find Drag Plane Intersection

↓

Calculate World Position

↓

Project on Selected Axis

↓

Calculate Scale

↓

Update Scene
```

---

## Why drag plane is required

Mouse moves only on the screen.

Objects exist in 3D world space.

Because of that we cannot directly use screen coordinates for stretching.

Current implementation first converts mouse movement into a ray.

That ray intersects the drag plane.

The intersection point becomes our world position.

Now instead of comparing pixels, we compare actual positions inside the scene.

This makes dragging much smoother.

---

## Axis projection

The drag plane allows movement in every direction.

But while stretching we only want movement along one axis.

Current implementation projects the movement only on the selected axis.

Example

If X handle is active,

only X movement is used.

Y and Z movement are ignored.

This keeps stretching stable.

---

## Scale calculation

After getting movement on the selected axis, new scale is calculated.

Current implementation updates only one axis.

Example

Before

```
(1,1,1)
```

After stretching X

```
(1.25,1,1)
```

Remaining values stay unchanged.

---

## Scene update

Once new scale is calculated, object transform is updated immediately.

xeokit redraws the scene automatically.

This gives live feedback while dragging.

User can continuously see the object stretching.

---

## Saving changes

Stretching only changes the visual object.

To keep those changes after reload, updated values are stored in project state.

Original IFC is never modified.

Only the user edits are saved.

When the project loads again, those saved edits are applied back.

---

## Current limitations

Current implementation supports only one axis stretching.

Things still pending are

- Two axis stretching
- Corner dragging
- Connected wall updates
- Room resizing
- Live measurement updates while stretching
- Undo / Redo support
- Constraint based stretching

These are things that still need to be explored.


---

## Next steps

Current implementation works well for single axis stretching.

The next goal is to understand how we can extend this for wall editing.

That includes

- Stretching from corners
- Two axis stretching
- Updating connected walls
- Keeping room dimensions consistent
- Adding undo/redo support
- Improving overall editing workflow

This is the current implementation understanding and I'll keep updating this document as more work is completed.