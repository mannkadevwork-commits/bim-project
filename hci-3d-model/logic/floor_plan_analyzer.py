# logic/floor_plan_analyzer.py

def analyse_floor_plan(img, labelled_or_heur):
    """
    Mock implementation. Returns an enriched dictionary of contours and OCR seeds.
    """
    # Create a copy of the input dictionary to return
    enhanced = dict(labelled_or_heur) if labelled_or_heur else {}
    
    # Ensure all expected keys exist
    for key in ["rooms", "stairs", "flow_terminals", "furniture", "doors", "windows"]:
        if key not in enhanced:
            enhanced[key] = []
            
    # Add metadata keys expected by server.py
    enhanced["_room_names"] = {}
    enhanced["_ocr_seeds"] = []
    enhanced["_analyzer_used"] = False
    
    return enhanced

def draw_analysis_overlay(img, analysis_data):
    return img.copy()

def extract_text_seeds(img):
    return []