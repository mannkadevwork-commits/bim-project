# logic/detector.py
# CV-based floor plan heuristic detector.
# Used as fallback when YOLO model has no floor plan classes.
# Thresholds are adapted over time via logic/cv_feedback.py.

import cv2
import numpy as np


class FloorPlanDetector:
    def __init__(self, debug_mode=False, output_dir=".", remove_captions=True,
                 detection_mode="heuristic_only", thresholds: dict = None):
        self.debug_mode = debug_mode
        self.output_dir = output_dir
        self.remove_captions = remove_captions
        self.detection_mode = detection_mode
        # Thresholds injected from cv_feedback; fall back to hardcoded defaults
        self._t = thresholds or {}

    def _th(self, key, default):
        return self._t.get(key, default)

    def detect(self, img):
        if img is None:
            return {"rooms": [], "doors": [], "windows": [], "walls": [],
                    "furniture": [], "stairs": [], "flow_terminals": []}

        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

        # ── Binarise ──────────────────────────────────────────────────────────
        _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        kernel3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel3, iterations=1)

        # ── WALL detection ────────────────────────────────────────────────────
        walls = []
        wall_cnts, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        min_wall_area = max(50.0, self._th("wall_min_area_ratio", 0.00003) * h * w)
        min_wall_len  = max(20.0, self._th("wall_min_len_ratio",  0.01)    * min(h, w))
        min_aspect    = self._th("wall_min_aspect", 2.5)
        for cnt in wall_cnts:
            area = cv2.contourArea(cnt)
            if area < min_wall_area:
                continue
            rect = cv2.minAreaRect(cnt)
            (_, _), (rw, rh), _ = rect
            long_side  = max(float(rw), float(rh))
            short_side = min(float(rw), float(rh))
            if long_side < min_wall_len:
                continue
            if long_side / max(short_side, 1.0) < min_aspect:
                continue
            walls.append(cnt)

        # ── ROOM detection ────────────────────────────────────────────────────
        rooms = []
        kernel_big = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel_big, iterations=3)
        inv = cv2.bitwise_not(closed)
        room_cnts, _ = cv2.findContours(inv, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        min_room_area = max(500.0, self._th("room_min_area_ratio", 0.005) * h * w)
        img_area = h * w
        for cnt in room_cnts:
            area = cv2.contourArea(cnt)
            if area < min_room_area or area > 0.85 * img_area:
                continue
            rooms.append(cnt)

        # ── DOOR / WINDOW detection ───────────────────────────────────────────
        doors, windows = [], []
        small_cnts, _ = cv2.findContours(thresh, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        min_open = max(20.0,  self._th("opening_min_area_ratio", 0.00001) * h * w)
        max_open = max(500.0, self._th("opening_max_area_ratio", 0.005)   * h * w)
        door_asp_min = self._th("door_aspect_min", 1.5)
        door_asp_max = self._th("door_aspect_max", 5.0)
        for cnt in small_cnts:
            area = cv2.contourArea(cnt)
            if area < min_open or area > max_open:
                continue
            rect = cv2.minAreaRect(cnt)
            (_, _), (rw, rh), _ = rect
            long_side  = max(float(rw), float(rh))
            short_side = min(float(rw), float(rh))
            if long_side < 5:
                continue
            aspect = long_side / max(short_side, 1.0)
            if door_asp_min <= aspect <= door_asp_max:
                doors.append(cnt)
            elif aspect < door_asp_min:
                windows.append(cnt)

        doors   = sorted(doors,   key=cv2.contourArea, reverse=True)[:30]
        windows = sorted(windows, key=cv2.contourArea, reverse=True)[:20]
        rooms   = sorted(rooms,   key=cv2.contourArea, reverse=True)[:20]
        walls   = sorted(walls,   key=cv2.contourArea, reverse=True)[:60]

        return {
            "rooms":          rooms,
            "doors":          doors,
            "windows":        windows,
            "walls":          walls,
            "furniture":      [],
            "stairs":         [],
            "flow_terminals": [],
        }
