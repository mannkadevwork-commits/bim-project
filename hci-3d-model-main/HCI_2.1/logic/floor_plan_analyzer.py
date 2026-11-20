# logic/floor_plan_analyzer.py
# Merge orchestrator: CV heuristic + cloud agent → unified labelled dict.
#
# Merge strategy:
#   - Geometry (contours) comes from CV — it has pixel-accurate shapes
#   - Counts / semantics come from cloud agent — it understands what things are
#   - When agent finds MORE of a class than CV, agent contours are appended
#   - When agent finds FEWER, CV contours are trimmed to agent count
#   - Room names from agent are stored in _room_names for OCR/metadata
#   - After merge, feedback is recorded to adapt CV thresholds over time

import logging
import os

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Dataset dir is injected at call time; feedback is optional
_dataset_dir = None


def _iou_contours(a: np.ndarray, b: np.ndarray) -> float:
    """Approximate IoU via bounding-rect overlap."""
    ax, ay, aw, ah = cv2.boundingRect(a)
    bx, by, bw, bh = cv2.boundingRect(b)
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _dedupe_contours(contours: list, iou_thresh: float = 0.4) -> list:
    """Remove near-duplicate contours by bounding-rect IoU."""
    kept = []
    for cnt in sorted(contours, key=cv2.contourArea, reverse=True):
        if not any(_iou_contours(cnt, k) > iou_thresh for k in kept):
            kept.append(cnt)
    return kept


def _merge_class(cv_cnts: list, agent_cnts: list, key: str) -> list:
    """
    Merge CV and agent contours for one class.

    Strategy:
    - Start with CV contours (pixel-accurate geometry)
    - Add agent contours that don't overlap existing ones (fills gaps)
    - Deduplicate
    """
    combined = list(cv_cnts) + list(agent_cnts)
    merged = _dedupe_contours(combined, iou_thresh=0.35)
    logger.debug("merge %s: cv=%d agent=%d → merged=%d", key, len(cv_cnts), len(agent_cnts), len(merged))
    return merged


def analyse_floor_plan(img, labelled_or_heur, dataset_dir=None):
    """
    Merge CV detections with cloud agent analysis.

    labelled_or_heur: dict from FloorPlanDetector.detect() or existing labelled dict
    dataset_dir: path to gdrive_dataset/ for feedback persistence (optional)

    Returns enhanced dict with same keys + _room_names, _ocr_seeds, _analyzer_used,
    _agent_data, _merge_stats.
    """
    enhanced = dict(labelled_or_heur) if labelled_or_heur else {}
    enhanced.setdefault("_room_names", {})
    enhanced.setdefault("_ocr_seeds", [])
    enhanced["_analyzer_used"] = False
    enhanced["_agent_data"] = {}
    enhanced["_merge_stats"] = {}

    if img is None:
        return enhanced

    h, w = img.shape[:2]

    # ── Run cloud agent ───────────────────────────────────────────────────────
    agent_raw = {}
    try:
        from logic.cloud_agent import analyse_with_cloud_agent, agent_detections_to_contours
        agent_raw = analyse_with_cloud_agent(img)
    except Exception as exc:
        logger.warning("analyse_floor_plan: cloud agent error (%s)", exc)

    had_agent = bool(agent_raw)
    enhanced["_agent_data"] = agent_raw

    agent_cnts = {}
    if had_agent:
        try:
            from logic.cloud_agent import agent_detections_to_contours
            agent_cnts = agent_detections_to_contours(agent_raw, h, w)
        except Exception as exc:
            logger.warning("analyse_floor_plan: agent contour conversion failed (%s)", exc)
            had_agent = False

    # ── CV counts (before merge) ──────────────────────────────────────────────
    cv_counts = {
        "rooms":   len(enhanced.get("Room",   enhanced.get("rooms",   []))),
        "doors":   len(enhanced.get("Door",   enhanced.get("doors",   []))),
        "windows": len(enhanced.get("Window", enhanced.get("windows", []))),
        "walls":   len(enhanced.get("Wall",   enhanced.get("walls",   []))),
    }

    agent_counts = {
        "rooms":   len(agent_cnts.get("rooms",   [])),
        "doors":   len(agent_cnts.get("doors",   [])),
        "windows": len(agent_cnts.get("windows", [])),
        "walls":   len(agent_cnts.get("walls",   [])),
    }

    # ── Merge each class ──────────────────────────────────────────────────────
    # Map: (labelled dict key, heuristic dict key, agent key)
    class_map = [
        ("Room",    "rooms",   "rooms"),
        ("Door",    "doors",   "doors"),
        ("Window",  "windows", "windows"),
        ("Wall",    "walls",   "walls"),
    ]

    merge_stats = {}
    for lbl_key, heur_key, agent_key in class_map:
        cv_cnts = enhanced.get(lbl_key, enhanced.get(heur_key, []))
        ag_cnts = agent_cnts.get(agent_key, []) if had_agent else []
        merged  = _merge_class(cv_cnts, ag_cnts, lbl_key)
        enhanced[lbl_key] = merged
        merge_stats[lbl_key] = {
            "cv": len(cv_cnts), "agent": len(ag_cnts), "merged": len(merged)
        }

    enhanced["_merge_stats"] = merge_stats
    enhanced["_analyzer_used"] = had_agent

    # ── Extract room names from agent ─────────────────────────────────────────
    room_names = {}
    for i, r in enumerate(agent_raw.get("rooms", [])):
        name = r.get("name", "")
        if name:
            room_names[i] = name
    enhanced["_room_names"] = room_names

    # ── Summary from agent ────────────────────────────────────────────────────
    summary = agent_raw.get("summary", {})
    if summary:
        enhanced["_ocr_seeds"] = [
            {"text": summary.get("bhk", ""), "type": "bhk"},
            {"text": summary.get("floor_plan_type", ""), "type": "type"},
        ]

    # ── Record feedback ───────────────────────────────────────────────────────
    if dataset_dir:
        try:
            from logic.cv_feedback import record_merge_result
            merged_counts = {
                "rooms":   len(enhanced.get("Room",   [])),
                "doors":   len(enhanced.get("Door",   [])),
                "windows": len(enhanced.get("Window", [])),
                "walls":   len(enhanced.get("Wall",   [])),
            }
            record_merge_result(
                dataset_dir,
                cv_counts=cv_counts,
                agent_counts=agent_counts,
                merged_counts=merged_counts,
                had_agent=had_agent,
            )
        except Exception as exc:
            logger.warning("analyse_floor_plan: feedback record failed (%s)", exc)

    logger.info(
        "analyse_floor_plan: agent=%s merge_stats=%s",
        had_agent,
        {k: v["merged"] for k, v in merge_stats.items()},
    )

    return enhanced


def draw_analysis_overlay(img, analysis_data):
    return img


def extract_text_seeds(img):
    return []
