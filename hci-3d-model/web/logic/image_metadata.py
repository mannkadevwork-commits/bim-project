# logic/image_metadata.py
import json
import os
from pathlib import Path
from datetime import datetime

def get_metadata_path(img_path, ds_dir):
    """Returns the filepath for the JSON metadata corresponding to an image."""
    basename = Path(img_path).stem
    return Path(ds_dir) / "images_raw" / f"{basename}_meta.json"

def metadata_exists(img_path, ds_dir):
    return get_metadata_path(img_path, ds_dir).exists()

def load_metadata(img_path, ds_dir):
    p = get_metadata_path(img_path, ds_dir)
    if p.exists():
        try:
            with open(p, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_metadata(img_path, ds_dir, data):
    p = get_metadata_path(img_path, ds_dir)
    with open(p, "w") as f:
        json.dump(data, f, indent=2)
    return p

def build_metadata_from_ocr(img_path, img, ocr_seeds, room_names, label_lines, labelled, h, w):
    """Structures metadata after a local Auto-Label run."""
    return {
        "source": "local_cv",
        "_saved_at": datetime.now().isoformat(),
        "n_labels": len(label_lines),
        "rooms": ocr_seeds,
        "label_counts": {k: len(v) for k, v in labelled.items()}
    }

def build_metadata_from_gemini(img_path, gemini_data):
    """Structures metadata if Gemini is used for advanced OCR mapping."""
    return {
        "source": "gemini", 
        "_saved_at": datetime.now().isoformat(),
        "gemini_data": gemini_data
    }

def list_all_metadata(ds_dir):
    """Returns a summary of all labeled metadata in the dataset."""
    raw_dir = Path(ds_dir) / "images_raw"
    if not raw_dir.exists(): 
        return []
        
    meta_files = list(raw_dir.glob("*_meta.json"))
    res = []
    for m in meta_files:
        try:
            with open(m, 'r') as f:
                data = json.load(f)
                res.append({
                    "file": m.name, 
                    "source": data.get("source", "unknown"),
                    "n_labels": data.get("n_labels", 0)
                })
        except Exception:
            continue
    return res