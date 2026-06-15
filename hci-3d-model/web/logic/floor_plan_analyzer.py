# logic/floor_plan_analyzer.py

def analyse_floor_plan(img, heur):
    """Enriches the base detector results with additional metadata."""
    enhanced = dict(heur)
    
    # Placeholders for advanced downstream AI enrichment
    enhanced["_room_names"] = {}
    enhanced["_ocr_seeds"] = []
    enhanced["_analyzer_used"] = True 
    
    return enhanced

def draw_analysis_overlay(img, enhanced):
    """Fallback visualizer if needed."""
    return img.copy()

def extract_text_seeds(img):
    """Hooks for text extraction before full OCR."""
    return []