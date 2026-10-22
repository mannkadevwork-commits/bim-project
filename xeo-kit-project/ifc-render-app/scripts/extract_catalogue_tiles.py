#!/usr/bin/env python3
"""Deterministic catalogue swatch extractor. No AI/OCR services are used."""
import json
import os
import sys
from collections import Counter

import fitz
import cv2
import numpy as np
from PIL import Image


def rect_iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def detect_rectangles(rgb):
    h, w = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(gray, 35, 110)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    page_area = w * h
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            continue
        approx = cv2.approxPolyDP(contour, 0.018 * perimeter, True)
        if len(approx) < 4 or len(approx) > 8 or not cv2.isContourConvex(approx):
            continue
        x, y, rw, rh = cv2.boundingRect(approx)
        area = rw * rh
        ratio = rw / max(1, rh)
        if rw < 48 or rh < 48 or area < page_area * 0.0018 or area > page_area * 0.22:
            continue
        if ratio < 0.36 or ratio > 2.7:
            continue
        rect = (int(x), int(y), int(rw), int(rh))
        if any(rect_iou(rect, old) > 0.93 for old in found):
            continue
        found.append(rect)
    return found


def similar_size(a, b, tolerance=0.17):
    return abs(a[2] - b[2]) / max(a[2], b[2]) <= tolerance and abs(a[3] - b[3]) / max(a[3], b[3]) <= tolerance


def repeated_groups(rects):
    groups = []
    for rect in sorted(rects, key=lambda r: r[2] * r[3], reverse=True):
        match = next((g for g in groups if similar_size(rect, g[0])), None)
        if match is None:
            groups.append([rect])
        else:
            match.append(rect)
    return [g for g in groups if len(g) >= 3]


def is_sample_child(outer, child):
    x, y, w, h = outer
    cx, cy, cw, ch = child
    wr, hr = cw / max(1, w), ch / max(1, h)
    dx, dy = (cx - x) / max(1, w), (cy - y) / max(1, h)
    return 0.70 <= wr <= 0.97 and 0.48 <= hr <= 0.88 and -0.02 <= dx <= 0.10 and 0.12 <= dy <= 0.48


def child_sample(outer, rects):
    possible = [child for child in rects if child != outer and is_sample_child(outer, child)]
    return max(possible, key=lambda r: r[2] * r[3]) if possible else None


def choose_candidates(rects):
    groups = repeated_groups(rects)
    if not groups:
        return []
    # Prefer a repeated group that represents cards/samples rather than a single large photo.
    groups.sort(key=lambda g: (len(g), -abs((g[0][2] / max(1, g[0][3])) - 1.0)), reverse=True)
    base_group = groups[0]
    selected = []
    for outer in base_group:
        child = child_sample(outer, rects)
        selected.append(child or outer)
    # If the chosen group consists of outer cards, nested inner swatches are preferable when they repeat.
    child_count = sum(1 for r in selected if r not in base_group)
    if child_count >= max(3, int(len(base_group) * 0.6)):
        base_group = selected
    else:
        base_group = [r for r in base_group]
    # Remove overlapping/nested duplicates, preserving the more specific crop.
    result = []
    for rect in sorted(base_group, key=lambda r: r[2] * r[3]):
        if any(rect_iou(rect, prior) > 0.75 for prior in result):
            continue
        result.append(rect)
    return sorted(result, key=lambda r: (r[1], r[0]))


def crop_sample(rgb, rect, rects):
    x, y, w, h = rect
    # A selected inner rectangle is already the actual swatch area. Detect that
    # case so we do not trim the swatch a second time.
    is_inner_sample = any(parent != rect and is_sample_child(parent, rect) for parent in rects)
    nested = child_sample(rect, rects)
    if nested:
        x, y, w, h = nested
        pad_x = max(2, int(w * 0.015))
        pad_y = max(2, int(h * 0.015))
        x, y = x + pad_x, y + pad_y
        w, h = w - 2 * pad_x, h - 2 * pad_y
    elif is_inner_sample:
        pad_x = max(2, int(w * 0.015))
        pad_y = max(2, int(h * 0.015))
        x, y = x + pad_x, y + pad_y
        w, h = w - 2 * pad_x, h - 2 * pad_y
    else:
        ratio = w / max(1, h)
        if ratio < 0.9:
            # Merino-style vertical cards: sample is above the product code/name band.
            x += int(w * 0.055)
            y += int(h * 0.035)
            w = int(w * 0.89)
            h = int(h * 0.69)
        elif ratio <= 1.2:
            # Asian Paints-style cards: heading above a landscape swatch.
            x += int(w * 0.045)
            y += int(h * 0.25)
            w = int(w * 0.91)
            h = int(h * 0.68)
        else:
            x += int(w * 0.035)
            y += int(h * 0.035)
            w = int(w * 0.93)
            h = int(h * 0.72)
    H, W = rgb.shape[:2]
    x, y = max(0, x), max(0, y)
    w, h = min(W - x, max(1, w)), min(H - y, max(1, h))
    return rgb[y:y + h, x:x + w].copy()


def representative_hex(rgb):
    # Use the central 70% to avoid border/label contamination.
    h, w = rgb.shape[:2]
    x0, x1 = int(w * 0.15), max(int(w * 0.85), int(w * 0.15) + 1)
    y0, y1 = int(h * 0.15), max(int(h * 0.85), int(h * 0.15) + 1)
    core = rgb[y0:y1, x0:x1].reshape(-1, 3)
    med = np.median(core, axis=0).astype(int)
    return '#%02X%02X%02X' % tuple(int(v) for v in med)



def suggested_label(page, rect, rects, scale):
    # Read selectable PDF text near the card's label band. Raster-only catalogues
    # safely fall back to a page/sample name; no OCR or external service is used.
    label_rect = rect
    label_zone = 'bottom'
    for parent in rects:
        if parent == rect:
            continue
        if is_sample_child(parent, rect):
            # Asian Paints-style cards place their heading above the swatch.
            label_rect, label_zone = parent, 'top'
            break
        px, py, pw, ph = parent
        x, y, w, h = rect
        contained = px <= x + 3 and py <= y + 5 and px + pw >= x + w - 3 and py + ph >= y + h - 3
        wr, hr = w / max(1, pw), h / max(1, ph)
        dx, dy = (x - px) / max(1, pw), (y - py) / max(1, ph)
        if contained and 0.65 <= wr <= 0.96 and 0.48 <= hr <= 0.76 and -0.02 <= dx <= 0.10 and -0.02 <= dy <= 0.10:
            # Merino-style cards put the shade code/name below the color tile.
            label_rect, label_zone = parent, 'bottom'
            break
    x, y, w, h = label_rect
    x0, y0, x1, y1 = x / scale, y / scale, (x + w) / scale, (y + h) / scale
    card_height = h / scale
    words = page.get_text('words')
    inside = []
    for word in words:
        wx0, wy0, wx1, wy1, text = word[:5]
        center_x, center_y = (wx0 + wx1) / 2, (wy0 + wy1) / 2
        if label_zone == 'top':
            in_y = y0 <= center_y <= y0 + card_height * 0.28
        else:
            in_y = y0 + card_height * 0.43 <= center_y <= y1 + 4
        if x0 - 3 <= center_x <= x1 + 3 and in_y:
            cleaned = str(text).strip()
            if cleaned and cleaned not in {'|', 'P1', 'P2', 'P3'}:
                inside.append(word)
    if not inside:
        return ''
    lines = {}
    for word in sorted(inside, key=lambda item: (item[5], item[6], item[7])):
        key = (word[5], word[6])
        lines.setdefault(key, []).append(str(word[4]))
    output = []
    for line_words in lines.values():
        line = ' '.join(line_words).strip()
        if not line or len(line) < 3:
            continue
        if any(token in line.lower() for token in ['please refer to index', 'matching edge bands', 'premium']):
            continue
        output.append(line)
    return ' · '.join(output[:2])[:100]

def main():
    if len(sys.argv) != 3:
        print('Usage: extract_catalogue_tiles.py input.pdf output_directory', file=sys.stderr)
        return 2
    pdf_path, output_dir = sys.argv[1], sys.argv[2]
    os.makedirs(output_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    if len(doc) > 100:
        print(json.dumps({'error': 'PDFs with more than 100 pages are not supported in one scan.'}))
        return 0
    candidates = []
    page_candidates = []
    scale = 1.25
    for page_index in range(len(doc)):
        # The first pages of the supplied catalogue formats are covers/intros.
        # Skip them to avoid treating decorative cover artwork as product swatches.
        if page_index < 3:
            continue
        page = doc[page_index]
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
        rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
        rects = detect_rectangles(rgb)
        chosen = choose_candidates(rects)
        if len(chosen) < 4:
            continue
        current_page = []
        for rect in chosen:
            crop = crop_sample(rgb, rect, rects)
            if crop.size == 0 or crop.shape[0] < 24 or crop.shape[1] < 24:
                continue
            # Downscale for fast review; source crops are intended for preview/application, not print reproduction.
            pil = Image.fromarray(crop)
            pil.thumbnail((900, 900), Image.Resampling.LANCZOS)
            filename = f'tmp_{page_index + 1:03d}_{len(current_page) + 1:03d}.webp'
            pil.save(os.path.join(output_dir, filename), 'WEBP', quality=91, method=5)
            current_page.append({
                'filename': filename,
                'source_page': page_index + 1,
                'suggested_name': suggested_label(page, rect, rects, scale) or f'Page {page_index + 1} - Sample {len(current_page) + 1}',
                'color_hex': representative_hex(crop),
                'width': int(crop.shape[1]),
                'height': int(crop.shape[0]),
            })
        if len(current_page) >= 4:
            page_candidates.append(current_page)
    doc.close()
    # Keep the strongest repeated-swatch pages first when a catalogue is very large.
    ranked_pages = sorted(page_candidates, key=lambda group: len(group), reverse=True)
    selected = []
    for group in ranked_pages:
        if len(selected) + len(group) > 600 and selected:
            continue
        selected.extend(group)
        if len(selected) >= 600:
            break
    selected.sort(key=lambda item: (item['source_page'], item['filename']))
    selected_files = {item['filename'] for item in selected}
    for name in os.listdir(output_dir):
        if name not in selected_files:
            try: os.remove(os.path.join(output_dir, name))
            except OSError: pass
    candidates = []
    for index, item in enumerate(selected):
        old_name = item['filename']
        new_name = f'crop_{index:04d}.webp'
        if old_name != new_name:
            os.replace(os.path.join(output_dir, old_name), os.path.join(output_dir, new_name))
        item['index'] = index
        item['filename'] = new_name
        candidates.append(item)
    print(json.dumps({'pages_scanned': page_count, 'candidate_count': len(candidates), 'candidates': candidates}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
