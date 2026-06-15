# logic/detector.py

class FloorPlanDetector:
    def __init__(self, debug_mode=False, output_dir=".", remove_captions=True, detection_mode="heuristic_only"):
        self.debug_mode = debug_mode
        self.output_dir = output_dir
        self.remove_captions = remove_captions
        self.detection_mode = detection_mode

    def detect(self, img):
        """
        Mock implementation. Normally this would process the OpenCV image 
        and return contours for rooms, doors, etc.
        """
        return {
            "rooms": [],
            "doors": [],
            "windows": [],
            "furniture": [],
            "stairs": [],
            "flow_terminals": []
        }