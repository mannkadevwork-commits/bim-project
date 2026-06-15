# logic/auto_label.py
import cv2
import numpy as np
from config.classes import CLASS_IDS

def contour_to_yolo_seg(cnt, w, h, cid):
    """Converts an OpenCV contour to YOLOv8 segmentation format (normalized 0-1)."""
    pts = cnt.reshape(-1, 2)
    if len(pts) < 3: 
        return None
        
    norm_pts = []
    for x, y in pts:
        # Normalize and clamp between 0.0 and 1.0
        nx = max(0.0, min(1.0, x / w))
        ny = max(0.0, min(1.0, y / h))
        norm_pts.append(f"{nx:.6f} {ny:.6f}")
        
    coords = " ".join(norm_pts)
    return f"{cid} {coords}"

def generate_labels(img_path, detector):
    """Runs the heuristic detector and parses results into YOLO label lines."""
    img = cv2.imread(str(img_path))
    if img is None:
        return [], None, {}
        
    heur_results = detector.detect(img)
    
    # Map internal detector keys to proper Class names
    mapping = {
        "rooms": "Room",
        "doors": "Door",
        "windows": "Window",
        "furniture": "Furniture",
        "stairs": "Stair",
        "flow_terminals": "FlowTerminal",
        "walls": "Wall"
    }
    
    labelled = {}
    for k, v in heur_results.items():
        if k in mapping and v:
            labelled[mapping[k]] = v
            
    h, w = img.shape[:2]
    label_lines = []
    
    # Generate YOLO string for each detected shape
    for cls_name, cnts in labelled.items():
        cid = CLASS_IDS.get(cls_name)
        if cid is None: continue
        for cnt in cnts:
            line = contour_to_yolo_seg(cnt, w, h, cid)
            if line:
                label_lines.append(line)
                
    return label_lines, img, labelled

def draw_labelled_image(img, labelled, out_path):
    """Draws colored polygons on the image for human review in the web UI."""
    # Pre-defined OpenCV colors corresponding roughly to your frontend UI
    colors = [
        (0,0,200), (255,0,255), (0,165,255), (0,200,0), (100,100,100),
        (80,80,80), (255,165,0), (139,69,19), (100,100,255), (180,180,180),
        (200,150,150), (200,200,0), (210,180,140), (255,255,165),
        (165,165,255), (165,255,165), (255,200,100)
    ]
    vis = img.copy()
    for cls_name, cnts in labelled.items():
        cid = CLASS_IDS.get(cls_name, 0)
        color = colors[cid % len(colors)]
        cv2.drawContours(vis, cnts, -1, color, 2)
        
    cv2.imwrite(str(out_path), vis)