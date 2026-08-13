#!/usr/bin/env python3
"""
blender_render.py — Headless Blender / Cycles scene compositor.

Run as:
    blender --background --python blender_render.py -- \
        --ifc <path/to/input.ifc> \
        --state <path/to/project_state.json> \
        --output <path/to/result.png> \
        --job-dir <path/to/job_dir> \
        [--asset-base-url http://localhost:3000] \
        [--angle 360|interior|top_down|aerial|dollhouse|side|auto_rotation|walkthrough] \
        [--lighting daylight|overcast|night] \
        [--engine auto|cycles|eevee] \
        [--orbit-frames 12]

--angle controls the camera:
  - "360"/"interior" (default): collision-aware equirectangular camera
    inside a room, for a single walkthrough pano. Can only ever show the
    one room the camera is standing in.
  - "top_down"/"aerial"/"dollhouse": orthographic camera above the whole
    building looking straight down, framing every room/wall/furniture
    item at once -- the mode to use for "the whole edited floor plan" the
    way the BIM viewer's own overhead view shows it.
  - "side": orthographic elevation camera from the building's side (an
    architectural side/section-style view).
  - "auto_rotation"/"orbit"/"turntable": renders --orbit-frames (default
    12) frames orbiting the building at a fixed height/radius, each saved
    as its own file (orbit_0000.png, orbit_0001.png, ...) -- for a
    frontend turntable/spin viewer, not a single static image.
  - "walkthrough"/"walk"/"tour": detects every IfcSpace ("room") in the
    IFC, places one collision-aware equirectangular camera per room, and
    renders one pano per room (room_00_<name>.png, room_01_<name>.png,
    ...) plus a "rooms" list in the result JSON (id/name/pano
    filename/position) for a frontend multi-scene viewer to switch
    between. NOTE: this produces the panos to walk between rooms with,
    not the click-to-navigate hotspot UI itself -- that part lives in the
    Pannellum multi-scene HTML server.js generates from the "rooms" list
    (see server.js's buildRenderResponse). No automatic hotspot placement
    between adjacent rooms is done; the generated viewer lists rooms to
    jump between rather than placing arrows exactly at doorways.

--engine controls the render engine: "auto" (default) uses CYCLES for
the two equirectangular pano modes ("360"/"interior" and "walkthrough")
-- Eevee has never reliably supported panoramic camera rendering, unlike
Cycles -- and BLENDER_EEVEE_NEXT for the flat/orthographic modes
(top_down/side/auto_rotation), matching the speed-over-accuracy trade
this project had already made for those. "cycles"/"eevee" forces one
engine for every mode regardless.

--------------------------------------------------------------------------
ARCHITECTURE NOTE — why this does NOT use BlenderBIM/Bonsai's importer, and
does NOT go through an intermediate .glb, even though you asked me to pick
whichever is more reliable:

Both of those routes still funnel your data through a serialization step
that either loses information or is unstable to depend on:

  - BlenderBIM/Bonsai's `bpy.ops.bim.load_project(...)` operator does a full
    semantic IFC import (spatial tree, property sets, quantities...) that
    you don't need for a render-only pipeline, it's slow on anything but a
    small model, and its Python API has changed shape across Bonsai
    versions -- exactly the kind of "worked yesterday, broke on upgrade"
    fragility you're trying to get away from.
  - Converting via IfcConvert to .glb and importing that solves nothing for
    material matching: IfcConvert's default glTF node names are a
    hex-mangled `product-<guid-as-hex>-body` string, not your GlobalId, and
    while `--use-element-guids` is documented for OBJ/DAE/STP/SVG output,
    its behavior for glTF/GLB specifically isn't consistently documented,
    so building a matching pipeline on it means matching sanitized,
    possibly-`.001`-suffixed Blender object names against your `materials`
    dict keys by fuzzy string comparison -- a second coordinate-mismatch
    bug waiting to happen, in the same spot as the one you're fixing now.

Instead, this script uses `ifcopenshell.geom` directly -- the same
iterator you were already using in your trimesh-based scene_merger.py --
to pull each element's raw (GlobalId, vertices, faces) straight out of the
IFC, and builds native Blender mesh objects from that data with
`bpy.data.meshes.new().from_pydata(...)`. This means:
  - material matching against `materials["<GlobalId>"]` is an exact dict
    lookup, never a fuzzy name match;
  - the bounding-box centering in step 3 operates on the exact same
    vertex data that gets built into the mesh, so there's no
    import/re-export round trip for a coordinate bug to hide in;
  - there's no BlenderBIM operator API to break across versions -- Bonsai
    is only relied on for one thing: bundling `ifcopenshell` inside
    Blender's own Python so `import ifcopenshell` works at all. If you'd
    rather not install Bonsai, `pip install ifcopenshell` straight into
    Blender's bundled Python interpreter (its `python.exe`/`bin/python3.x`,
    NOT your system Python) works exactly as well.

--------------------------------------------------------------------------
STDOUT CONTRACT -- please read before wiring this into aps-pipeline.js:

Under a plain `python scene_merger.py`, "only print JSON to stdout" was
achievable. Under `blender --background`, it is NOT: Blender itself prints
its own startup banner, license notices, and (depending on build/addons)
assorted diagnostic lines to stdout before your script ever runs, and
there's no flag that fully silences all of it. Trying to `JSON.parse()`
the whole stdout stream from Node will break the first time Blender adds
or changes one of those lines.

So instead of a bare JSON line, this script prints ONE line prefixed with
a fixed sentinel:

    RENDER_RESULT_JSON:{"success": true, ...}

On the Node side, read stdout, split it into lines, and take the JSON
after the LAST line starting with "RENDER_RESULT_JSON:" -- don't assume
it's the only line, don't assume it's the first line. Everything else
(progress, warnings, tracebacks) goes to stderr via log(), same as before.
--------------------------------------------------------------------------

On failure: RENDER_RESULT_JSON:{"success": false, "error": "..."} and the
process exits via sys.exit(1) (Blender's own exit code plumbing still
applies on top of this).

--------------------------------------------------------------------------
WHY YOUR COLORS WERE WASHED OUT (the "colours are missing" bug):

Two compounding bugs, not one:

1. main() unconditionally set `scene.render.engine = "BLENDER_EEVEE_NEXT"`
   AFTER setup_camera()/setup_camera_top_down() had already set it to
   CYCLES -- so every render, including the "360"/interior equirectangular
   pano, actually ran in Eevee Next. Eevee has never reliably supported
   panoramic camera rendering (that has historically been a Cycles-only
   feature), so the interior pano mode was likely broken too, not just
   visually off. Fixed by centralizing the engine choice in main() (see
   `--engine` above) instead of setting it in three different places.

2. Blender 4.0+ (including 5.1) defaults `scene.view_settings.view_transform`
   to "AgX" -- a filmic-style tone curve that deliberately compresses and
   desaturates bright colors for a more "photographic" look. That is
   exactly what turns your saturated hex wall colors into the pale pastel
   boxes in the screenshot: AgX was never told not to touch them. Fixed by
   `configure_color_management()` below, which sets view_transform to
   "Standard" (a much closer 1:1 mapping from your hex Base Color values
   to final pixel color) before every render.
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

try:
    import bpy
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "This script must be run inside Blender: "
                 "blender --background --python blender_render.py -- --ifc ... --state ... --output ... --job-dir ..."
    }))
    sys.exit(1)

from mathutils import Matrix, Vector  # noqa: E402  (must come after the bpy import guard)
from mathutils.bvhtree import BVHTree  # noqa: E402

try:
    import ifcopenshell
    import ifcopenshell.geom
except ImportError:
    print("RENDER_RESULT_JSON:" + json.dumps({
        "success": False,
        "error": (
            "ifcopenshell is not importable inside Blender's own Python. "
            "Either enable the Bonsai/BlenderBIM add-on (it bundles ifcopenshell), "
            "or run Blender's bundled python -m pip install ifcopenshell "
            "(NOT your system Python's pip)."
        ),
    }))
    sys.exit(1)


def log(msg):
    """All progress/diagnostic output goes to stderr; stdout is reserved
    for Blender's own noise plus our one RENDER_RESULT_JSON: sentinel line."""
    print(msg, file=sys.stderr, flush=True)


def parse_args():
    """Blender swallows everything before a bare '--' itself; only what
    comes after belongs to us."""
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser(description="Render a 360 panorama of an IFC + furniture scene in Cycles.")
    parser.add_argument("--ifc", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--asset-base-url", default=None)
    # --angle / --lighting: server.js has been passing these since the
    # top-down dollhouse feature was started, but this script never
    # declared them, so argparse rejected the command line outright and
    # NO render ever ran -- server.js's error handler would report that,
    # but whatever result.png/pano_render.html already existed in the job
    # folder from an earlier successful run just sat there unchanged,
    # which is what made it look like "the render is stuck/broken" rather
    # than "the render hasn't executed at all in a while."
    # No `choices=` here on purpose: an unrecognized value should degrade
    # gracefully to a sane default (and get logged), not make argparse
    # sys.exit(2) before the scene is even built -- that's the exact
    # failure mode that made every render silently no-op in the first
    # place when this script didn't know --angle at all.
    parser.add_argument("--angle", default="360")
    parser.add_argument("--lighting", default="daylight")
    # Same "degrade gracefully, don't argparse-reject" philosophy as
    # --angle/--lighting above: an unrecognized --engine value falls back
    # to 'auto' further down rather than killing the whole render.
    parser.add_argument("--engine", default="auto")
    parser.add_argument("--orbit-frames", type=int, default=12,
                         help="Frame count for --angle auto_rotation/orbit/turntable.")
    return parser.parse_args(argv)



# --------------------------------------------------------------------------
# Tunables. Eye height is along Z, not Y: Blender and raw IFC coordinates
# are both Z-up, unlike the Y-up world your old APS/3ds Max target expected
# -- see the CAMERA note further down for why [0, 1.5, 0] from the original
# ask would have put the camera 1.5m sideways instead of 1.5m up.
# --------------------------------------------------------------------------
EYE_HEIGHT_M = 1.5
RESOLUTION = (1024, 512)  # 2:1 equirectangular pano for the interior walkthrough mode
# RESOLUTION = (4096, 2048)  # Halved from 4096x2048 for faster preview-grade renders
CYCLES_SAMPLES = 32  # Dropped from 128 to 32 for massive speed boost
EEVEE_SAMPLES = 32  # Eevee Next's equivalent render-sample setting (TAA), for the flat/ortho modes
CAMERA_CLEARANCE_M = 0.3  # min. distance from any surface for the camera to be considered "in free space"
ORBIT_LENS_MM = 24  # wide-angle, consistent with the interior camera
SIDE_CAMERA_MARGIN_M = 1.0  # extra breathing room around the footprint edge for the side elevation view


# --------------------------------------------------------------------------
# IFC -> raw (global_id, ifc_type, verts (N,3) float64, faces (M,3) int64)
# in world coordinates. Ported straight from your trimesh scene_merger.py --
# same iterator, same skip list, just no trimesh.Trimesh wrapper since bpy
# builds its own mesh datablocks directly from verts/faces.
# --------------------------------------------------------------------------
SKIP_IFC_TYPES = {
    "IfcSpace", "IfcOpeningElement", "IfcSite", "IfcAnnotation",
    "IfcGrid", "IfcGridAxis",
}


def load_ifc_elements(ifc_path, warnings):
    if not os.path.exists(ifc_path):
        raise FileNotFoundError(f"IFC file not found: {ifc_path}")

    ifc_file = ifcopenshell.open(ifc_path)

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, True)
    settings.set(settings.APPLY_DEFAULT_MATERIALS, True)

    elements = []
    iterator = ifcopenshell.geom.iterator(settings, ifc_file, num_threads=os.cpu_count() or 2)

    if not iterator.initialize():
        log("[blender_render] IFC geometry iterator found nothing to render.")
        return elements

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

            native_color = _extract_native_color(shape)

            elements.append({
                "global_id": global_id, "ifc_type": ifc_type, "verts": verts, "faces": faces,
                "native_color": native_color,
            })
        except Exception as e:
            warnings.append(f"Skipped one IFC element due to geometry error: {e}")
        if not iterator.next():
            break

    return elements


def _extract_native_color(shape):
    """Best-effort read of whatever diffuse color is already baked into this
    element's own IFC styling (IfcStyledItem / surface style), independent
    of project_state.json's per-GlobalId override dict. This is the fallback
    used when an element (very commonly a furniture piece, which has no
    entry in project_state.json's materials dict at all -- that dict is
    keyed by the MAIN building's wall/slab GlobalIds, not the internal
    GlobalIds of a separately-loaded furniture .ifc/.glb) has no explicit
    color override: without this, such elements got NO material assigned
    at all and rendered as flat Blender-default gray, which is what showed
    up as "whitish" boxes in the screenshot.

    ifcopenshell's geometry iterator exposes per-face style info as
    shape.geometry.materials (a list of style objects) plus
    shape.geometry.material_ids (per-face index into that list) when
    APPLY_DEFAULT_MATERIALS is set, as it is in load_ifc_elements() above.
    Different ifcopenshell builds expose the diffuse value under slightly
    different attribute names, so this tries the common ones defensively
    and gives up (returns None) rather than raising -- a missing native
    color should never fail the whole render.
    """
    try:
        mats = getattr(shape.geometry, "materials", None)
        if not mats:
            return None
        # Most furniture/product IFCs use one uniform material for the
        # whole shape; just take the first style found rather than
        # weighting by per-face material_ids, which is unnecessary
        # complexity for the common single-material case.
        style = mats[0]
        diffuse = getattr(style, "diffuse", None)
        if diffuse is None:
            return None
        r, g, b = diffuse[0], diffuse[1], diffuse[2]
        transparency = getattr(style, "transparency", 0.0) or 0.0
        alpha = max(0.0, min(1.0, 1.0 - transparency))
        # ifcopenshell's style.diffuse is already 0-1 linear-ish float, not
        # 0-255 -- distinct from the hex/0-255 tolerant parsing _parse_rgba
        # does for project_state.json's user-authored hex strings.
        return (float(r), float(g), float(b), alpha)
    except Exception:
        return None


# --------------------------------------------------------------------------
# Structural edits: project_state.json["structural_edits"], same
# scale-about-own-bbox-center-then-offset delta as your existing pipeline.
# --------------------------------------------------------------------------
def _sanitize_vec3(raw, default, warnings, context_id, field_name):
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
        warnings.append(f"Element {context_id}: malformed '{field_name}' ({raw!r}: {e}); defaulting to {default}.")
        return list(default)


def apply_structural_edit(verts, edit_def, warnings, global_id):
    """Returns a NEW verts array; never mutates in place, never raises."""
    if not edit_def:
        return verts
    try:
        scale = _sanitize_vec3(edit_def.get("scale"), [1.0, 1.0, 1.0], warnings, global_id, "scale")
        offset = np.array(_sanitize_vec3(edit_def.get("offset"), [0.0, 0.0, 0.0], warnings, global_id, "offset"))
        scale = [1.0 if s <= 0 else s for s in scale]
        if scale == [1.0, 1.0, 1.0] and not offset.any():
            return verts
        pivot = (verts.min(axis=0) + verts.max(axis=0)) / 2.0
        return (verts - pivot) * np.array(scale) + pivot + offset
    except Exception as e:
        warnings.append(f"Element {global_id}: structural edit failed ({e}); geometry left unedited.")
        return verts


# --------------------------------------------------------------------------
# Materials: native Principled BSDF, matched by exact GlobalId dict lookup
# -- no fuzzy name matching, because we never serialized through a format
# that mangled the names in the first place.
# --------------------------------------------------------------------------
def _parse_rgba(raw_color, warnings, context_id):
    """Same tolerant hex / 0-255 / 0-1 parsing as your trimesh pipeline,
    returned as 0.0-1.0 floats since that's what Blender wants."""
    fallback = (0.8, 0.8, 0.8, 1.0)
    if raw_color is None:
        return fallback
    try:
        if isinstance(raw_color, str):
            hex_str = raw_color.strip().lstrip("#")
            if len(hex_str) not in (6, 8):
                raise ValueError(f"Unexpected hex length in color '{raw_color}'")
            r = int(hex_str[0:2], 16) / 255.0
            g = int(hex_str[2:4], 16) / 255.0
            b = int(hex_str[4:6], 16) / 255.0
            a = int(hex_str[6:8], 16) / 255.0 if len(hex_str) == 8 else 1.0
            return (r, g, b, a)
        if isinstance(raw_color, (list, tuple)) and len(raw_color) >= 3:
            comps = [float(c) for c in raw_color[:4]]
            is_normalized = max(comps[:3]) <= 1.0
            rgb = comps[:3] if is_normalized else [c / 255.0 for c in comps[:3]]
            alpha = comps[3] if len(comps) == 4 else 1.0
            alpha = alpha if alpha <= 1.0 else alpha / 255.0
            return (rgb[0], rgb[1], rgb[2], alpha)
    except Exception as e:
        warnings.append(f"Element {context_id}: could not parse color {raw_color!r} ({e}); using default gray.")
    return fallback


def resolve_material_def(global_id, native_color, materials_dict):
    """Single source of truth for 'what color does this element get',
    shared by both the structural loop and the furniture loop below (they
    used to diverge -- structural checked project_state.json's materials
    dict and furniture checked nothing at all). Priority:
      1. An explicit user override in project_state.json["materials"] --
         this is what the BIM editor's own color picker writes, so it
         always wins when present.
      2. The color already baked into the element's own IFC styling
         (native_color, from _extract_native_color) -- covers furniture
         pieces and any structural element with no explicit override.
      3. None -- caller leaves the object with no material slot, which
         renders as Blender-default gray. Only hit if an element has
         neither an override nor any native IFC style at all.
    """
    mat_def = materials_dict.get(global_id)
    if mat_def and "color" in mat_def:
        return mat_def
    if native_color is not None:
        return {"color": native_color}
    return None


def make_principled_material(name, mat_def, warnings, context_id):
    # 1. Parse the raw sRGB color from the frontend
    raw_rgba = _parse_rgba(mat_def.get("color"), warnings, context_id)
    
    # 2. Convert Web sRGB to Blender's Linear Color Space
    # (This stops Blender from double-brightening the colors)
    linear_rgb = [pow(max(0.0, float(c)), 2.2) for c in raw_rgba[:3]]
    linear_rgba = tuple(linear_rgb) + (raw_rgba[3],)

    # 3. Create the Material
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    mat.diffuse_color = linear_rgba  # Viewport fallback
    
    # 4. BULLETPROOF NODE SEARCH: Search by TYPE, not by string name. 
    bsdf = None
    out_node = None
    for node in mat.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            bsdf = node
        elif node.type == 'OUTPUT_MATERIAL':
            out_node = node
            
    # 5. If missing or broken in headless mode, force-build the node tree
    if not bsdf or not out_node:
        mat.node_tree.nodes.clear()
        bsdf = mat.node_tree.nodes.new(type='ShaderNodeBsdfPrincipled')
        out_node = mat.node_tree.nodes.new(type='ShaderNodeOutputMaterial')
        mat.node_tree.links.new(bsdf.outputs['BSDF'], out_node.inputs['Surface'])

    # 6. Apply the specific properties safely
    # 6. Apply the specific properties safely
    try:
        bsdf.inputs["Base Color"].default_value = linear_rgba
        
        # Increase roughness slightly for a flatter wall paint look
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = float(mat_def.get("roughness", 0.9))
            
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = float(mat_def.get("metalness", 0.0))
            
        # THE FIX: Kill the white "plastic" glare from the sun
        # Blender 4.0+ uses 'Specular IOR Level', older versions use 'Specular'
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.0
        elif "Specular" in bsdf.inputs:
            bsdf.inputs["Specular"].default_value = 0.0
            
    except Exception as e:
        warnings.append(f"Element {context_id}: BSDF socket error ({e})")
        
    return mat
# --------------------------------------------------------------------------
# Building Blender objects from raw ifcopenshell geometry.
# --------------------------------------------------------------------------
def make_object_from_verts_faces(name, verts, faces, collection):
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(verts.tolist(), [], faces.tolist())
    mesh.validate(verbose=False)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def _sanitize_name(raw, fallback):
    raw = str(raw or fallback)
    cleaned = re.sub(r"[^A-Za-z0-9_\-]+", "_", raw).strip("_")
    return cleaned or fallback


# --------------------------------------------------------------------------
# Furniture asset resolution -- same "try local disk first" fix as the
# trimesh pipeline: this script is very likely spawned as a child process
# of the same Node server that served these http://localhost:3000/...
# URLs, so an HTTP round-trip back into a server that's busy running this
# very render job can hang until it times out and silently drop the item.
# Local resolution is attempted first for any localhost/loopback host or
# one matching --asset-base-url; a genuine network fetch (stdlib urllib,
# no optional 'requests' dependency) is the fallback, not the first move.
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
    import urllib.error
    import urllib.request

    parsed = urlparse(url)
    req = urllib.request.Request(url, headers={"User-Agent": "blender_render/1.0"})
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

    if parsed.scheme not in ("http", "https"):
        for candidate in _local_candidates(parsed.path, job_dir, project_root):
            if os.path.exists(candidate):
                return candidate
        if asset_base_url:
            full_url = asset_base_url.rstrip("/") + "/" + parsed.path.lstrip("/")
            return resolve_asset_path(full_url, job_dir, project_root, None, warnings)
        raise FileNotFoundError(f"Could not resolve furniture asset locally: {url_or_path}")

    host = (parsed.hostname or "").lower()
    looks_local = host in ("localhost", "127.0.0.1", "0.0.0.0", "::1")
    if asset_base_url:
        base_host = (urlparse(asset_base_url).hostname or "").lower()
        looks_local = looks_local or (host == base_host)

    if looks_local:
        for candidate in _local_candidates(parsed.path, job_dir, project_root):
            if os.path.exists(candidate):
                return candidate
        warnings.append(
            f"Asset URL '{url_or_path}' looked local (host={host!r}) but no matching file was "
            f"found under {job_dir} or {project_root}; falling back to an HTTP fetch, which may "
            f"hang if this process was itself spawned by that same server."
        )

    return _http_download(url_or_path, warnings)


def import_furniture_item(item, index, job_dir, project_root, asset_base_url, materials, warnings, furniture_collection):
    """
    Downloads/resolves + imports one furniture item, parents whatever new
    top-level objects it produced under a single Empty, and applies that
    item's position/rotation/scale to the Empty -- so a multi-object GLB
    (e.g. separate meshes for a bed frame + mattress) moves as one rigid
    instance, exactly like your frontend treats it.

    Returns True if at least one object was imported for this item.
    """
    url = item.get("src") or item.get("url") or item.get("fileUrl")
    if not url:
        warnings.append(f"Furniture item #{index} has no src/url/fileUrl; skipped.")
        return False

    item_id = item.get("instanceId") or item.get("globalId") or item.get("id") or f"furniture_{index}"
    local_path = resolve_asset_path(url, job_dir, project_root, asset_base_url, warnings)
    ext = os.path.splitext(local_path)[1].lower()

    before = set(bpy.data.objects)

    if ext == ".ifc":
        elements = load_ifc_elements(local_path, warnings)
        if not elements:
            raise ValueError(f"Furniture IFC contained no renderable geometry: {local_path}")
        for e_idx, el in enumerate(elements):
            name = _sanitize_name(f"furn_{index:04d}_{e_idx:02d}_{item_id}", f"furn_{index:04d}_{e_idx:02d}")
            obj = make_object_from_verts_faces(name, el["verts"], el["faces"], furniture_collection)
            # THE FIX: this used to import furniture geometry with no
            # material step at all, so every furniture .ifc piece rendered
            # as flat Blender-default gray regardless of what color it was
            # authored with. Same override-first-then-native-color logic
            # as the structural loop in main(), just applied here too.
            mat_def = resolve_material_def(el["global_id"], el.get("native_color"), materials)
            if mat_def:
                mat = make_principled_material(f"mat_furn_{index:04d}_{e_idx:02d}_{el['global_id']}",
                                                mat_def, warnings, el["global_id"])
                obj.data.materials.clear()
                obj.data.materials.append(mat)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=local_path)
    elif ext == ".obj":
        # Blender 4.0+ ships the new 'wm.obj_import'; older versions use
        # 'import_scene.obj'. Try the modern one first, fall back cleanly.
        if hasattr(bpy.ops, "wm") and hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=local_path)
        else:
            bpy.ops.import_scene.obj(filepath=local_path)
    else:
        raise ValueError(f"Unsupported furniture asset extension '{ext}' for {local_path}")

    after = set(bpy.data.objects)
    new_objects = list(after - before)
    if not new_objects:
        raise ValueError(f"Import produced no objects: {local_path}")

    # Move anything the importer created into our furniture collection
    # (glTF/OBJ importers link into the active/scene collection by default).
    for obj in new_objects:
        for coll in list(obj.users_collection):
            coll.objects.unlink(obj)
        furniture_collection.objects.link(obj)

    pivot_name = _sanitize_name(f"furn_pivot_{index:04d}_{item_id}", f"furn_pivot_{index:04d}")
    pivot = bpy.data.objects.new(pivot_name, None)
    furniture_collection.objects.link(pivot)

    for obj in new_objects:
        if obj.parent is None:
            obj.parent = pivot
            obj.matrix_parent_inverse = pivot.matrix_world.inverted()

    position = item.get("position") or [0, 0, 0]
    rotation_deg = item.get("rotation") or [0, 0, 0]
    scale = item.get("scale")
    scale = [1, 1, 1] if scale is None else ([scale] * 3 if isinstance(scale, (int, float)) else list(scale))

    # Map Frontend (Three.js Y-up) to Blender (Z-up) so furniture isn't floating
    pivot.location = (position[0], -position[2], position[1])
    
    pivot.rotation_mode = "XYZ"
    pivot.rotation_euler = tuple(np.radians(rotation_deg))
    pivot.scale = scale

    return True


# --------------------------------------------------------------------------
# Camera.
#
# CAMERA NOTE: the ask was [0, 1.5, 0] for eye level, which is Y-up
# thinking left over from the old APS/3ds Max target. Blender's world (and
# raw IFC world coordinates, since USE_WORLD_COORDS was used above) is
# Z-up, so [0, 1.5, 0] would place the camera 1.5m sideways at floor
# height, not 1.5m up -- I've used [0, 0, EYE_HEIGHT_M] instead. One nice
# side effect of the Blender migration: there's no Z-up -> Y-up axis
# correction step left anywhere in this pipeline at all.
# --------------------------------------------------------------------------
def _build_scene_bvh(scene):
    """Combine every mesh object's evaluated, world-space geometry (structure
    AND furniture -- whatever is linked into the scene by the time this is
    called) into a single BVHTree, so the camera can be tested against the
    real room geometry rather than against per-object bounding boxes."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    all_verts = []
    all_polys = []
    vert_offset = 0

    for obj in scene.objects:
        if obj.type != 'MESH':
            continue
        obj_eval = obj.evaluated_get(depsgraph)
        mesh = obj_eval.to_mesh()
        if mesh is None:
            continue
        if not mesh.polygons:
            obj_eval.to_mesh_clear()
            continue
        matrix_world = obj_eval.matrix_world
        all_verts.extend(matrix_world @ v.co for v in mesh.vertices)
        all_polys.extend([i + vert_offset for i in poly.vertices] for poly in mesh.polygons)
        vert_offset += len(mesh.vertices)
        obj_eval.to_mesh_clear()

    if not all_verts or not all_polys:
        return None
    return BVHTree.FromPolygons(all_verts, all_polys)


def _clearance_at(bvh, x, y, z):
    """Distance from (x, y, z) to the nearest mesh surface in the scene, or
    +inf if there's no geometry (or no BVH) to measure against."""
    if bvh is None:
        return float('inf')
    _, _, _, distance = bvh.find_nearest(Vector((x, y, z)))
    return distance if distance is not None else float('inf')


def _find_clear_camera_xy(bvh, center_x, center_y, min_x, max_x, min_y, max_y, z,
                           clearance_threshold=CAMERA_CLEARANCE_M):
    """Find an (x, y) inside the building footprint with at least
    `clearance_threshold` meters of empty space to the nearest surface in
    every direction -- i.e. NOT buried inside an interior wall.

    Fast path: the bbox center is already clear -> use it unchanged (this is
    the common case and keeps the old behavior when nothing is wrong).

    Slow path: the center is inside/too close to a wall, so scan a grid over
    the footprint and keep whichever sample point has the largest clearance.
    That point is, by construction, in the middle of whichever room/hallway
    has the most open space -- exactly "shift along X/Y until in free
    space," just done exhaustively instead of via directional nudges, so it
    can't get stuck against the *inside* face of the same wall it started
    in.
    """
    center_clearance = _clearance_at(bvh, center_x, center_y, z)
    if center_clearance >= clearance_threshold:
        return center_x, center_y, center_clearance

    width = max(max_x - min_x, 1e-3)
    height = max(max_y - min_y, 1e-3)
    # ~0.3m grid spacing, capped so pathological huge/tiny floorplans don't
    # blow up the sample count.
    steps_x = min(40, max(8, int(width / 0.3)))
    steps_y = min(40, max(8, int(height / 0.3)))

    best_x, best_y, best_clearance = center_x, center_y, center_clearance
    for i in range(steps_x + 1):
        x = min_x + (width * i / steps_x)
        for j in range(steps_y + 1):
            y = min_y + (height * j / steps_y)
            clearance = _clearance_at(bvh, x, y, z)
            if clearance > best_clearance:
                best_x, best_y, best_clearance = x, y, clearance
                if best_clearance >= clearance_threshold * 3:
                    # Comfortably in open space already; no need to keep
                    # scanning every remaining cell.
                    return best_x, best_y, best_clearance

    return best_x, best_y, best_clearance


def _world_space_bbox(objects):
    """Correct world-space AABB for a collection of Blender objects, using
    obj.matrix_world @ corner instead of obj.location + corner.

    The old code (`obj.location.x + corner[0]`) is only correct for
    objects with an identity parent transform. It silently breaks for any
    parented object -- e.g. a furniture mesh parented to a placement pivot
    Empty -- because such a mesh's own `.location` is local to its parent
    (usually (0,0,0)), so the pivot's actual position/rotation/scale never
    gets applied and the mesh's *own native, pre-placement* coordinates
    (whatever coordinate system its source .ifc/.glb happened to use) leak
    into the bbox instead. That corrupts any downstream "footprint center"
    or "search bounds" calculation.
    """
    min_v = Vector((float('inf'),) * 3)
    max_v = Vector((float('-inf'),) * 3)
    found = False
    for obj in objects:
        if obj.type != 'MESH':
            continue
        mw = obj.matrix_world
        for corner in obj.bound_box:
            world_co = mw @ Vector(corner)
            min_v.x, min_v.y, min_v.z = min(min_v.x, world_co.x), min(min_v.y, world_co.y), min(min_v.z, world_co.z)
            max_v.x, max_v.y, max_v.z = max(max_v.x, world_co.x), max(max_v.y, world_co.y), max(max_v.z, world_co.z)
            found = True
    return (min_v, max_v) if found else None


def _footprint_bounds(structure_collection, scene):
    """Room footprint for camera framing/search purposes is defined by the
    building SHELL (walls/slabs), never by furniture: furniture sits well
    inside that shell, so including it can only ever shrink-or-corrupt the
    footprint, never legitimately extend it. Falls back to the whole
    scene if the structure collection is somehow empty."""
    bbox = _world_space_bbox(structure_collection.objects)
    if bbox is None:
        bbox = _world_space_bbox(scene.objects)
    return bbox


def setup_camera(structure_collection):
    cam_data = bpy.data.cameras.new("PanoCamera")
    scene = bpy.context.scene

    # NOTE: engine selection used to happen right here (forcing CYCLES),
    # but main() unconditionally overwrote it again later with
    # BLENDER_EEVEE_NEXT -- meaning every "interior" pano actually rendered
    # in Eevee, which has never reliably supported panoramic cameras. The
    # engine is now chosen once, centrally, in main() (see --engine).
    import addon_utils
    addon_utils.enable("cycles")

    cam_data.type = 'PANO'
    if hasattr(cam_data, 'cycles'):
        cam_data.cycles.panorama_type = 'EQUIRECTANGULAR'

    cam_obj = bpy.data.objects.new("PanoCamera", cam_data)
    scene.collection.objects.link(cam_obj)

    bbox = _footprint_bounds(structure_collection, scene)
    if bbox is not None:
        bmin, bmax = bbox
        min_x, min_y = bmin.x, bmin.y
        max_x, max_y = bmax.x, bmax.y
        center_x = (min_x + max_x) / 2.0
        center_y = (min_y + max_y) / 2.0
    else:
        center_x, center_y = 5.0, 5.0
        min_x, max_x, min_y, max_y = -5.0, 15.0, -5.0, 15.0

    # 🎯 COLLISION-AWARE CAMERA PLACEMENT: if the bbox center lands inside
    # (or within CAMERA_CLEARANCE_M of) a mesh -- e.g. an interior dividing
    # wall -- walk the search out across the footprint until we find open
    # space, instead of blindly trusting the geometric center. Clearance
    # is still checked against the FULL scene BVH (structure + furniture)
    # so the camera avoids clipping into a sofa just as much as a wall --
    # only the search *bounds* come from the structure-only footprint.
    bvh = _build_scene_bvh(scene)
    cam_x, cam_y, clearance = _find_clear_camera_xy(
        bvh, center_x, center_y, min_x, max_x, min_y, max_y, EYE_HEIGHT_M,
    )

    if bvh is None:
        log("[blender_render] No mesh geometry found for camera collision check; using raw bbox center.")
    elif (cam_x, cam_y) != (center_x, center_y):
        log(f"[blender_render] Bbox center ({center_x:.2f}, {center_y:.2f}) was inside/too close to "
            f"geometry; camera shifted to ({cam_x:.2f}, {cam_y:.2f}) with {clearance:.2f}m clearance.")
    else:
        log(f"[blender_render] Camera placed at bbox center ({cam_x:.2f}, {cam_y:.2f}), "
            f"{clearance:.2f}m clearance.")

    if clearance < CAMERA_CLEARANCE_M:
        log(f"[blender_render] WARNING: best available camera spot still only has "
            f"{clearance:.2f}m clearance (< {CAMERA_CLEARANCE_M}m target); floorplan may have "
            f"no sufficiently open room/hallway.")

    cam_obj.location = (cam_x, cam_y, EYE_HEIGHT_M)

    import numpy as np
    cam_obj.rotation_euler = (np.radians(90.0), 0.0, 0.0)
    scene.camera = cam_obj
    return cam_obj


# --------------------------------------------------------------------------
# Top-down "dollhouse" camera: an interior 360 pano, by definition, can
# only ever show the one room the camera is standing in -- it can't see
# through walls into the rest of the floor plan. Showing "the whole edited
# floor plan" (all rooms, all colors, all furniture, like the BIM viewer's
# own overhead view) needs a camera above the building looking straight
# down instead. This IFC has no roof/ceiling slab, so a top-down shot sees
# straight into every room with nothing to remove or hide.
# --------------------------------------------------------------------------
TOP_DOWN_MARGIN_M = 1.0  # extra breathing room around the footprint edge


def setup_camera_top_down(scene_for_bounds):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("DollhouseCamera")
    cam_data.type = 'ORTHO'

    # Frame the WHOLE scene (structure + furniture), unlike the interior
    # camera's search bounds -- here we want everything visible, not just
    # a footprint to search within.
    bbox = _world_space_bbox(scene_for_bounds.objects)
    if bbox is None:
        bmin, bmax = Vector((-5, -5, 0)), Vector((5, 5, 3))
    else:
        bmin, bmax = bbox

    center_x = (bmin.x + bmax.x) / 2.0
    center_y = (bmin.y + bmax.y) / 2.0
    width = max(bmax.x - bmin.x, 1e-3) + 2 * TOP_DOWN_MARGIN_M
    depth = max(bmax.y - bmin.y, 1e-3) + 2 * TOP_DOWN_MARGIN_M
    height_above = max(bmax.z - bmin.z, 1.0) + max(width, depth)  # comfortably clear of the tallest wall

    cam_data.ortho_scale = max(width, depth)

    cam_obj = bpy.data.objects.new("DollhouseCamera", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.location = (center_x, center_y, bmax.z + height_above)
    # Identity rotation looks straight down -Z in Blender's Z-up world --
    # exactly "looking down at the floor plan," no rotation math needed.
    cam_obj.rotation_euler = (0.0, 0.0, 0.0)
    scene.camera = cam_obj

    log(f"[blender_render] Top-down camera at ({center_x:.2f}, {center_y:.2f}, "
        f"{cam_obj.location.z:.2f}), ortho_scale={cam_data.ortho_scale:.2f} "
        f"covering a {width:.2f}x{depth:.2f}m footprint.")

    return cam_obj, (width, depth)

def load_ifc_rooms(ifc_path, warnings):
    """Extracts IfcSpace ('room') geometry for the walkthrough mode's
    per-room camera placement. This deliberately does NOT reuse
    load_ifc_elements(), which puts IfcSpace in SKIP_IFC_TYPES on purpose
    (spaces aren't solid geometry meant to be rendered as walls/floors are)
    -- here we want exactly the opposite: only IfcSpace, for its bounding
    box/centroid, never its faces.

    Returns a list of {global_id, name, min, max, center} dicts (min/max/
    center are numpy (3,) arrays in world coords, same convention as
    load_ifc_elements' verts)."""
    if not os.path.exists(ifc_path):
        raise FileNotFoundError(f"IFC file not found: {ifc_path}")

    ifc_file = ifcopenshell.open(ifc_path)
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, True)

    rooms = []
    iterator = ifcopenshell.geom.iterator(settings, ifc_file, num_threads=os.cpu_count() or 2)
    if not iterator.initialize():
        log("[blender_render] IFC geometry iterator found nothing while scanning for rooms.")
        return rooms

    while True:
        shape = iterator.get()
        try:
            elem = ifc_file.by_id(shape.id)
            if elem.is_a() == "IfcSpace":
                verts = np.array(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
                if len(verts) > 0:
                    bmin = verts.min(axis=0)
                    bmax = verts.max(axis=0)
                    name = getattr(elem, "LongName", None) or getattr(elem, "Name", None) or f"Room_{shape.id}"
                    rooms.append({
                        "global_id": getattr(elem, "GlobalId", f"space_{shape.id}"),
                        "name": str(name),
                        "min": bmin,
                        "max": bmax,
                        "center": (bmin + bmax) / 2.0,
                    })
        except Exception as e:
            warnings.append(f"Skipped one IfcSpace while detecting rooms: {e}")
        if not iterator.next():
            break

    return rooms


def setup_camera_in_room(room, cam_name, warnings):
    """One collision-aware equirectangular camera placed inside a single
    room's own footprint -- same clear-space BVH search as setup_camera(),
    just scoped to this room's bounding box instead of the whole
    building's, so walkthrough mode gets one sensible camera per room
    rather than one camera for the whole floor plan."""
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new(cam_name)
    cam_data.type = 'PANO'
    if hasattr(cam_data, 'cycles'):
        cam_data.cycles.panorama_type = 'EQUIRECTANGULAR'

    cam_obj = bpy.data.objects.new(cam_name, cam_data)
    scene.collection.objects.link(cam_obj)

    min_x, min_y = room["min"][0], room["min"][1]
    max_x, max_y = room["max"][0], room["max"][1]
    center_x, center_y = room["center"][0], room["center"][1]

    # Clearance is still checked against the FULL scene BVH (structure +
    # furniture), so a room's camera avoids clipping into that room's own
    # furniture just as much as its walls -- only the search *bounds* are
    # scoped to this one room.
    bvh = _build_scene_bvh(scene)
    cam_x, cam_y, clearance = _find_clear_camera_xy(
        bvh, center_x, center_y, min_x, max_x, min_y, max_y, EYE_HEIGHT_M,
    )

    if clearance < CAMERA_CLEARANCE_M:
        warnings.append(f"Room '{room['name']}': best camera spot only has {clearance:.2f}m "
                         f"clearance (< {CAMERA_CLEARANCE_M}m target); room may be very small/cluttered.")

    cam_obj.location = (cam_x, cam_y, EYE_HEIGHT_M)
    cam_obj.rotation_euler = (np.radians(90.0), 0.0, 0.0)
    scene.camera = cam_obj
    return cam_obj


def setup_camera_side(scene_for_bounds):
    """Orthographic elevation ('side view') camera: stands off to one side
    of the building and looks straight across at its XZ cross-section --
    an architectural side/section-style view, complementing the existing
    top-down 'dollhouse' floor-plan view."""
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("SideCamera")
    cam_data.type = 'ORTHO'

    bbox = _world_space_bbox(scene_for_bounds.objects)
    if bbox is None:
        bmin, bmax = Vector((-5, -5, 0)), Vector((5, 5, 3))
    else:
        bmin, bmax = bbox

    center_x = (bmin.x + bmax.x) / 2.0
    center_z = (bmin.z + bmax.z) / 2.0
    width = max(bmax.x - bmin.x, 1e-3) + 2 * SIDE_CAMERA_MARGIN_M
    height = max(bmax.z - bmin.z, 1e-3) + 2 * SIDE_CAMERA_MARGIN_M
    depth = max(bmax.y - bmin.y, 1.0)
    distance_back = max(width, height) + depth  # comfortably clear of the building itself

    cam_data.ortho_scale = max(width, height)

    cam_obj = bpy.data.objects.new("SideCamera", cam_data)
    scene.collection.objects.link(cam_obj)
    # Standing off in -Y, looking toward +Y at the building's XZ elevation.
    # Same (90, 0, 0) "look horizontally" rotation convention as the
    # interior pano camera above; unlike that camera (equirectangular,
    # captures every direction), this one's facing direction really does
    # matter for framing -- if the elevation ends up facing the wrong
    # side, flip the sign on the Y offset below.
    cam_obj.location = (center_x, bmin.y - distance_back, center_z)
    cam_obj.rotation_euler = (np.radians(90.0), 0.0, 0.0)
    scene.camera = cam_obj

    log(f"[blender_render] Side camera at ({cam_obj.location.x:.2f}, {cam_obj.location.y:.2f}, "
        f"{cam_obj.location.z:.2f}), ortho_scale={cam_data.ortho_scale:.2f}")
    return cam_obj


def setup_camera_orbit_frame(scene_for_bounds, angle_deg, frame_index):
    """One frame of an 'auto_rotation' turntable: a wide-angle perspective
    camera orbiting the building at a fixed radius/height, aimed at the
    building's center via a Track-To constraint (so the aim direction
    updates correctly frame-to-frame without hand-deriving Euler angles
    for every orbit position)."""
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new(f"OrbitCamera_{frame_index:04d}")
    cam_data.type = 'PERSP'
    cam_data.lens = ORBIT_LENS_MM

    bbox = _world_space_bbox(scene_for_bounds.objects)
    if bbox is None:
        bmin, bmax = Vector((-5, -5, 0)), Vector((5, 5, 3))
    else:
        bmin, bmax = bbox

    center = (bmin + bmax) / 2.0
    footprint_radius = max(bmax.x - bmin.x, bmax.y - bmin.y) / 2.0
    orbit_radius = footprint_radius * 2.2 + 2.0  # comfortably outside the building footprint
    orbit_height = max(bmax.z - bmin.z, 1.0) * 1.3 + center.z

    rad = np.radians(angle_deg)
    cam_x = center.x + orbit_radius * np.cos(rad)
    cam_y = center.y + orbit_radius * np.sin(rad)

    cam_obj = bpy.data.objects.new(f"OrbitCamera_{frame_index:04d}", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.location = (cam_x, cam_y, orbit_height)

    target_empty = bpy.data.objects.new(f"OrbitTarget_{frame_index:04d}", None)
    target_empty.location = (center.x, center.y, center.z)
    scene.collection.objects.link(target_empty)
    constraint = cam_obj.constraints.new(type='TRACK_TO')
    constraint.target = target_empty
    constraint.track_axis = 'TRACK_NEGATIVE_Z'
    constraint.up_axis = 'UP_Y'

    scene.camera = cam_obj
    return cam_obj


def configure_color_management(scene, lighting="daylight"):
    """THE FIX for washed-out/pastel colors: Blender 4.0+ (including 5.1)
    defaults scene.view_settings.view_transform to 'AgX', a filmic-style
    tone curve that deliberately compresses and desaturates bright colors.
    That's what turned your saturated hex wall colors into pale pastels --
    AgX was never told not to touch them. 'Standard' maps Base Color
    values to final pixel color much closer to 1:1 (still gamma-corrected
    sRGB, not a literal passthrough, but nowhere near AgX's desaturation).

    SECOND-ORDER BUG this introduces, and why exposure is set here too:
    'Standard' has no highlight roll-off at all -- unlike AgX, which
    compresses (but doesn't clip) values above 1.0, 'Standard' just clips
    anything above 1.0 straight to pure white. setup_lighting()'s Nishita
    sky (strength up to 1.0) stacked with its Sun lamp (energy up to 3.0)
    is physically-based and produces linear radiance well above 1.0 on
    any upward-facing surface -- which is every wall/floor/furniture top
    in a top_down/dollhouse shot. Under 'Standard' that clips to white
    regardless of the material's Base Color, which is exactly the
    "every box is white, none of my hex colors show up" bug. A negative
    exposure value pulls the linear range down before the transform so
    surfaces land back under 1.0 instead of clipping, while keeping
    'Standard's accurate (non-desaturated) hue mapping. These starting
    values are tuned for the current sun/sky energies in setup_lighting();
    if you change those energies you'll likely need to retune this too."""
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = {"daylight": -0.2, "overcast": 0.0, "night": 0.5}.get(lighting, 0.0)
    scene.view_settings.gamma = 1.0
    log(f"[blender_render] Color management: view_transform=Standard, exposure="
        f"{scene.view_settings.exposure} for lighting='{lighting}' (was defaulting to AgX, "
        "which desaturated colors; and was exposure=0.0, which clipped bright surfaces to "
        "pure white instead of showing their material color).")


def configure_engine(scene, engine_arg, angle):
    """
    Forces CYCLES for all renders to guarantee materials compile headlessly.
    Also avoids the 'BLENDER_EEVEE_NEXT' crash in Blender 5.1.2's Python API.
    """
    engine = "CYCLES"
    scene.render.engine = engine
    log(f"[blender_render] Render engine forced to: {engine} to guarantee colors.")
    return engine

def configure_render_device(scene):
    """Engine-aware render-quality configuration. Cycles gets the existing
    GPU auto-detect (OptiX/CUDA/HIP/Metal, CPU fallback) plus sample count/
    denoising. Eevee Next gets its own equivalent quality knobs -- the
    scene.cycles.* settings this function used to set unconditionally do
    nothing under Eevee, which is why they silently had no effect on every
    render that was actually running in Eevee Next."""
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = CYCLES_SAMPLES
        scene.cycles.use_denoising = True

        gpu_enabled = False
        addon = bpy.context.preferences.addons.get("cycles")

        if addon is not None:
            cprefs = addon.preferences
            for backend in ("OPTIX", "CUDA", "HIP", "METAL"):
                try:
                    cprefs.compute_device_type = backend
                except TypeError:
                    # This Blender build doesn't support this backend at all.
                    continue
                cprefs.get_devices()
                backend_devices = [d for d in cprefs.devices if d.type == backend]
                if not backend_devices:
                    continue
                for device in cprefs.devices:
                    device.use = (device.type == backend)
                gpu_enabled = True
                log(f"[blender_render] GPU rendering enabled via {backend}: "
                    f"{[d.name for d in backend_devices]}")
                break
        else:
            log("[blender_render] Cycles addon preferences not found; cannot query GPU devices.")

        scene.cycles.device = "GPU" if gpu_enabled else "CPU"
        if not gpu_enabled:
            log("[blender_render] No usable GPU backend/device found; rendering on CPU.")

    else:  # BLENDER_EEVEE_NEXT
        try:
            scene.eevee.taa_render_samples = EEVEE_SAMPLES
        except AttributeError:
            pass
        # Eevee Next's screen-space raytracing needs to be explicitly
        # enabled for reflections/refractions to look correct; without it,
        # glossy/metallic materials fall back to flat-looking probes.
        try:
            scene.eevee.use_raytracing = True
        except AttributeError:
            pass
        log(f"[blender_render] Eevee Next configured: samples={EEVEE_SAMPLES}, raytracing enabled.")

    cpu_count = os.cpu_count() or 4
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = cpu_count
    log(f"[blender_render] render.threads_mode=FIXED, render.threads={cpu_count}")


def setup_lighting(mode="daylight"):
    """
    Real sun+sky environment lighting instead of a point light glued to the
    camera. The old "flashlight on the camera" approach falls apart badly
    for a top-down dollhouse shot (a light co-located with the camera and
    pointed straight down over an entire building produces one hot circular
    spotlight in the middle of the floor plan, not even illumination), and
    it's *part* of why the interior render looked blown-out at close range
    -- a point light sitting right at the lens will always overexpose
    whatever surface the camera ends up close to.

    Uses Blender's built-in Nishita sky texture (procedural -- no external
    .hdr file path to resolve or ship), which lights the whole open floor
    plan evenly from above since this IFC has no roof/ceiling slab.
    """
    scene = bpy.context.scene

    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    bg = nodes.get("Background")

    if mode == "night":
        # No sky texture: soft, dim, cool-toned ambient fill instead of
        # simulating a full night sky (moonlight/stars) from scratch.
        if bg is not None:
            bg.inputs["Color"].default_value = (0.05, 0.06, 0.1, 1.0)
            bg.inputs["Strength"].default_value = 0.4
        sun_energy, sun_angle_deg = 0.5, 20.0
    else:
        sky = nodes.new("ShaderNodeTexSky")
        sky.sky_type = 'MULTIPLE_SCATTERING'
        sky.sun_elevation = np.radians(55.0 if mode == "daylight" else 25.0)
        sky.sun_rotation = np.radians(35.0)
        sky.air_density = 1.0
        # sky.dust_density = 1.0 if mode == "daylight" else 2.5  # hazier for 'overcast'
        if bg is not None:
            links.new(sky.outputs["Color"], bg.inputs["Color"])
            # Tame the sky ambient light
            bg.inputs["Strength"].default_value = 0.3 if mode == "daylight" else 0.1
        # Drastically lower the sun lamp so it doesn't blow out the floor
        sun_energy, sun_angle_deg = (0.6, 55.0) if mode == "daylight" else (0.2, 25.0)

    scene.world = world

    # A matching Sun lamp gives real directional shadows/shading on walls
    # and furniture -- the sky texture alone is a soft ambient dome and
    # reads flat without it, especially in the top-down view.
    sun_data = bpy.data.lights.new(name="KeySun", type="SUN")
    sun_data.energy = sun_energy
    sun_data.angle = np.radians(3.0)  # soft-ish shadow penumbra
    sun_obj = bpy.data.objects.new(name="KeySun", object_data=sun_data)
    scene.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (np.radians(sun_angle_deg), 0.0, np.radians(35.0))

    log(f"[blender_render] Lighting mode '{mode}': sky+sun environment set up "
        f"(sun energy={sun_energy}).")

def main():
    args = parse_args()
    warnings = []

    try:
        job_dir = os.path.abspath(args.job_dir)
        project_root = os.path.abspath(os.path.join(job_dir, os.pardir, os.pardir))

        # --- 1. Clear the default scene (default cube/camera/light included). ---
        bpy.ops.wm.read_factory_settings(use_empty=True)

        structure_collection = bpy.data.collections.new("Structure")
        bpy.context.scene.collection.children.link(structure_collection)
        furniture_collection = bpy.data.collections.new("Furniture")
        bpy.context.scene.collection.children.link(furniture_collection)

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

        # --- 2. Load structure: raw ifcopenshell extraction, not BlenderBIM/glb. ---
        log("[blender_render] Reading structural IFC geometry...")
        elements = load_ifc_elements(args.ifc, warnings)
        if not elements:
            raise ValueError("No renderable structural geometry found in input.ifc")

        structural_edits_applied = 0
        for el in elements:
            edit_def = structural_edits.get(el["global_id"])
            if edit_def:
                el["verts"] = apply_structural_edit(el["verts"], edit_def, warnings, el["global_id"])
                structural_edits_applied += 1

        # --- 3. Coordinate alignment: Stop shifting the house so the furniture coordinates match! ---
        all_verts = np.concatenate([el["verts"] for el in elements], axis=0)
        bbox_min = all_verts.min(axis=0)
        bbox_max = all_verts.max(axis=0)
        center = (bbox_min + bbox_max) / 2.0
        log(f"[blender_render] Structural bbox center: {center.tolist()}; keeping original coordinates.")

        materials_applied = 0
        for idx, el in enumerate(elements):
            # NO LONGER SHIFTING TO ORIGIN
            name = _sanitize_name(f"struct_{idx:04d}_{el['global_id']}", f"struct_{idx:04d}")
            obj = make_object_from_verts_faces(name, el["verts"], el["faces"], structure_collection)

            # --- 4. Materials: explicit override wins, else native IFC color. ---
            mat_def = resolve_material_def(el["global_id"], el.get("native_color"), materials)
            if mat_def:
                warnings_before = len(warnings)
                mat = make_principled_material(f"mat_{el['global_id']}", mat_def, warnings, el["global_id"])
                obj.data.materials.clear()
                obj.data.materials.append(mat)
                if len(warnings) == warnings_before:
                    materials_applied += 1

        log(f"[blender_render] {len(elements)} structural element(s), "
            f"{materials_applied} material override(s), "
            f"{structural_edits_applied} structural edit(s) applied.")

        # --- 5. Furniture: download/resolve, import, position/rotate/scale. ---
        furniture_merged_count = 0
        for i, item in enumerate(furniture):
            try:
                if import_furniture_item(
                    item, i, job_dir, project_root, args.asset_base_url,
                    materials, warnings, furniture_collection,
                ):
                    furniture_merged_count += 1
            except Exception as e:
                warnings.append(f"Furniture item #{i} failed to load and was skipped: {e}")
                log(f"[blender_render] furniture item #{i} failed: {e}")

        log(f"[blender_render] {furniture_merged_count}/{len(furniture)} furniture item(s) merged.")

        # --- 6. Normalize --angle/--lighting, resolve aliases. ---
        angle = (args.angle or "360").strip().lower()
        lighting = (args.lighting or "daylight").strip().lower()

        angle_aliases = {
            "aerial": "top_down", "dollhouse": "top_down",
            "orbit": "auto_rotation", "turntable": "auto_rotation",
            "walk": "walkthrough", "tour": "walkthrough",
            "interior": "360",
        }
        angle = angle_aliases.get(angle, angle)

        valid_angles = {"360", "top_down", "side", "auto_rotation", "walkthrough"}
        if angle not in valid_angles:
            warnings.append(f"Unrecognized --angle '{args.angle}'; defaulting to '360' interior pano.")
            angle = "360"
        if lighting not in ("daylight", "overcast", "night"):
            warnings.append(f"Unrecognized --lighting '{args.lighting}'; defaulting to 'daylight'.")
            lighting = "daylight"

        scene = bpy.context.scene
        base_bbox = {
            "min": bbox_min.tolist(),
            "max": bbox_max.tolist(),
            "center": center.tolist(),
            "size": (bbox_max - bbox_min).tolist(),
        }
        base_result = {
            "success": True,
            "angle": angle,
            "lighting": lighting,
            "bbox": base_bbox,
            "furniture_count": furniture_merged_count,
            "materials_applied": materials_applied,
            "structural_edits_applied": structural_edits_applied,
        }

        output_path = os.path.abspath(args.output)
        output_dir = os.path.dirname(output_path)
        os.makedirs(output_dir, exist_ok=True)

        def render_to(path):
            """Renders the CURRENT scene.camera to `path` using whatever
            engine/resolution/color-management is already configured on
            `scene` at call time -- shared by every mode below so a single
            static image, an orbit frame, and a per-room pano all go
            through the exact same render call."""
            ext = os.path.splitext(path)[1].lower()
            scene.render.image_settings.file_format = "JPEG" if ext in (".jpg", ".jpeg") else "PNG"
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)

        # --- 7. Engine + color management, chosen once, centrally. ---
        configure_engine(scene, args.engine, angle)
        configure_color_management(scene, lighting)
        setup_lighting(lighting)
        # Cycles GPU/samples or Eevee Next samples/raytracing, matched to
        # whichever engine configure_engine() just picked.
        configure_render_device(scene)

        # --- 8. Camera + render, branching per --angle. ---
        if angle == "top_down":
            _, (footprint_w, footprint_d) = setup_camera_top_down(scene)
            long_edge = RESOLUTION[0]
            if footprint_w >= footprint_d:
                res_x, res_y = long_edge, max(64, round(long_edge * footprint_d / footprint_w))
            else:
                res_y, res_x = long_edge, max(64, round(long_edge * footprint_w / footprint_d))
            scene.render.resolution_x, scene.render.resolution_y = res_x, res_y
            scene.render.resolution_percentage = 100
            log(f"[blender_render] Rendering top-down {res_x}x{res_y} to {output_path}...")
            render_to(output_path)
            result = {**base_result, "output": output_path, "warnings": warnings}

        elif angle == "side":
            setup_camera_side(scene)
            scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
            scene.render.resolution_percentage = 100
            log(f"[blender_render] Rendering side elevation {RESOLUTION[0]}x{RESOLUTION[1]} to {output_path}...")
            render_to(output_path)
            result = {**base_result, "output": output_path, "warnings": warnings}

        elif angle == "auto_rotation":
            scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
            scene.render.resolution_percentage = 100
            frame_count = max(2, args.orbit_frames)
            frames = []
            for i in range(frame_count):
                angle_deg = (360.0 / frame_count) * i
                setup_camera_orbit_frame(scene, angle_deg, i)
                frame_path = os.path.join(output_dir, f"orbit_{i:04d}.png")
                log(f"[blender_render] Rendering orbit frame {i + 1}/{frame_count} "
                    f"({angle_deg:.0f}°) to {frame_path}...")
                render_to(frame_path)
                frames.append({"index": i, "angle_deg": angle_deg, "file": os.path.basename(frame_path)})
            result = {**base_result, "frames": frames, "warnings": warnings}

        elif angle == "walkthrough":
            rooms_raw = load_ifc_rooms(args.ifc, warnings)
            if not rooms_raw:
                warnings.append("No IfcSpace rooms detected for walkthrough mode; "
                                 "falling back to a single whole-building interior pano.")
                setup_camera(structure_collection)
                scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
                scene.render.resolution_percentage = 100
                render_to(output_path)
                result = {**base_result, "angle": "360", "output": output_path, "warnings": warnings}
            else:
                scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
                scene.render.resolution_percentage = 100
                rooms_out = []
                for idx, room in enumerate(rooms_raw):
                    safe_name = _sanitize_name(room["name"], f"Room_{idx}")
                    cam_name = f"RoomCam_{idx:02d}_{safe_name}"
                    setup_camera_in_room(room, cam_name, warnings)
                    pano_filename = f"room_{idx:02d}_{safe_name}.png"
                    pano_path = os.path.join(output_dir, pano_filename)
                    log(f"[blender_render] Rendering room {idx + 1}/{len(rooms_raw)} "
                        f"('{room['name']}') to {pano_path}...")
                    render_to(pano_path)
                    rooms_out.append({
                        "id": room["global_id"],
                        "name": room["name"],
                        "pano": pano_filename,
                        "position": room["center"].tolist(),
                    })
                result = {**base_result, "rooms": rooms_out, "warnings": warnings}

        else:  # "360"
            setup_camera(structure_collection)
            scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
            scene.render.resolution_percentage = 100
            log(f"[blender_render] Rendering interior pano {RESOLUTION[0]}x{RESOLUTION[1]} to {output_path}...")
            render_to(output_path)
            result = {**base_result, "output": output_path, "warnings": warnings}

        print("RENDER_RESULT_JSON:" + json.dumps(result))
        sys.exit(0)

    except Exception as e:
        log(traceback.format_exc())
        print("RENDER_RESULT_JSON:" + json.dumps({"success": False, "error": str(e), "warnings": warnings}))
        sys.exit(1)


if __name__ == "__main__":
    main()