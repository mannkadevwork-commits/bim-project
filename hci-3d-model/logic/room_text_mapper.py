# logic/room_text_mapper.py

def analyse_image(img, room_cnts=None):
    """
    Mock implementation of OCR text mapping.
    """
    return {
        "mappings": [],
        "assigned": [],
        "summary": "OCR analysis skipped (using mock logic)",
        "pre_label_img": img.copy(),
        "post_label_img": img.copy(),
        "regions": [],
        "was_corrected": False
    }

def draw_text_mapping_overlay(img, mappings):
    return img.copy()