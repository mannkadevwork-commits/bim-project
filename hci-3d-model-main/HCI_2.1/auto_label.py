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


def generate_labels(img_path, detector=None):
    """
    Run YOLO inference and return (label_lines, img, labelled) for _autolabel_worker.
    Falls back to FloorPlanDetector heuristic when YOLO finds zero detections.
    HCI_2.1 default: CubiCasa via resolve_hci21_model() / HCI21_MODEL_PATH.
    Never writes best_gdrive.pt.
    """
    img = cv2.imread(img_path)
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
            "generate_labels: zero YOLO detections for %s using %s (%s) — trying heuristic fallback",
            img_path, used, model_src,
        )
        try:
            from logic.detector import FloorPlanDetector
            from config.classes import CLASS_IDS
            _det = detector or FloorPlanDetector(
                debug_mode=False, output_dir=".",
                remove_captions=True, detection_mode="heuristic_only"
            )
            heur = _det.detect(img)
            img_h, img_w = img.shape[:2]
            # Map heuristic keys to HCI class names
            key_map = {
                "rooms": "Room", "doors": "Door", "windows": "Window",
                "walls": "Wall", "furniture": "Furniture",
                "stairs": "Stair", "flow_terminals": "FlowTerminal",
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
                labelled["_model_source"] = "heuristic_fallback"
                logger.info(
                    "generate_labels: heuristic produced %d polygons for %s",
                    len(label_lines), img_path,
                )
            else:
                labelled["_skip_reason"] = (
                    f"zero detections (model={os.path.basename(used)}, source={model_src})"
                )
        except Exception as he:
            logger.exception("generate_labels: heuristic fallback failed for %s: %s", img_path, he)
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
