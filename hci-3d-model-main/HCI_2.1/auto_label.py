# auto_label.py
import logging
import os

import cv2

from logic.yolo_inference import (
    ModelNotFoundError,
    contour_to_yolo_seg,
    draw_detection_overlay,
    resolve_hci21_model,
    run_yolo_inference,
)

logger = logging.getLogger(__name__)


def generate_labels(img_path, detector=None, dataset_dir=None):
    """
    Run YOLO inference and return (label_lines, img, labelled) for _autolabel_worker.

    Pipeline:
      1. YOLO inference (HCI21_MODEL_PATH / resolver)
      2. If zero YOLO detections → CV heuristic fallback (FloorPlanDetector)
         - CV thresholds loaded from cv_feedback (adapted over time)
      3. Cloud agent merge via analyse_floor_plan (always runs if enabled)
      4. Feedback recorded to dataset_dir/metadata/_cv_feedback.json

    dataset_dir: path to gdrive_dataset/ — required for feedback persistence.
    Never writes best_gdrive.pt.
    """
    img = cv2.imread(img_path, cv2.IMREAD_COLOR)  # always BGR, strips alpha
    if img is None:
        # Fallback: try via PIL to handle RGBA/unusual formats
        try:
            from PIL import Image as _PILImage
            import numpy as _np
            pil = _PILImage.open(img_path).convert("RGB")
            img = cv2.cvtColor(_np.array(pil), cv2.COLOR_RGB2BGR)
        except Exception:
            pass
    if img is None:
        labelled = {"_skip_reason": "image unreadable"}
        logger.error("generate_labels: cannot read %s", img_path)
        return [], None, labelled

    model_path, model_src = resolve_hci21_model()
    if not model_path:
        raise ModelNotFoundError(
            "No HCI_2.1 YOLO weights found. "
            "Set HCI21_MODEL_PATH env var to the absolute path of your best.pt file."
        )

    try:
        labelled, label_lines, used = run_yolo_inference(img, model_path=model_path)
    except ModelNotFoundError:
        raise
    except Exception as exc:
        logger.exception("generate_labels inference failed for %s", img_path)
        labelled = {"_skip_reason": f"inference error: {exc}"}
        return [], img, labelled

    if not label_lines:
        logger.warning(
            "generate_labels: zero YOLO detections for %s using %s (%s) — trying CV heuristic",
            img_path, used, model_src,
        )
        try:
            from logic.detector import FloorPlanDetector
            from logic.cv_feedback import get_cv_thresholds
            from config.classes import CLASS_IDS

            # Load feedback-adapted thresholds
            thresholds = get_cv_thresholds(dataset_dir) if dataset_dir else {}

            _det = detector or FloorPlanDetector(
                debug_mode=False, output_dir=".",
                remove_captions=True, detection_mode="heuristic_only",
                thresholds=thresholds,
            )
            heur = _det.detect(img)
            img_h, img_w = img.shape[:2]
            key_map = {
                "rooms":               "Room",
                "doors":               "Door",
                "windows":             "Window",
                "walls":               "Wall",
                "columns":             "Column",
                "stairs":              "Stair",
                "furniture":           "Furniture",
                "flow_terminals":      "FlowTerminal",
                "slabs":               "Slab",
                "roofs":               "Roof",
                "beams":               "Beam",
                "railings":            "Railing",
                "curtain_walls":       "CurtainWall",
                "coverings":           "Covering",
                "light_fixtures":      "LightFixture",
                "electric_appliances": "ElectricAppliance",
                "energy_devices":      "EnergyConversionDevice",
            }
            for hkey, cls_name in key_map.items():
                cnts = heur.get(hkey, [])
                if not cnts:
                    continue
                cid = CLASS_IDS.get(cls_name)
                if cid is None:
                    continue
                labelled[cls_name] = cnts
                for cnt in cnts:
                    line = contour_to_yolo_seg(cnt, img_w, img_h, cid)
                    if line:
                        label_lines.append(line)

            if label_lines:
                labelled["_model_path"] = used
                labelled["_model_source"] = "cv_heuristic"
                logger.info(
                    "generate_labels: CV heuristic produced %d polygons for %s",
                    len(label_lines), img_path,
                )
            else:
                labelled["_skip_reason"] = (
                    f"zero detections (model={os.path.basename(used)}, source={model_src})"
                )
        except Exception as he:
            logger.exception("generate_labels: CV heuristic failed for %s: %s", img_path, he)
            labelled["_skip_reason"] = (
                f"zero detections (model={os.path.basename(used)}, source={model_src})"
            )
    else:
        logger.info(
            "generate_labels: %s polygons from %s using %s (%s)",
            len(label_lines), img_path, used, model_src,
        )
        labelled["_model_path"] = used
        labelled["_model_source"] = model_src

    return label_lines, img, labelled


def draw_labelled_image(img, labelled, marked_path):
    """Save coloured polygon overlay preview."""
    if img is None:
        return
    vis = draw_detection_overlay(img, labelled)
    cv2.imwrite(marked_path, vis)
