# V2 Renderer

You are joining an existing production renderer refactor.

The old renderer (scene_merger.py) remains the production renderer.

Do NOT modify it.

We are building V2 beside it.

Goal:

Produce a GLB whose visual output exactly matches the frontend BIM editor.

The HTML viewer must eventually become a thin viewer that simply loads the exported GLB.

Rules

- Never rewrite architecture.
- Never increase PR scope.
- One PR = One responsibility.
- No placeholders.
- No TODOs.
- Every PR must compile.
- Every PR must preserve previous work.

Current Architecture

IFC

↓

Document Scanner

↓

Geometry Diagnostic

↓

Scene Builder

↓

Geometry Extractor

↓

Material Resolver

↓

Furniture Resolver

↓

Scene Validator

↓

GLB Exporter

↓

360 HTML Viewer