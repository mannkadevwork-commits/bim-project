# logic/room_text_mapper.py
import cv2
import numpy as np

# Use Tesseract for OCR if installed, otherwise fail gracefully
try:
    import pytesseract
except ImportError:
    pytesseract = None

def analyse_image(img, room_cnts=[]):
    """Uses OCR to find text labels and associate them with detected rooms."""
    result = {
        "mappings": [],
        "assigned": [],
        "pre_label_img": img.copy(),
        "post_label_img": img.copy(),
        "summary": "",
        "regions": []
    }
    
    if pytesseract is None:
        result["summary"] = "OCR mapping disabled. (pip install pytesseract to enable)"
        return result
        
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Run Tesseract OCR to get bounding boxes and confidence scores
    d = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT)
    
    assigned = []
    n_boxes = len(d['text'])
    
    for i in range(n_boxes):
        if int(d['conf'][i]) > 40: # Filter out low-confidence reads
            text = d['text'][i].strip()
            if len(text) < 3: continue
            
            x, y, w, h = d['left'][i], d['top'][i], d['width'][i], d['height'][i]
            cx, cy = x + w//2, y + h//2
            
            # Point-in-polygon test: Which room contour does this text belong to?
            room_idx = -1
            inside = False
            for r_idx, r_cnt in enumerate(room_cnts):
                if cv2.pointPolygonTest(r_cnt, (cx, cy), False) >= 0:
                    room_idx = r_idx
                    inside = True
                    break
                    
            # Text Heuristics mapping to classes
            lower_text = text.lower()
            mapped_class = "Room" 
            if "bed" in lower_text or "liv" in lower_text or "kit" in lower_text: mapped_class = "Room"
            elif "bath" in lower_text or "toi" in lower_text: mapped_class = "Room"
            elif "door" in lower_text: mapped_class = "Door"
            elif "win" in lower_text: mapped_class = "Window"
            elif "up" in lower_text or "dn" in lower_text: mapped_class = "Stair"
            
            mapped_item = {
                "text": text,
                "class": mapped_class,
                "cx": cx, "cy": cy,
                "room_idx": room_idx,
                "inside": inside,
                "clean_text": text,
                "conf": d['conf'][i],
                "x": x, "y": y
            }
            assigned.append(mapped_item)
            result["regions"].append(mapped_item)
            
    result["assigned"] = assigned
    result["mappings"] = assigned
    result["summary"] = f"OCR Found {len(assigned)} readable text labels."
    
    # Plot dots on the post-label visualization image
    for m in assigned:
        cv2.circle(result["post_label_img"], (m["cx"], m["cy"]), 6, (0,255,0), -1)
        cv2.putText(result["post_label_img"], m["class"], (m["cx"], m["cy"]-10), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,255), 2)
        
    return result

def draw_text_mapping_overlay(img, mappings):
    vis = img.copy()
    for m in mappings:
        cv2.circle(vis, (m["cx"], m["cy"]), 4, (255,0,0), -1)
        cv2.putText(vis, m["text"], (m["cx"], m["cy"]-8), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255,0,0), 1)
    return vis