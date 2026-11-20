# logic/cv_feedback.py
# Feedback store: persists merge accuracy stats and adapts CV detector
# thresholds based on historical cloud-agent vs CV agreement.
#
# Storage: dataset_dir/metadata/_cv_feedback.json
# Updated after every successful CV+agent merge.
# Read by detector.py to tune thresholds at runtime.

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_FEEDBACK_FILE = "_cv_feedback.json"

# Default thresholds — same as original detector.py hardcoded values
_DEFAULTS = {
    "wall_min_aspect":       2.5,
    "wall_min_area_ratio":   0.00003,
    "wall_min_len_ratio":    0.01,
    "room_min_area_ratio":   0.005,
    "door_aspect_min":       1.5,
    "door_aspect_max":       5.0,
    "opening_min_area_ratio": 0.00001,
    "opening_max_area_ratio": 0.005,
    # Stats counters
    "_images_processed":     0,
    "_cv_only_count":        0,
    "_agent_only_count":     0,
    "_merged_count":         0,
    "_agent_room_delta_sum": 0.0,   # sum of (agent_rooms - cv_rooms)
    "_agent_door_delta_sum": 0.0,
    "_agent_win_delta_sum":  0.0,
}


def _feedback_path(dataset_dir) -> Path:
    return Path(dataset_dir) / "metadata" / _FEEDBACK_FILE


def load_feedback(dataset_dir) -> dict:
    path = _feedback_path(dataset_dir)
    if path.exists():
        try:
            with open(path) as f:
                data = json.load(f)
            # Fill missing keys with defaults
            for k, v in _DEFAULTS.items():
                data.setdefault(k, v)
            return data
        except Exception as exc:
            logger.warning("cv_feedback: load failed (%s), using defaults", exc)
    return dict(_DEFAULTS)


def save_feedback(dataset_dir, data: dict) -> None:
    path = _feedback_path(dataset_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as exc:
        logger.warning("cv_feedback: save failed (%s)", exc)


def record_merge_result(
    dataset_dir,
    *,
    cv_counts: dict,
    agent_counts: dict,
    merged_counts: dict,
    had_agent: bool,
) -> dict:
    """
    Update feedback stats after one image merge.
    Adapts thresholds if CV is consistently over/under-detecting vs agent.

    cv_counts / agent_counts / merged_counts: {rooms, doors, windows, walls}
    Returns updated feedback dict.
    """
    fb = load_feedback(dataset_dir)
    fb["_images_processed"] += 1

    if not had_agent:
        fb["_cv_only_count"] += 1
        save_feedback(dataset_dir, fb)
        return fb

    fb["_merged_count"] += 1

    # Accumulate deltas (agent - cv) for rooms, doors, windows
    for key, delta_key in [
        ("rooms",   "_agent_room_delta_sum"),
        ("doors",   "_agent_door_delta_sum"),
        ("windows", "_agent_win_delta_sum"),
    ]:
        cv_n    = cv_counts.get(key, 0)
        agent_n = agent_counts.get(key, 0)
        fb[delta_key] = fb.get(delta_key, 0.0) + (agent_n - cv_n)

    n = fb["_merged_count"]

    # Adapt thresholds every 5 merged images
    if n >= 5 and n % 5 == 0:
        avg_room_delta = fb["_agent_room_delta_sum"] / n
        avg_door_delta = fb["_agent_door_delta_sum"] / n
        avg_win_delta  = fb["_agent_win_delta_sum"]  / n

        # If agent consistently finds MORE rooms than CV → CV threshold too strict → loosen
        # If agent consistently finds FEWER rooms → CV too loose → tighten
        if avg_room_delta > 1.0:
            # CV missing rooms — lower min area ratio (detect smaller rooms)
            fb["room_min_area_ratio"] = max(0.001, fb["room_min_area_ratio"] * 0.85)
            logger.info("cv_feedback: loosening room_min_area_ratio → %.5f", fb["room_min_area_ratio"])
        elif avg_room_delta < -1.0:
            fb["room_min_area_ratio"] = min(0.02, fb["room_min_area_ratio"] * 1.15)
            logger.info("cv_feedback: tightening room_min_area_ratio → %.5f", fb["room_min_area_ratio"])

        if avg_door_delta > 1.0:
            fb["opening_max_area_ratio"] = min(0.02, fb["opening_max_area_ratio"] * 1.15)
            logger.info("cv_feedback: loosening opening_max_area_ratio → %.5f", fb["opening_max_area_ratio"])
        elif avg_door_delta < -1.0:
            fb["opening_max_area_ratio"] = max(0.001, fb["opening_max_area_ratio"] * 0.85)
            logger.info("cv_feedback: tightening opening_max_area_ratio → %.5f", fb["opening_max_area_ratio"])

        if avg_win_delta > 1.0:
            fb["opening_min_area_ratio"] = max(0.000005, fb["opening_min_area_ratio"] * 0.85)
            logger.info("cv_feedback: loosening opening_min_area_ratio → %.5f", fb["opening_min_area_ratio"])
        elif avg_win_delta < -1.0:
            fb["opening_min_area_ratio"] = min(0.0001, fb["opening_min_area_ratio"] * 1.15)
            logger.info("cv_feedback: tightening opening_min_area_ratio → %.5f", fb["opening_min_area_ratio"])

    save_feedback(dataset_dir, fb)
    return fb


def get_cv_thresholds(dataset_dir) -> dict:
    """Return current adapted CV thresholds for detector.py."""
    fb = load_feedback(dataset_dir)
    return {k: fb[k] for k in _DEFAULTS if not k.startswith("_")}
