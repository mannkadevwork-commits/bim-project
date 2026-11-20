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

        # ── COLUMN detection (small, near-square, solid blobs) ────────────────
        columns = []
        min_col = max(10.0, self._th("column_min_area_ratio", 0.00005) * h * w)
        max_col = max(200.0, self._th("column_max_area_ratio", 0.002) * h * w)
        for cnt in wall_cnts:
            area = cv2.contourArea(cnt)
            if area < min_col or area > max_col:
                continue
            rect = cv2.minAreaRect(cnt)
            (_, _), (rw, rh), _ = rect
            long_side  = max(float(rw), float(rh))
            short_side = min(float(rw), float(rh))
            aspect = long_side / max(short_side, 1.0)
            # Columns are near-square (aspect < 2.0) and solid
            if aspect < 2.0:
                hull = cv2.convexHull(cnt)
                hull_area = float(cv2.contourArea(hull))
                if hull_area > 0 and area / hull_area > 0.75:
                    columns.append(cnt)
        columns = sorted(columns, key=cv2.contourArea, reverse=True)[:20]

        # ── STAIR detection (medium rectangular regions with internal lines) ──
        stairs = []
        min_stair = max(200.0, self._th("stair_min_area_ratio", 0.001) * h * w)
        max_stair = max(2000.0, self._th("stair_max_area_ratio", 0.05) * h * w)
        for cnt in room_cnts:
            area = cv2.contourArea(cnt)
            if area < min_stair or area > max_stair:
                continue
            rect = cv2.minAreaRect(cnt)
            (_, _), (rw, rh), _ = rect
            long_side  = max(float(rw), float(rh))
            short_side = min(float(rw), float(rh))
            aspect = long_side / max(short_side, 1.0)
            # Stairs tend to be rectangular (aspect 1.5–5)
            if 1.5 <= aspect <= 5.0:
                stairs.append(cnt)
        stairs = sorted(stairs, key=cv2.contourArea, reverse=True)[:10]

        # ── FURNITURE detection (medium blobs, not elongated) ─────────────────
        furniture = []
        min_furn = max(100.0, self._th("furniture_min_area_ratio", 0.0003) * h * w)
        max_furn = max(1000.0, self._th("furniture_max_area_ratio", 0.02) * h * w)
        for cnt in small_cnts:
            area = cv2.contourArea(cnt)
            if area < min_furn or area > max_furn:
                continue
            rect = cv2.minAreaRect(cnt)
            (_, _), (rw, rh), _ = rect
            long_side  = max(float(rw), float(rh))
            short_side = min(float(rw), float(rh))
            aspect = long_side / max(short_side, 1.0)
            # Furniture: compact blobs (aspect < 3)
            if aspect < 3.0:
                hull = cv2.convexHull(cnt)
                hull_area = float(cv2.contourArea(hull))
                if hull_area > 0 and area / hull_area > 0.55:
                    furniture.append(cnt)
        furniture = sorted(furniture, key=cv2.contourArea, reverse=True)[:30]

        # ── FLOW TERMINAL detection (very small, near-square sanitary fixtures)
        flow_terminals = []
        min_ft = max(20.0, self._th("ft_min_area_ratio", 0.00005) * h * w)
        max_ft = max(300.0, self._th("ft_max_area_ratio", 0.003) * h * w)
        for cnt in small_cnts:
            area = cv2.contourArea(cnt)
            if area < min_ft or area > max_ft:
                continue
            rect = cv2.minAreaRect(cnt)
            (_, _), (rw, rh), _ = rect
            long_side  = max(float(rw), float(rh))
            short_side = min(float(rw), float(rh))
            aspect = long_side / max(short_side, 1.0)
            # Sanitary fixtures: compact (aspect < 2.5)
            if aspect < 2.5:
                flow_terminals.append(cnt)
        flow_terminals = sorted(flow_terminals, key=cv2.contourArea, reverse=True)[:20]

        return {
            "rooms":          rooms,
            "doors":          doors,
            "windows":        windows,
            "walls":          walls,
            "columns":        columns,
            "stairs":         stairs,
            "furniture":      furniture,
            "flow_terminals": flow_terminals,
            # These require semantic context — CV cannot reliably detect them
            # but we return empty lists so the key_map in auto_label.py is consistent
            "slabs":          [],
            "roofs":          [],
            "beams":          [],
            "railings":       [],
            "curtain_walls":  [],
            "coverings":      [],
            "light_fixtures": [],
            "electric_appliances": [],
            "energy_devices": [],
        }
