# logic/detector.py
import cv2
import numpy as np

class FloorPlanDetector:
    def __init__(self, debug_mode=False, output_dir=".", remove_captions=True, detection_mode="heuristic_only"):
        self.debug_mode = debug_mode
        self.output_dir = output_dir

    def detect(self, img):
        # 1. Grayscale & threshold to isolate walls/lines
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # Assuming floor plans are mostly white background with dark lines
        _, thresh = cv2.threshold(gray, 220, 255, cv2.THRESH_BINARY_INV)
        
        # 2. Morphological closing to seal gaps in room walls
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=3)
        
        # 3. Find contours
        cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        rooms, doors, windows, walls = [], [], [], []
        img_area = img.shape[0] * img.shape[1]
        
        for c in cnts:
            area = cv2.contourArea(c)
            # Ignore noise and the boundary of the image itself
            if area < 100 or area > 0.95 * img_area:
                continue
                
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.01 * peri, True)
            
            # Simple Area-Based Heuristics
            if area > img_area * 0.02:
                rooms.append(approx)      # Massive regions are likely rooms
            elif 1000 < area <= img_area * 0.02:
                windows.append(approx)    # Medium regions
            else:
                doors.append(approx)      # Small regions

        return {
            "rooms": rooms,
            "doors": doors,
            "windows": windows,
            "walls": walls,
            "furniture": [],
            "stairs": [],
            "flow_terminals": []
        }