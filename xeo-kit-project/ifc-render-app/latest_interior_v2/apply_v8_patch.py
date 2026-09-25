from __future__ import annotations

import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET_NAME = "automated_bim_v4_connected.py"


def find_target() -> Path:
    # Prefer the normal project-relative location when this script is copied
    # into latest_interior_v2. Otherwise search upward from the script folder.
    candidates = [
        ROOT / TARGET_NAME,
        ROOT.parent / TARGET_NAME,
        ROOT.parent / "latest_interior_v2" / TARGET_NAME,
    ]
    for p in candidates:
        if p.exists():
            return p
    raise FileNotFoundError(
        f"Could not find {TARGET_NAME}. Copy apply_v8_patch.py and the two modules "
        "into latest_interior_v2, then run it there."
    )


def insert_once(text: str, needle: str, insertion: str) -> tuple[str, bool]:
    if insertion.strip() in text:
        return text, False
    idx = text.find(needle)
    if idx < 0:
        raise RuntimeError(f"Patch anchor not found: {needle!r}")
    return text[:idx] + insertion + text[idx:], True


def main() -> None:
    target = find_target()
    backup = target.with_suffix(target.suffix + ".v7_backup")
    if not backup.exists():
        shutil.copy2(target, backup)
        print(f"[V8] Backup: {backup}")

    text = target.read_text(encoding="utf-8")
    changed = []

    import_block = (
        "\n# HCI V8 extraction recovery + spatial solving\n"
        "try:\n"
        "    from extraction_recovery import recover_missing_details\n"
        "    from spatial_solver import solve_interior_placements, resolve_opening_position\n"
        "except ImportError:\n"
        "    # Allow legacy/direct execution when these optional modules are not present.\n"
        "    recover_missing_details = None\n"
        "    solve_interior_placements = None\n"
        "    resolve_opening_position = None\n"
        "\n"
    )
    text, did = insert_once(text, "from typing import List, Optional\n", import_block)
    if did:
        changed.append("imports")

    # Add optional coordinate metadata only if the user's current model has not
    # already adopted it. These fields are ignored by old cached JSON.
    if "center_image_uv:" not in text:
        anchor = '    location_pt: List[float]\n'
        repl = (
            anchor
            + '    center_image_uv: Optional[List[float]] = Field(default=None, description="Exact normalized center [u,v] from the full source image; use 6 decimal places when available.")\n'
            + '    room_hint: Optional[str] = Field(default=None, description="Room containing this component, e.g. Living, Dining, Master Bedroom")\n'
            + '    placement_anchor: Optional[str] = Field(default=None, description="CENTER, WALL, CORNER, EDGE, or FREE")\n'
            + '    anchor_wall_id: Optional[str] = Field(default=None, description="Wall ID used as placement anchor when applicable")\n'
            + '    anchor_offset: Optional[float] = Field(default=None, description="Normalized offset along anchor wall 0..1")\n'
        )
        if anchor in text:
            text = text.replace(anchor, repl, 1)
            changed.append("interior coordinate metadata")

    # Precision instruction: only patch if the current file contains the known
    # primary prompt anchor. Keep this as a valid adjacent Python string literal.
    precision_line = (
        '        "COORDINATE PRECISION RULE: Use the FULL uploaded image as the coordinate frame. '
        'For every wall endpoint and every door/window/furniture center, return normalized coordinates with at least 4 decimal places (6 preferred). '
        'Never round image coordinates to 2 decimals. Do not use a second crop-specific coordinate system.\\n"\n'
    )
    prompt_anchor = '        "Analyze the floor plan and extract detailed architectural data.\\n"\n'
    if "COORDINATE PRECISION RULE" not in text and prompt_anchor in text:
        text = text.replace(prompt_anchor, precision_line + prompt_anchor, 1)
        changed.append("coordinate precision prompt")

    # Recovery before the function returns the primary extraction.
    return_anchor = "        return data\n    except (APIError, ServerError, ClientError) as e:\n"
    recovery_block = (
        "        # V8: compact second-pass recovery for missing furniture/openings.\n"
        "        # Reuses the same local upload; does not require another user upload.\n"
        "        if recover_missing_details is not None:\n"
        "            try:\n"
        "                data = recover_missing_details(data, image_path)\n"
        "            except Exception as recovery_exc:\n"
        "                print(f\"[Recovery-WARN] Detail recovery skipped: {recovery_exc}\")\n"
        "        return data\n    except (APIError, ServerError, ClientError) as e:\n"
    )
    if recovery_block not in text:
        if return_anchor not in text:
            raise RuntimeError("Could not locate analyze_floor_plan_detailed return anchor.")
        text = text.replace(return_anchor, recovery_block, 1)
        changed.append("recovery call")

    # Prepare deterministic placement maps once, after all walls have been
    # created and wall_map is populated.
    opening_anchor = "    # --- 2. OPENINGS ---\n    for op in data.openings:\n"
    opening_replacement = (
        "    # V8: openings use host-wall anchors when geometrically plausible.\n"
        "    opening_positions = {}\n"
        "    if resolve_opening_position is not None:\n"
        "        opening_positions = {\n"
        "            op.id: resolve_opening_position(op, wall_map)\n"
        "            for op in data.openings\n"
        "        }\n"
        "        if debug:\n"
        "            print(f\"[Spatial] resolved opening positions={len(opening_positions)}\")\n\n"
        "    # --- 2. OPENINGS ---\n    for op in data.openings:\n"
    )
    if "opening_positions = {}" not in text:
        if opening_anchor not in text:
            raise RuntimeError("Could not locate opening loop anchor.")
        text = text.replace(opening_anchor, opening_replacement, 1)
        changed.append("opening solver")

    op_pt_old = "        op_pt = _normalize_point(op.location_pt, op_unit)\n"
    op_pt_new = (
        "        raw_op_pt = opening_positions.get(op.id, op.location_pt)\n"
        "        op_pt = _normalize_point(raw_op_pt, op_unit)\n"
    )
    if op_pt_old in text and op_pt_new not in text:
        text = text.replace(op_pt_old, op_pt_new, 1)
        changed.append("opening coordinates")

    interior_anchor = "    # --- 3. INTERIOR ---\n    for item in data.interiors:\n"
    interior_replacement = (
        "    # V8: conservative room-containment solver. It does not apply a global offset.\n"
        "    interior_positions = {}\n"
        "    if solve_interior_placements is not None:\n"
        "        interior_positions = solve_interior_placements(data.interiors, data.walls)\n"
        "        if debug:\n"
        "            print(f\"[Spatial] solved interior positions={len(interior_positions)}\")\n\n"
        "    # --- 3. INTERIOR ---\n    for item in data.interiors:\n"
    )
    if "interior_positions = {}" not in text:
        if interior_anchor not in text:
            raise RuntimeError("Could not locate interior loop anchor.")
        text = text.replace(interior_anchor, interior_replacement, 1)
        changed.append("interior solver")

    item_pt_old = "        item_pt = _normalize_point(item.location_pt, item_unit)\n"
    item_pt_new = (
        "        raw_item_pt = interior_positions.get(item.id, item.location_pt)\n"
        "        item_pt = _normalize_point(raw_item_pt, item_unit)\n"
    )
    if item_pt_old in text and item_pt_new not in text:
        text = text.replace(item_pt_old, item_pt_new, 1)
        changed.append("interior coordinates")

    target.write_text(text, encoding="utf-8")
    print(f"[V8] Patched {target}")
    print("[V8] Changes: " + (", ".join(changed) if changed else "already applied"))
    print(f"[V8] Backup retained at: {backup}")


if __name__ == "__main__":
    main()
