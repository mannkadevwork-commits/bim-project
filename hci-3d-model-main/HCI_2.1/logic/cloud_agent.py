# logic/cloud_agent.py
# AWS Bedrock Claude cloud agent for floor plan semantic analysis.
#
# Sends a base64-encoded floor plan image to Claude via Bedrock and returns
# structured JSON describing rooms, doors, windows, walls with approximate
# bounding positions (normalised 0-1).
#
# Env vars:
#   HCI21_BEDROCK_REGION   — AWS region (default: us-east-1)
#   HCI21_BEDROCK_MODEL    — Bedrock model ID (default: anthropic.claude-3-5-sonnet-20241022-v2:0)
#   HCI21_BEDROCK_ENABLED  — set to "0" to disable (default: enabled if boto3 present)
#
# Falls back silently if boto3 is missing, credentials are absent, or the
# call fails — CV-only path continues unaffected.

import base64
import json
import logging
import os

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_BEDROCK_REGION = os.environ.get("HCI21_BEDROCK_REGION", "us-east-1")
_BEDROCK_MODEL  = os.environ.get(
    "HCI21_BEDROCK_MODEL",
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
)

_PROMPT = """You are a floor plan analysis expert. Analyse this floor plan image and return ONLY a JSON object with this exact structure — no markdown, no explanation:

{
  "rooms": [
    {"name": "Living Room", "cx": 0.3, "cy": 0.4, "w": 0.25, "h": 0.20, "confidence": 0.9}
  ],
  "doors": [
    {"cx": 0.5, "cy": 0.3, "w": 0.04, "h": 0.08, "confidence": 0.85}
  ],
  "windows": [
    {"cx": 0.2, "cy": 0.1, "w": 0.06, "h": 0.03, "confidence": 0.8}
  ],
  "walls": [
    {"x1": 0.1, "y1": 0.1, "x2": 0.9, "y2": 0.1, "thickness": 0.01, "confidence": 0.95}
  ],
  "summary": {
    "total_rooms": 3,
    "total_doors": 4,
    "total_windows": 6,
    "total_walls": 12,
    "floor_plan_type": "residential",
    "bhk": "2BHK"
  }
}

Rules:
- All coordinates are normalised 0.0 to 1.0 relative to image width/height
- cx, cy = centre of element; w, h = width and height
- For walls: x1,y1 = start point; x2,y2 = end point (normalised)
- confidence = your confidence 0.0-1.0
- Include ALL visible rooms, doors, windows, walls
- If you cannot identify an element type, return an empty array for it
- Return ONLY the JSON, nothing else"""


def _is_enabled() -> bool:
    v = os.environ.get("HCI21_BEDROCK_ENABLED", "").strip().lower()
    if v in ("0", "false", "no", "off"):
        return False
    try:
        import boto3  # noqa: F401
        return True
    except ImportError:
        return False


def _img_to_base64(img: np.ndarray) -> str:
    """Encode OpenCV image to base64 JPEG string."""
    # Resize to max 1024px on longest side to reduce token cost
    h, w = img.shape[:2]
    max_dim = 1024
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf).decode("utf-8")


def _parse_agent_response(text: str) -> dict:
    """Extract JSON from Claude response, tolerating minor formatting."""
    text = text.strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(
            l for l in lines
            if not l.strip().startswith("```")
        ).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object within the text
        start = text.find("{")
        end   = text.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end])
            except json.JSONDecodeError:
                pass
    logger.warning("cloud_agent: could not parse JSON from response: %s", text[:200])
    return {}


def analyse_with_cloud_agent(img: np.ndarray) -> dict:
    """
    Send floor plan image to AWS Bedrock Claude and return structured analysis.

    Returns dict with keys: rooms, doors, windows, walls, summary.
    Returns empty dict on any failure — caller must handle gracefully.
    """
    if not _is_enabled():
        logger.debug("cloud_agent: disabled or boto3 not installed")
        return {}

    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError

        img_b64 = _img_to_base64(img)

        client = boto3.client("bedrock-runtime", region_name=_BEDROCK_REGION)

        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": img_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": _PROMPT,
                        },
                    ],
                }
            ],
        })

        response = client.invoke_model(
            modelId=_BEDROCK_MODEL,
            body=body,
            contentType="application/json",
            accept="application/json",
        )

        result = json.loads(response["body"].read())
        text = result["content"][0]["text"]
        parsed = _parse_agent_response(text)

        logger.info(
            "cloud_agent: rooms=%d doors=%d windows=%d walls=%d",
            len(parsed.get("rooms", [])),
            len(parsed.get("doors", [])),
            len(parsed.get("windows", [])),
            len(parsed.get("walls", [])),
        )
        parsed["_source"] = "bedrock_claude"
        return parsed

    except Exception as exc:
        logger.warning("cloud_agent: failed (%s) — continuing with CV only", exc)
        return {}


def agent_detections_to_contours(agent_data: dict, img_h: int, img_w: int) -> dict:
    """
    Convert normalised agent JSON coordinates to OpenCV contours.

    Returns dict with same keys as FloorPlanDetector.detect():
      rooms, doors, windows, walls
    """
    result = {"rooms": [], "doors": [], "windows": [], "walls": []}

    def _box_cnt(cx_n, cy_n, w_n, h_n):
        cx = cx_n * img_w
        cy = cy_n * img_h
        hw = (w_n * img_w) / 2
        hh = (h_n * img_h) / 2
        pts = np.array([
            [int(cx - hw), int(cy - hh)],
            [int(cx + hw), int(cy - hh)],
            [int(cx + hw), int(cy + hh)],
            [int(cx - hw), int(cy + hh)],
        ], dtype=np.int32).reshape(-1, 1, 2)
        return pts

    for r in agent_data.get("rooms", []):
        try:
            cnt = _box_cnt(r["cx"], r["cy"], r["w"], r["h"])
            if cv2.contourArea(cnt) > 100:
                cnt._agent_name = r.get("name", "Room")
                result["rooms"].append(cnt)
        except Exception:
            pass

    for d in agent_data.get("doors", []):
        try:
            cnt = _box_cnt(d["cx"], d["cy"], d["w"], d["h"])
            if cv2.contourArea(cnt) > 10:
                result["doors"].append(cnt)
        except Exception:
            pass

    for win in agent_data.get("windows", []):
        try:
            cnt = _box_cnt(win["cx"], win["cy"], win["w"], win["h"])
            if cv2.contourArea(cnt) > 10:
                result["windows"].append(cnt)
        except Exception:
            pass

    for wall in agent_data.get("walls", []):
        try:
            x1 = int(wall["x1"] * img_w)
            y1 = int(wall["y1"] * img_h)
            x2 = int(wall["x2"] * img_w)
            y2 = int(wall["y2"] * img_h)
            thick = max(4, int(wall.get("thickness", 0.01) * min(img_w, img_h)))
            # Build a thin rectangle along the wall line
            dx, dy = x2 - x1, y2 - y1
            length = max(1.0, (dx**2 + dy**2) ** 0.5)
            nx, ny = -dy / length * thick / 2, dx / length * thick / 2
            pts = np.array([
                [int(x1 + nx), int(y1 + ny)],
                [int(x2 + nx), int(y2 + ny)],
                [int(x2 - nx), int(y2 - ny)],
                [int(x1 - nx), int(y1 - ny)],
            ], dtype=np.int32).reshape(-1, 1, 2)
            if cv2.contourArea(pts) > 20:
                result["walls"].append(pts)
        except Exception:
            pass

    return result
