# Known Issues

This document tracks current limitations.

---

## IFC Orientation

Some IFC assets have inconsistent local coordinate systems.

Examples

- Sink
- Mirror
- Fire Proof Door

Symptoms

- Wrong rotation
- Incorrect orientation after export

Status

Under investigation.

---

## Walkthrough

Current walkthrough is generated using navigation viewpoints.

Known limitations

- Some viewpoints may appear close to furniture.
- Walkthrough quality depends on navigation graph generation.
- Continuous improvements are in progress.

---

## Asset Alignment

Certain imported assets require orientation correction.

These corrections currently happen per asset.

Future work

Automatic orientation normalization.

---

## Performance

Large IFC files require additional processing time.

Future improvements

- Better batching
- Parallel geometry processing
- Faster GLB generation