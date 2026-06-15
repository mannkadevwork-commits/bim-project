# web/auto_label.py

import cv2
import numpy as np
from config.classes import CLASS_IDS

# Same color mapping used in the frontend and server fallback
COLORS = {
    0: (0, 0, 200),     # Wall
    1: (255, 0, 255),   # Window
    2: (0, 165, 255),   # Door
    3: (0, 200, 0),     # Room
    4: (100, 100, 100), # Slab
    5: (80, 80, 80),    # Roof
    6: (255, 165, 0),   # Column
    7: (139, 69, 19),   # Beam
    8: (100, 100, 255), # Stair
    9: (180, 180, 180), # Railing
    10: (200, 150, 150),# CurtainWall
    11: (200, 200, 0),  # Furniture
    12: (210, 180, 140),# Covering
    13: (255, 255, 165),# LightFixture
    14: (165, 165, 255),# ElectricAppliance
    15: (165, 255, 165),# FlowTerminal
    16: (255, 200, 100) # EnergyConversionDevice
}

def contour_to_yolo_seg(contour, img_w, img_h, class_id):
    """
    Converts an OpenCV contour into a YOLO segmentation format string.
    Format: <class_index> <x1> <y1> <x2> <y2> ... (normalized 0-1)
    """
    if contour is None or len(contour) < 3:
        return ""
    
    coords = []
    for point in contour:
        # contour points are usually formatted as [[x, y]]
        x, y = point[0]
        # Normalize coordinates by image dimensions
        norm_x = min(max(x / img_w, 0.0), 1.0)
        norm_y = min(max(y / img_h, 0.0), 1.0)
        coords.append(f"{norm_x:.6f} {norm_y:.6f}")
        
    return f"{class_id} " + " ".join(coords)

def generate_labels(img_path, detector):
    """
    Reads an image, runs the heuristic detector, and generates YOLO labels.
    
    Returns:
        label_lines: List of YOLO formatted string lines
        img: Loaded OpenCV image array
        labelled: Dictionary mapping Class Names to lists of contours
    """
    img = cv2.imread(str(img_path))
    if img is None:
        raise ValueError(f"Could not read image: {img_path}")

    img_h, img_w = img.shape[:2]

    # Run the heuristic detector
    # detector returns something like: {"rooms": [...], "doors": [...], ...}
    raw_detections = detector.detect(img)

    # Map the internal detector keys to standard CLASS_IDS names
    cls_map = {
        "rooms": "Room",
        "doors": "Door",
        "windows": "Window",
        "furniture": "Furniture",
        "stairs": "Stair",
        "flow_terminals": "FlowTerminal"
    }

    labelled = {}
    for res_key, cls_name in cls_map.items():
        if res_key in raw_detections and raw_detections[res_key]:
            labelled[cls_name] = raw_detections[res_key]

    # Generate the YOLO label lines
    label_lines = []
    for cls_name, contours in labelled.items():
        # Ignore intermediate keys like '_room_names' or '_ocr_seeds'
        if cls_name not in CLASS_IDS or cls_name.startswith("_"):
            continue
            
        cid = CLASS_IDS[cls_name]
        for cnt in contours:
            line = contour_to_yolo_seg(cnt, img_w, img_h, cid)
            if line:
                label_lines.append(line)

    return label_lines, img, labelled

def draw_labelled_image(img, labelled, out_path):
    """
    Draws the detected contours onto the image and saves it to disk.
    Used for the "Labelled Images" preview in the UI.
    """
    vis = img.copy()
    overlay = img.copy()

    for cls_name, contours in labelled.items():
        if cls_name.startswith("_"):
            continue
            
        cid = CLASS_IDS.get(cls_name, 3) # default to Room(3) if unknown
        color = COLORS.get(cid, (128, 128, 128))
        
        # Draw outlines
        cv2.drawContours(vis, contours, -1, color, 2)
        # Draw translucent fill
        cv2.drawContours(overlay, contours, -1, color, -1)

    # Blend the overlay to make fills semi-transparent
    vis = cv2.addWeighted(overlay, 0.25, vis, 0.75, 0)
    
    # Save the output image
    cv2.imwrite(str(out_path), vis)