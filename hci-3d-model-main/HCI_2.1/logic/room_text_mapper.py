# logic/room_text_mapper.py
# OCR-based room text detection and mapping to room contours.
#
# pre_label_img  — raw image with all detected text boxes drawn (green)
# post_label_img — same image with text assigned to rooms (colour-coded by class)

import logging
import re

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ── Text → HCI class keyword mapping (mirrors all dropdown options) ───────────
# Key = HCI CLASS_IDS name, value = list of substrings to match (lowercase)
_CLASS_KEYWORDS = {
    # ── Spaces (IfcSpace) — all Room subtypes ─────────────────────────────────
    "Room": [
        "living room", "dining room", "drawing room", "master bedroom", "bedroom",
        "kitchen room", "bathroom", "toilet / wc", "entry / foyer",
        "utility / wash", "store room", "study / home office", "puja room",
        "parking / garage", "servant room",
        "room", "living", "drawing", "bath", "washroom", "lavatory",
        "kitchen",
        "balcony", "terrace", "verandah", "veranda", "patio", "deck",
        "entry", "foyer", "entrance", "lobby", "corridor", "hallway",
        "passage", "landing", "utility", "laundry", "storage",
        "study", "office", "puja", "prayer", "servant", "maid",
        "gym", "parking", "garage", "carport", "family", "lounge", "hall",
    ],
    # ── Structure (IfcWall/Slab) ──────────────────────────────────────────────
    "Wall": [
        "wall", "exterior wall", "interior wall", "partition", "partition wall",
    ],
    "Slab": [
        "slab", "floor slab", "ceiling slab", "concrete slab",
    ],
    "Roof": [
        "roof", "rooftop", "roof slab",
    ],
    "Column": [
        "column", "col", "pillar", "post", "structural column",
    ],
    "Beam": [
        "beam", "lintel", "structural beam",
    ],
    "Railing": [
        "railing", "rail", "handrail", "balustrade", "guard rail",
    ],
    "CurtainWall": [
        "curtain wall", "curtainwall", "glazing", "glass wall", "glass facade",
    ],
    "Covering": [
        "covering", "flooring", "ceiling", "cladding", "finish",
    ],
    # ── Openings ──────────────────────────────────────────────────────────────
    "Door": [
        "door", "single swing", "double swing", "sliding door", "folding door",
        "entrance door", "exit door",
    ],
    "Window": [
        "window", "sliding window", "casement", "fixed window", "glazed opening",
    ],
    # ── Vertical ──────────────────────────────────────────────────────────────
    "Stair": [
        "stair", "stairs", "staircase", "stairwell", "steps", "l-shaped stair",
        "spiral stair", "straight stair",
    ],
    # ── Furniture (IfcFurnishingElement) ──────────────────────────────────────
    "Furniture": [
        "furniture", "sofa", "couch", "bed", "wardrobe", "almirah",
        "dining table", "tv unit", "table", "chair", "cabinet", "desk",
        "cupboard", "shelf", "bookcase",
    ],
    # ── MEP / Sanitary ────────────────────────────────────────────────────────
    "FlowTerminal": [
        "wc", "toilet", "water closet", "wash basin", "basin", "sink",
        "kitchen sink", "shower", "bathtub", "tub", "urinal", "sanitary",
        "plumbing", "tap", "faucet",
    ],
    "LightFixture": [
        "light", "lamp", "ceiling light", "recessed light", "downlight",
        "light fixture", "chandelier", "tube light",
    ],
    "ElectricAppliance": [
        "ac", "air conditioner", "refrigerator", "fridge", "stove", "hob",
        "oven", "microwave", "washing machine", "dryer", "appliance",
        "electric appliance",
    ],
    "EnergyConversionDevice": [
        "hvac", "boiler", "heat pump", "chiller", "ahu", "energy device",
        "mechanical", "plant",
    ],
}

# Colours per HCI class (BGR) — matches HCI_COLORS palette in yolo_inference.py
_CLASS_COLORS = {
    "Room":                  (0,   200,   0),    # green
    "Wall":                  (0,   200,   0),    # green
    "Slab":                  (100, 100, 100),    # grey
    "Roof":                  ( 80,  80,  80),    # dark grey
    "Column":                (255, 165,   0),    # orange
    "Beam":                  (139,  69,  19),    # brown
    "Railing":               (180, 180, 180),    # light grey
    "CurtainWall":           (200, 150, 150),    # rose
    "Covering":              (210, 180, 140),    # tan
    "Door":                  (0,  165, 255),     # orange-blue
    "Window":                (255,   0, 255),    # magenta
    "Stair":                 (100, 100, 255),    # blue
    "Furniture":             (200, 200,   0),    # yellow
    "FlowTerminal":          (165, 255, 165),    # light green
    "LightFixture":          (255, 255, 165),    # light yellow
    "ElectricAppliance":     (165, 165, 255),    # light blue
    "EnergyConversionDevice":(255, 200, 100),    # peach
    "unknown":               (200,  50,  50),    # red
}


def _classify_text(text: str) -> str:
    """Return HCI class name for a text string, or 'unknown'.
    Classes are checked in specificity order so longer/more-specific
    keywords win over shorter ones that are substrings of them.
    """
    clean = text.lower().strip()
    # Pre-pass: check Room compound phrases first so they are never stolen
    # by shorter keywords in Furniture (bed) or FlowTerminal (toilet/wc)
    _ROOM_COMPOUNDS = [
        "master bedroom", "bedroom", "living room", "dining room", "drawing room",
        "store room", "puja room", "servant room", "study / home office",
        "parking / garage", "utility / wash", "entry / foyer", "toilet / wc",
    ]
    for phrase in _ROOM_COMPOUNDS:
        if phrase in clean:
            return "Room"
    _PRIORITY_ORDER = [
        "CurtainWall", "EnergyConversionDevice", "LightFixture",
        "ElectricAppliance", "FlowTerminal", "Furniture",
        "Stair", "Door", "Window",
        "Slab", "Roof", "Column", "Beam", "Railing", "Covering",
        "Wall", "Room",
    ]
    for cls in _PRIORITY_ORDER:
        keywords = _CLASS_KEYWORDS.get(cls, [])
        for kw in sorted(keywords, key=len, reverse=True):
            if kw in clean:
                return cls
    return "unknown"


def _point_in_contour(cx: int, cy: int, cnt: np.ndarray) -> bool:
    return cv2.pointPolygonTest(cnt, (float(cx), float(cy)), False) >= 0


def analyse_image(img, cnts_by_class=None):
    """
    Run Tesseract OCR on img, classify detected text, map to any labelled contour.

    cnts_by_class: dict {cls_name: [contours]} for all detected classes, OR
                   a plain list of contours (legacy Room-only, still supported).

    Returns:
        mappings:       list of all detected text regions with class + position
        assigned:       subset that matched a known class keyword
        summary:        human-readable string
        pre_label_img:  img with all OCR text boxes drawn (green)
        post_label_img: img with text colour-coded by classified class
        regions:        raw Tesseract word data
    """
    if img is None:
        return _empty(img)
    # Normalise: accept both legacy flat list and new dict
    if isinstance(cnts_by_class, list):
        cnts_by_class = {"Room": cnts_by_class} if cnts_by_class else {}
    cnts_by_class = cnts_by_class or {}

    try:
        import pytesseract
    except ImportError:
        logger.warning("pytesseract not installed — OCR unavailable")
        return _empty(img, "pytesseract not installed")

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Mild sharpening helps floor plan text
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    sharp = cv2.filter2D(gray, -1, kernel)

    try:
        data = pytesseract.image_to_data(
            sharp,
            output_type=pytesseract.Output.DICT,
            config="--psm 11 --oem 3",
        )
    except Exception as exc:
        logger.warning("OCR failed: %s", exc)
        return _empty(img, f"OCR failed: {exc}")

    # ── Collect valid word regions ────────────────────────────────────────────
    regions = []
    for i in range(len(data["text"])):
        text = str(data["text"][i]).strip()
        conf = float(data["conf"][i])
        if not text or conf < 40:
            continue
        x, y, bw, bh = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        cx, cy = x + bw // 2, y + bh // 2
        # Skip very small noise
        if bw < 5 or bh < 5:
            continue
        clean = re.sub(r"[^a-zA-Z0-9 /\-]", "", text).strip()
        if not clean:
            continue
        regions.append({
            "text":       text,
            "clean_text": clean,
            "conf":       conf,
            "x": x, "y": y, "w": bw, "h": bh,
            "cx": cx, "cy": cy,
        })

    # ── Classify and map to any labelled contour ─────────────────────────────
    # Flatten all contours with their class name for spatial lookup
    all_cnts = []  # list of (cls_name, contour)
    for cls_name, cnts in cnts_by_class.items():
        for cnt in cnts:
            all_cnts.append((cls_name, cnt))

    mappings = []
    assigned = []

    for r in regions:
        cls = _classify_text(r["clean_text"])
        matched_cls = None
        cnt_idx = -1
        inside = False
        for j, (c_name, cnt) in enumerate(all_cnts):
            if _point_in_contour(r["cx"], r["cy"], cnt):
                matched_cls = c_name
                cnt_idx = j
                inside = True
                break
        # If text is inside a contour, prefer the contour's class over keyword class
        if inside and matched_cls:
            cls = matched_cls
        entry = {
            "text":      r["text"],
            "class":     cls,
            "cx":        r["cx"],
            "cy":        r["cy"],
            "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"],
            "conf":      r["conf"],
            "room_idx":  cnt_idx,
            "inside":    inside,
        }
        mappings.append(entry)
        if cls != "unknown":
            assigned.append(entry)

    # ── Draw pre-label: all OCR boxes in green ────────────────────────────────
    pre = img.copy()
    for r in regions:
        cv2.rectangle(pre, (r["x"], r["y"]),
                      (r["x"] + r["w"], r["y"] + r["h"]), (0, 200, 0), 1)
        cv2.putText(pre, r["clean_text"][:20],
                    (r["x"], max(r["y"] - 3, 10)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    max(0.3, min(w, h) / 2000.0),
                    (0, 200, 0), 1, cv2.LINE_AA)

    # ── Draw post-label: classified text colour-coded ─────────────────────────
    post = img.copy()
    for m in mappings:
        color = _CLASS_COLORS.get(m["class"], _CLASS_COLORS["unknown"])
        cv2.rectangle(post, (m["x"], m["y"]),
                      (m["x"] + m["w"], m["y"] + m["h"]), color, 2)
        label = f"{m['class']}: {m['text'][:15]}"
        cv2.putText(post, label,
                    (m["x"], max(m["y"] - 3, 10)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    max(0.3, min(w, h) / 2000.0),
                    color, 1, cv2.LINE_AA)
        # Draw line from text to contour centroid if mapped inside
        if m["inside"] and m["room_idx"] >= 0 and m["room_idx"] < len(all_cnts):
            _, cnt = all_cnts[m["room_idx"]]
            M = cv2.moments(cnt)
            if M["m00"] > 0:
                rcx = int(M["m10"] / M["m00"])
                rcy = int(M["m01"] / M["m00"])
                cv2.line(post, (m["cx"], m["cy"]), (rcx, rcy), color, 1, cv2.LINE_AA)

    n_words  = len(regions)
    n_mapped = len(assigned)
    summary  = f"OCR: {n_words} words detected, {n_mapped} classified across all classes"
    logger.info(summary)

    return {
        "mappings":       mappings,
        "assigned":       assigned,
        "summary":        summary,
        "pre_label_img":  pre,
        "post_label_img": post,
        "regions":        regions,
    }


def draw_text_mapping_overlay(img, mappings):
    if img is None:
        return img
    vis = img.copy()
    h, w = img.shape[:2]
    for m in mappings:
        color = _CLASS_COLORS.get(m.get("class", "unknown"), _CLASS_COLORS["unknown"])
        x, y, bw, bh = m.get("x", 0), m.get("y", 0), m.get("w", 20), m.get("h", 10)
        cv2.rectangle(vis, (x, y), (x + bw, y + bh), color, 2)
        cv2.putText(vis, m.get("text", "")[:20], (x, max(y - 3, 10)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    max(0.3, min(w, h) / 2000.0),
                    color, 1, cv2.LINE_AA)
    return vis


def _empty(img, reason="OCR unavailable"):
    """Return a result where pre shows a grey 'unavailable' banner and post is distinct."""
    if img is None:
        return {
            "mappings": [], "assigned": [], "summary": reason,
            "pre_label_img": None, "post_label_img": None, "regions": [],
        }
    h, w = img.shape[:2]
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = max(0.5, min(w, h) / 1500.0)
    thick = max(1, int(min(w, h) / 600))

    pre = img.copy()
    cv2.rectangle(pre, (0, 0), (w, 36), (40, 40, 40), -1)
    cv2.putText(pre, f"Pre-OCR: {reason}", (8, 26), font, scale, (0, 200, 0), thick, cv2.LINE_AA)

    post = img.copy()
    cv2.rectangle(post, (0, 0), (w, 36), (40, 40, 40), -1)
    cv2.putText(post, f"Post-OCR: {reason}", (8, 26), font, scale, (0, 165, 255), thick, cv2.LINE_AA)

    return {
        "mappings": [], "assigned": [], "summary": reason,
        "pre_label_img": pre, "post_label_img": post, "regions": [],
    }
