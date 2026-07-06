#!/usr/bin/env python3
"""
scene_merger.py — Coohom-style scene compositor.

Combines four sources of truth into ONE unified, render-ready mesh:

  1. Structural IFC geometry (walls, slabs, doors, windows, roofs...) read
     directly out of input.ifc via ifcopenshell.
  2. Dropped furniture (GLB / GLTF / OBJ / IFC assets) referenced in
     project_state.json, each placed with the position/rotation/scale the
     frontend saved for it.
  3. Per-element material overrides (project_state.json["materials"]),
     matched back onto the structural geometry by IFC GlobalId.
  4. Per-element structural edits (project_state.json["structural_edits"]),
     a Delta-Based State Management record of resizes/moves applied to a
     native IFC element (wall, etc.) by GlobalId. input.ifc itself is NEVER
     rewritten -- this script re-derives the edited geometry on every
     render by applying a scale + offset delta on top of the pristine IFC
     mesh, matching what the frontend already shows live in the viewer.

It then applies the Z-up -> Y-up axis correction 3ds Max / APS expects, and
writes a single merged OBJ (+ MTL) plus a JSON bounding-box sidecar (printed
to stdout) that the caller (aps-pipeline.js) uses to park the interior
camera in the middle of the room.

--------------------------------------------------------------------------
2026-07-05 fix notes (read this before touching apply_material_override or
the merge step again):

Bug 1 — furniture missing from the OBJ.
resolve_asset_path() used to require the optional 'requests' package and
went straight to an HTTP GET for any http(s) URL. Two things made that
silently drop every piece of furniture:
  (a) if 'requests' wasn't installed, the whole item was skipped with only
      a buried warning, never a loud failure;
  (b) far more commonly: this script is invoked as a *child process of the
      same Node server* that served these asset URLs (e.g.
      http://localhost:3000/assets/sofa.ifc). If that Node server is
      single-threaded/blocked running this render job, an HTTP round-trip
      back into itself is a self-referential "hairpin" request that hangs
      until it times out -- so every furniture item quietly vanished even
      though the URL was completely valid.
resolve_asset_path() now (1) always tries local filesystem resolution
first for any URL whose host is localhost/loopback or matches
--asset-base-url, before ever touching the network, and (2) uses the
stdlib urllib for the genuine-remote-URL fallback instead of the optional
'requests' package, so a missing dependency can't silently eat furniture.

Bug 2 — materials exporting as a generic gray map_Kd PNG instead of Kd.
The previous fix baked each override color into a small solid-color PIL
image so it would survive trimesh.util.concatenate()'s texture-atlas
packer. That was half right: the packer DOES preserve color information
through the merge, but only inside the packed *image* -- it resets the
packed material's own Kd/Ka/Ks scalars back to a generic mid-gray
(0.4, 0.4, 0.4) and writes a single shared `map_Kd material_0.png`
referencing the atlas. If APS/3ds Max fails to load or correctly sample
that atlas texture (a common failure with generated OBJ/MTL texture
references), it has nothing to fall back on but that generic gray Kd --
exactly the "wall renders gray" symptom, even though the JSON asked for a
specific hex color.

The real fix is to never let per-element colors go through that atlas
packer at all. scene_merger.py no longer merges geometry with
trimesh.util.concatenate(). Instead it builds a trimesh.Scene and adds
every structural element and every furniture part as its own named
geometry node. A Scene's OBJ exporter writes one `usemtl` per node against
its own untouched SimpleMaterial, so each element's actual Kd color lands
in the .mtl file with no shared atlas and no PNG in the loop at all. This
also incidentally fixes multi-material furniture (e.g. a sofa with wood
legs + fabric cushions loaded from one GLB) which was suffering the exact
same atlas-collapse bug internally.
--------------------------------------------------------------------------

Usage:
    python scene_merger.py \
        --ifc <path/to/input.ifc> \
        --state <path/to/project_state.json> \
        --output <path/to/merged.obj> \
        --job-dir <path/to/job_dir> \
        [--asset-base-url http://localhost:3000]

Stdout (and ONLY stdout) on success is a single JSON line:
    {
      "success": true,
      "output": "...",
      "bbox": {"min": [x,y,z], "max": [x,y,z], "center": [x,y,z], "size": [x,y,z]},
      "furniture_count": 2,
      "materials_applied": 1,
      "structural_edits_applied": 1,
      "warnings": []
    }

On failure:
    {"success": false, "error": "..."}   (exit code 1)

All diagnostic/progress logging goes to stderr so it never corrupts the
JSON contract the Node caller depends on.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import traceback
from urllib.parse import urlparse

import numpy as np

# --- Lazy/robust imports of the heavy libs, with clear failure messages ---
try:
    import trimesh
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "Missing dependency 'trimesh'. Install with: pip install trimesh"
    }))
    sys.exit(1)

try:
    import ifcopenshell
    import ifcopenshell.geom
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "Missing dependency 'ifcopenshell'. Install with: pip install ifcopenshell"
    }))
    sys.exit(1)

try:
    from PIL import Image  # noqa: F401  -- trimesh needs this internally for OBJ/GLB IO
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "Missing dependency 'Pillow'. Install with: pip install Pillow"
    }))
    sys.exit(1)


def log(msg):
    """All progress/diagnostic output goes to stderr so stdout stays pure JSON."""
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Axis correction: IFC / this app's runtime coordinate space is Z-up.
# Autodesk 3ds Max / APS's default scene expects Y-up.
# Rotating -90 degrees about X maps (x, y, z) -> (x, z, -y).
# --------------------------------------------------------------------------
def z_up_to_y_up_matrix():
    return trimesh.transformations.rotation_matrix(
        angle=-np.pi / 2.0,
        direction=[1, 0, 0],
        point=[0, 0, 0],
    )


def _sanitize_name(raw, fallback):
    """OBJ 'o'/'usemtl' names should stay whitespace/slash-free and non-empty."""
    raw = str(raw or fallback)
    cleaned = re.sub(r"[^A-Za-z0-9_\-]+", "_", raw).strip("_")
    return cleaned or fallback


# --------------------------------------------------------------------------
# IFC -> per-element trimesh geometry, keyed by GlobalId, in world coords.
# --------------------------------------------------------------------------
SKIP_IFC_TYPES = {
    "IfcSpace", "IfcOpeningElement", "IfcSite", "IfcAnnotation",
    "IfcGrid", "IfcGridAxis",
}


def load_ifc_as_named_meshes(ifc_path, warnings):
    """Returns list of (global_id, ifc_type, trimesh.Trimesh) in world coords."""
    if not os.path.exists(ifc_path):
        raise FileNotFoundError(f"IFC file not found: {ifc_path}")

    ifc_file = ifcopenshell.open(ifc_path)

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, True)
    settings.set(settings.APPLY_DEFAULT_MATERIALS, True)

    meshes = []
    iterator = ifcopenshell.geom.iterator(settings, ifc_file, num_threads=os.cpu_count() or 2)

    if not iterator.initialize():
        log("[scene_merger] IFC geometry iterator found nothing to render.")
        return meshes

    while True:
        shape = iterator.get()
        try:
            elem = ifc_file.by_id(shape.id)
            ifc_type = elem.is_a()
            if ifc_type in SKIP_IFC_TYPES:
                if not iterator.next():
                    break
                continue

            global_id = getattr(elem, "GlobalId", f"elem_{shape.id}")
            verts = np.array(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
            faces = np.array(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)

            if len(verts) == 0 or len(faces) == 0:
                if not iterator.next():
                    break
                continue

            mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
            mesh.metadata["global_id"] = global_id
            mesh.metadata["ifc_type"] = ifc_type
            meshes.append((global_id, ifc_type, mesh))
        except Exception as e:
            warnings.append(f"Skipped one IFC element due to geometry error: {e}")
        if not iterator.next():
            break

    return meshes


# --------------------------------------------------------------------------
# Material overrides: project_state.json["materials"] is keyed by GlobalId
# and looks like: { "<GlobalId>": { "color": [r,g,b], "roughness": 0.5,
#                                    "metalness": 0.0, "opacity": 1.0 } }
# --------------------------------------------------------------------------
def _parse_rgba(raw_color):
    """
    Normalizes a color from project_state.json into a single, unambiguous
    0-255 RGBA int list, regardless of how the frontend encoded it:
      - hex string:       "#FF5733" / "FF5733" / "#FF5733AA"
      - 0-255 ints:       [200, 40, 40] / [200, 40, 40, 255]
      - normalized float: [0.0-1.0], e.g. [0.78, 0.16, 0.16]
    Falls back to a neutral gray on anything unparseable.
    """
    fallback = [200, 200, 200, 255]
    if raw_color is None:
        return fallback

    try:
        if isinstance(raw_color, str):
            hex_str = raw_color.strip().lstrip("#")
            if len(hex_str) not in (6, 8):
                raise ValueError(f"Unexpected hex length in color '{raw_color}'")
            r = int(hex_str[0:2], 16)
            g = int(hex_str[2:4], 16)
            b = int(hex_str[4:6], 16)
            a = int(hex_str[6:8], 16) if len(hex_str) == 8 else 255
            return [r, g, b, a]

        if isinstance(raw_color, (list, tuple)) and len(raw_color) >= 3:
            comps = [float(c) for c in raw_color[:4]]
            # Decide 0-1 vs 0-255 ONCE for the whole color, not per-channel --
            # a per-channel check breaks on colors with a channel at exactly
            # 0, e.g. pure normalized blue [0.0, 0.0, 1.0].
            is_normalized = max(comps[:3]) <= 1.0
            scale = 255.0 if is_normalized else 1.0
            rgba = [int(max(0, min(255, c * scale))) for c in comps[:3]]
            alpha = comps[3] if len(comps) == 4 else 1.0
            alpha_scale = 255.0 if alpha <= 1.0 else 1.0
            rgba.append(int(max(0, min(255, alpha * alpha_scale))))
            return rgba

    except Exception as e:
        print(f"Warning: could not parse color {raw_color!r} ({e}); using default gray.",
              file=sys.stderr)

    return fallback


def apply_material_override(mesh, mat_def, warnings=None, context_id="unknown"):
    """
    Applies a per-element material override (color/roughness/metalness) from
    project_state.json to a trimesh.Trimesh as a PURE Kd color -- no image,
    no texture map, nothing for a downstream importer to fail to load.

    image=None is not just "no swatch was provided" -- it's load-bearing.
    Do not reintroduce a baked PIL swatch here (see the fix notes at the top
    of this file for why that was tried before and what it broke). Distinct
    per-element colors are now preserved through the final export by never
    running these meshes through trimesh.util.concatenate()'s texture-atlas
    packer at all -- see build_merged_scene() below, which keeps every
    mesh as its own object/material pair in a trimesh.Scene instead.

    Never raises: a malformed mat_def degrades to "mesh left as-is" plus a
    warning, rather than crashing the whole render.
    """
    if warnings is None:
        warnings = []

    if not mat_def or "color" not in mat_def:
        return mesh

    try:
        rgba = _parse_rgba(mat_def.get("color"))

        try:
            roughness = float(mat_def.get("roughness", 0.5))
        except (TypeError, ValueError):
            warnings.append(f"Element {context_id}: invalid 'roughness' value, defaulting to 0.5.")
            roughness = 0.5
        roughness = max(0.0, min(1.0, roughness))

        try:
            metalness = float(mat_def.get("metalness", 0.0))
        except (TypeError, ValueError):
            warnings.append(f"Element {context_id}: invalid 'metalness' value, defaulting to 0.0.")
            metalness = 0.0
        metalness = max(0.0, min(1.0, metalness))

        # SimpleMaterial's "glossiness" is roughly the inverse of roughness; OBJ/
        # MTL has no native roughness/metalness channel, so this is the closest
        # approximation the format supports (via Ns).
        glossiness = max(0.0, min(1.0, 1.0 - roughness))
        specular_level = int(round(255 * metalness))

        material = trimesh.visual.material.SimpleMaterial(
            image=None,  # <-- forces a clean `Kd r g b` line, no map_Kd/PNG
            diffuse=rgba,
            ambient=rgba,
            specular=[specular_level, specular_level, specular_level, 255],
            glossiness=glossiness,
        )

        # A texture-mode visual still wants a UV array of the right length,
        # even with no image behind it; the values themselves are irrelevant
        # since there's no texture to sample.
        uv = np.zeros((len(mesh.vertices), 2), dtype=np.float64)

        mesh.visual = trimesh.visual.TextureVisuals(material=material, uv=uv)
    except Exception as e:
        warnings.append(f"Element {context_id}: material override failed ({e}); left unmodified.")

    return mesh


# --------------------------------------------------------------------------
# Merging: a trimesh.Scene, NOT trimesh.util.concatenate().
#
# concatenate() routes every mesh's visual through
# trimesh.visual.material.pack(), which is designed to fuse *textured*
# meshes into one shared atlas image. When handed several plain
# SimpleMaterial(diffuse=..., image=None) instances it still runs them
# through the same packer -- it bakes each diffuse color into a one-pixel
# image, atlases those into a single PNG, and hands back ONE packed
# material whose own Kd/Ka/Ks scalars are reset to a generic mid-gray. The
# actual colors only survive inside that atlas PNG. A trimesh.Scene never
# does this: every geometry node keeps its own material object untouched,
# so the OBJ exporter writes one `usemtl` per node against a real, distinct
# `Kd` line -- no atlas, no PNG, no generic-gray fallback if a downstream
# importer can't load the texture.
# --------------------------------------------------------------------------
def build_merged_scene(named_meshes):
    """named_meshes: list of (unique_name, trimesh.Trimesh)."""
    scene = trimesh.Scene()
    for name, mesh in named_meshes:
        scene.add_geometry(mesh, node_name=name, geom_name=name)
    return scene


# --------------------------------------------------------------------------
# Resolving furniture asset URLs to local files.
#
#   - "/assets/xxx"                -> <project_root>/assets/xxx (server.js's
#                                      static assets folder, sibling of jobs/)
#   - "/jobs/<jobId>/..."          -> <project_root>/jobs/<jobId>/...
#   - bare relative path           -> resolved against job_dir first, then
#                                      project root, in that order
#   - absolute http(s) URL         -> if the host is localhost/loopback, or
#                                      matches --asset-base-url, try the
#                                      SAME local-disk resolution first (see
#                                      fix notes at the top of this file for
#                                      why -- a real HTTP round-trip back
#                                      into the calling Node server can
#                                      hang). Only genuinely-external hosts,
#                                      or a local lookup that comes up
#                                      empty, fall through to a real fetch
#                                      via the stdlib urllib (no optional
#                                      'requests' dependency to silently
#                                      go missing).
# --------------------------------------------------------------------------
def _local_candidates(path_part, job_dir, project_root):
    clean = path_part.lstrip("/")
    return [
        os.path.join(job_dir, clean),
        os.path.join(job_dir, os.path.basename(clean)),
        os.path.join(project_root, clean),
        os.path.join(project_root, "assets", os.path.basename(clean)),
    ]


def _http_download(url, warnings):
    """Stdlib-only download (no optional 'requests' dependency)."""
    import urllib.error
    import urllib.request

    parsed = urlparse(url)
    req = urllib.request.Request(url, headers={"User-Agent": "scene_merger/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
    except Exception as e:
        raise RuntimeError(f"Failed to download furniture asset '{url}': {e}") from e

    suffix = os.path.splitext(parsed.path)[1] or ".bin"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(data)
    tmp.close()
    return tmp.name


def resolve_asset_path(url_or_path, job_dir, project_root, asset_base_url, warnings):
    parsed = urlparse(url_or_path)

    # --- Bare relative / rooted path: purely local, no network involved. ---
    if parsed.scheme not in ("http", "https"):
        for candidate in _local_candidates(parsed.path, job_dir, project_root):
            if os.path.exists(candidate):
                return candidate
        if asset_base_url:
            full_url = asset_base_url.rstrip("/") + "/" + parsed.path.lstrip("/")
            return resolve_asset_path(full_url, job_dir, project_root, None, warnings)
        raise FileNotFoundError(f"Could not resolve furniture asset locally: {url_or_path}")

    # --- Absolute http(s) URL. ---
    host = (parsed.hostname or "").lower()
    looks_local = host in ("localhost", "127.0.0.1", "0.0.0.0", "::1")
    if asset_base_url:
        base_host = (urlparse(asset_base_url).hostname or "").lower()
        looks_local = looks_local or (host == base_host)

    if looks_local:
        # This URL almost certainly points at a file server.js is already
        # serving straight off disk -- resolve it there instead of making
        # this process call back into the very server that may be blocked
        # waiting on it (see fix notes at the top of this file).
        for candidate in _local_candidates(parsed.path, job_dir, project_root):
            if os.path.exists(candidate):
                return candidate
        warnings.append(
            f"Asset URL '{url_or_path}' looked local (host={host!r}) but no "
            f"matching file was found under {job_dir} or {project_root}; "
            f"falling back to an HTTP fetch, which may hang or fail if this "
            f"process was itself spawned by that same server."
        )

    return _http_download(url_or_path, warnings)


def load_furniture_pieces(local_path, warnings):
    """
    Loads a furniture asset (glb/gltf/obj/ifc) as a list of trimesh.Trimesh
    parts, each keeping its OWN material, instead of collapsing them into
    one mesh. This matters for multi-material assets straight off the shelf
    (e.g. a sofa GLB with wood legs + fabric cushions): trimesh.load(...,
    force="mesh") and trimesh.util.concatenate() both route multi-material
    scenes through the same atlas-packing code path that flattens real Kd
    colors into a generic-gray-plus-PNG combo (see the fix notes at the top
    of this file) -- so we deliberately avoid both here and instead dump()
    the loaded scene without concatenating, which preserves each part's own
    material untouched.
    """
    ext = os.path.splitext(local_path)[1].lower()

    if ext == ".ifc":
        pieces = load_ifc_as_named_meshes(local_path, warnings)
        if not pieces:
            raise ValueError(f"Furniture IFC contained no renderable geometry: {local_path}")
        return [m for (_, _, m) in pieces]

    loaded = trimesh.load(local_path)
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.dump(concatenate=False))
        if not geoms:
            raise ValueError(f"Furniture asset has no geometry: {local_path}")
        return [g for g in geoms if isinstance(g, trimesh.Trimesh) and len(g.vertices)]

    return [loaded]


def build_transform(position, rotation_deg, scale):
    """
    Builds a 4x4 transform in the app's Z-up runtime space:
    scale -> rotate (XYZ euler, degrees) -> translate.
    Matches the frontend convention: position/rotation/scale saved per
    furniture item in project_state.json.
    """
    position = position or [0, 0, 0]
    rotation_deg = rotation_deg or [0, 0, 0]
    scale = scale if scale is not None else [1, 1, 1]
    if isinstance(scale, (int, float)):
        scale = [scale, scale, scale]

    S = np.diag([scale[0], scale[1], scale[2], 1.0])

    rx, ry, rz = np.radians(rotation_deg)
    Rx = trimesh.transformations.rotation_matrix(rx, [1, 0, 0])
    Ry = trimesh.transformations.rotation_matrix(ry, [0, 1, 0])
    Rz = trimesh.transformations.rotation_matrix(rz, [0, 0, 1])
    R = Rz @ Ry @ Rx

    T = trimesh.transformations.translation_matrix(position)

    return T @ R @ S


# --------------------------------------------------------------------------
# Structural edits (Delta-Based State Management): project_state.json
# ["structural_edits"] is keyed by IFC GlobalId and looks like:
#   { "<GlobalId>": { "scale": [sx, sy, sz], "offset": [ox, oy, oz] } }
#
# input.ifc is READ-ONLY under this architecture -- the frontend never
# rewrites it. Every render, this script re-derives the edited geometry by
# applying the same scale/offset delta the user dragged in the Right Panel
# directly to the pristine mesh pulled fresh out of the IFC.
# --------------------------------------------------------------------------
def _sanitize_vec3(raw, default, warnings, context_id, field_name):
    """
    Coerces a project_state.json vec3 field into 3 finite floats, tolerating
    a single scalar, a too-short/too-long list, non-numeric entries, or a
    missing/None value. Never raises -- always returns a usable [x, y, z].
    """
    try:
        if raw is None:
            return list(default)
        if isinstance(raw, (int, float)):
            return [float(raw)] * 3
        if isinstance(raw, (list, tuple)):
            vals = list(raw)[:3] + list(default)[len(raw):3]
            vals = [float(v) for v in vals]
            if any(not np.isfinite(v) for v in vals):
                raise ValueError("non-finite component")
            return vals
        raise TypeError(f"unexpected type {type(raw).__name__}")
    except Exception as e:
        warnings.append(
            f"Element {context_id}: malformed '{field_name}' ({raw!r}: {e}); defaulting to {default}."
        )
        return list(default)


def build_structural_delta_transform(edit_def, warnings, global_id):
    """
    Builds a 4x4 transform for a single structural_edits entry: non-uniform
    scale pivoted about the mesh's OWN bounding-box center, then a world-
    space translation for "offset".

    Why pivot on the mesh's own center rather than the world origin:
    the IFC geometry here is extracted in absolute world coordinates
    (USE_WORLD_COORDS=True), so naively scaling about [0,0,0] would drag a
    wall that isn't centered at the origin off to one side instead of
    resizing it "in place" -- not what a user dragging a width/height
    slider expects to see.

    NOTE / known limitation: this assumes the live Xeokit viewer's
    entity.scale pivots around roughly the same point (the element's own
    local center). If your xeokit build instead scales native entities
    around their IFC local-placement origin (which can be off-center, e.g.
    at one end of a wall), the backend render and the live preview will
    disagree slightly on where the resized element sits. There isn't
    enough information in project_state.json to know which pivot Xeokit
    actually used, so this is the best-effort, most common-case choice --
    flagging it rather than silently guessing.
    """
    scale = _sanitize_vec3(edit_def.get("scale"), [1.0, 1.0, 1.0], warnings, global_id, "scale")
    offset = _sanitize_vec3(edit_def.get("offset"), [0.0, 0.0, 0.0], warnings, global_id, "offset")

    # Guard against zero/negative scale factors collapsing or inverting geometry.
    safe_scale = []
    for i, s in enumerate(scale):
        if s <= 0:
            warnings.append(
                f"Element {global_id}: non-positive scale component {s} on axis {i}; using 1.0 instead."
            )
            s = 1.0
        safe_scale.append(s)

    return safe_scale, offset


def apply_structural_edit(mesh, edit_def, warnings, global_id):
    """
    Applies one structural_edits entry to `mesh` IN PLACE (returns it too,
    for chaining), tolerating any malformed scale/offset without raising.
    """
    if not edit_def:
        return mesh

    try:
        scale, offset = build_structural_delta_transform(edit_def, warnings, global_id)

        if scale == [1.0, 1.0, 1.0] and offset == [0.0, 0.0, 0.0]:
            return mesh  # no-op edit, nothing to apply

        pivot = mesh.bounding_box.centroid if len(mesh.vertices) else np.zeros(3)

        S = np.eye(4)
        S[0, 0], S[1, 1], S[2, 2] = scale
        to_pivot = trimesh.transformations.translation_matrix(-pivot)
        from_pivot = trimesh.transformations.translation_matrix(pivot)
        scale_about_pivot = from_pivot @ S @ to_pivot

        T = trimesh.transformations.translation_matrix(offset)

        mesh.apply_transform(T @ scale_about_pivot)
    except Exception as e:
        warnings.append(f"Element {global_id}: structural edit failed ({e}); geometry left unedited.")

    return mesh


def main():
    parser = argparse.ArgumentParser(description="Merge IFC + furniture + materials into one Y-up OBJ.")
    parser.add_argument("--ifc", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--asset-base-url", default=None)
    args = parser.parse_args()

    warnings = []

    try:
        job_dir = os.path.abspath(args.job_dir)
        # jobs/<jobId>  ->  project root is two levels up
        project_root = os.path.abspath(os.path.join(job_dir, os.pardir, os.pardir))

        # --- Load project_state.json (tolerate missing/empty file) ---
        materials = {}
        furniture = []
        structural_edits = {}
        if os.path.exists(args.state):
            with open(args.state, "r", encoding="utf-8") as f:
                state = json.load(f) or {}
            materials = state.get("materials", {}) or {}
            furniture = state.get("furniture", []) or []
            structural_edits = state.get("structural_edits", {}) or {}
        else:
            warnings.append(f"project_state.json not found at {args.state}; rendering raw IFC only.")

        # --- 1. Structural IFC geometry ---
        log("[scene_merger] Reading structural IFC geometry...")
        structural_pieces = load_ifc_as_named_meshes(args.ifc, warnings)
        if not structural_pieces:
            raise ValueError("No renderable structural geometry found in input.ifc")

        materials_applied = 0
        structural_edits_applied = 0
        structural_named = []
        for idx, (global_id, ifc_type, mesh) in enumerate(structural_pieces):
            # 1. Delta-Based structural edit (resize/move), applied to the
            #    pristine per-element mesh BEFORE it joins the scene.
            #    input.ifc itself is never touched.
            edit_def = structural_edits.get(global_id)
            if edit_def:
                apply_structural_edit(mesh, edit_def, warnings, global_id)
                structural_edits_applied += 1

            # 2. Material override, as a pure Kd color (see fix notes above).
            mat_def = materials.get(global_id)
            if mat_def:
                warnings_before = len(warnings)
                apply_material_override(mesh, mat_def, warnings, global_id)
                # apply_material_override() swallows its own exceptions and
                # only records a warning -- only count it "applied" if it
                # didn't add a new warning, so a real bake failure can't hide
                # behind a "materials_applied": N success message.
                if len(warnings) == warnings_before:
                    materials_applied += 1

            name = _sanitize_name(f"struct_{idx:04d}_{global_id}", f"struct_{idx:04d}")
            structural_named.append((name, mesh))

        log(f"[scene_merger] {len(structural_named)} structural element(s), "
            f"{materials_applied} material override(s), "
            f"{structural_edits_applied} structural edit(s) applied.")

        # --- 2. Furniture ---
        furniture_named = []
        furniture_merged_count = 0
        for i, item in enumerate(furniture):
            # useProjectSync.js (spawnAsset/applyTemplate) always writes the
            # asset URL under "src" -- "url"/"fileUrl" are legacy/speculative
            # keys kept here only as a fallback for older saved states.
            url = item.get("src") or item.get("url") or item.get("fileUrl")
            if not url:
                warnings.append(f"Furniture item #{i} has no src/url/fileUrl; skipped.")
                continue
            try:
                local_path = resolve_asset_path(url, job_dir, project_root, args.asset_base_url, warnings)
                pieces = load_furniture_pieces(local_path, warnings)

                transform = build_transform(
                    item.get("position"), item.get("rotation"), item.get("scale"),
                )

                item_id = item.get("instanceId") or item.get("globalId") or item.get("id") or f"furniture_{i}"
                mat_def = materials.get(item.get("globalId") or item.get("id"))

                for p_idx, piece in enumerate(pieces):
                    piece.apply_transform(transform)
                    if mat_def:
                        # A material override on a furniture instance recolors
                        # the WHOLE piece uniformly, same as the frontend does.
                        apply_material_override(piece, mat_def, warnings, item_id)
                    name = _sanitize_name(f"furn_{i:04d}_{p_idx:02d}_{item_id}", f"furn_{i:04d}_{p_idx:02d}")
                    furniture_named.append((name, piece))

                if mat_def:
                    materials_applied += 1
                furniture_merged_count += 1
            except Exception as e:
                warnings.append(f"Furniture item #{i} ({url}) failed to load and was skipped: {e}")
                log(f"[scene_merger] furniture item #{i} ({url}) failed: {e}")

        log(f"[scene_merger] {furniture_merged_count}/{len(furniture)} furniture item(s) merged "
            f"({len(furniture_named)} part(s) total).")

        # --- 3. Merge everything (still Z-up) into a Scene, NOT a
        #        concatenated single mesh -- see build_merged_scene()
        #        docstring for why that distinction is the whole fix. ---
        merged_scene = build_merged_scene(structural_named + furniture_named)

        # --- 4. Axis fix: Z-up -> Y-up, applied ONCE to the whole scene ---
        merged_scene.apply_transform(z_up_to_y_up_matrix())

        # --- 5. Bounding box (post axis-fix, in the space APS/3ds Max will render) ---
        bounds = merged_scene.bounds  # shape (2,3): [min, max]
        bbox_min = bounds[0].tolist()
        bbox_max = bounds[1].tolist()
        bbox_center = merged_scene.centroid.tolist() if len(merged_scene.geometry) else [0, 0, 0]
        bbox_size = (bounds[1] - bounds[0]).tolist()

        # --- 6. Export merged OBJ (+ MTL). mtl_name is pinned to match the
        #        output file's own basename instead of trimesh's default
        #        "material.mtl", so concurrent render jobs writing into a
        #        shared directory can't clobber each other's materials. ---
        output_path = os.path.abspath(args.output)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        mtl_name = os.path.splitext(os.path.basename(output_path))[0] + ".mtl"
        merged_scene.export(output_path, file_type="obj", mtl_name=mtl_name)

        result = {
            "success": True,
            "output": output_path,
            "bbox": {
                "min": bbox_min,
                "max": bbox_max,
                "center": bbox_center,
                "size": bbox_size,
            },
            "furniture_count": furniture_merged_count,
            "materials_applied": materials_applied,
            "structural_edits_applied": structural_edits_applied,
            "warnings": warnings,
        }
        print(json.dumps(result))
        sys.exit(0)

    except Exception as e:
        log(traceback.format_exc())
        print(json.dumps({"success": False, "error": str(e), "warnings": warnings}))
        sys.exit(1)


if __name__ == "__main__":
    main()
