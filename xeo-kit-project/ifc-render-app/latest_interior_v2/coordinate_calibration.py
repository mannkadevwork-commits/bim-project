"""Shared 2D image-space -> BIM-space coordinate calibration.

The floor-plan analyzer can return a second, frame-stable coordinate for each
architectural element: normalized image UV in the *full source image*.

Walls provide correspondence anchors because their existing ``start_pt`` /
``end_pt`` values already define the BIM coordinate system used by the IFC
builder.  We fit a single affine transform from image UV -> BIM XY and then
reuse that transform for openings and interior components.

This avoids separate per-object normalization, which is the source of subtle
left/right drift when Gemini reasons about walls and furniture independently.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from statistics import median
from typing import Iterable, List, Sequence, Tuple


Point2 = Tuple[float, float]
Sample = Tuple[Point2, Point2]  # (image_uv, bim_xy)


@dataclass(frozen=True)
class Affine2D:
    """2D affine transform mapping (u, v) -> (x, y)."""

    x_u: float
    x_v: float
    x_c: float
    y_u: float
    y_v: float
    y_c: float

    def apply(self, uv: Sequence[float]) -> List[float]:
        u = float(uv[0])
        v = float(uv[1])
        return [
            self.x_u * u + self.x_v * v + self.x_c,
            self.y_u * u + self.y_v * v + self.y_c,
        ]


def _solve_3x3(a: List[List[float]], b: List[float]) -> List[float] | None:
    """Solve a 3x3 linear system using Gaussian elimination with pivoting."""
    m = [list(row) + [rhs] for row, rhs in zip(a, b)]

    for col in range(3):
        pivot = max(range(col, 3), key=lambda r: abs(m[r][col]))
        pivot_value = abs(m[pivot][col])
        if pivot_value < 1e-12:
            return None
        if pivot != col:
            m[col], m[pivot] = m[pivot], m[col]

        divisor = m[col][col]
        for j in range(col, 4):
            m[col][j] /= divisor

        for row in range(3):
            if row == col:
                continue
            factor = m[row][col]
            if abs(factor) < 1e-15:
                continue
            for j in range(col, 4):
                m[row][j] -= factor * m[col][j]

    return [m[i][3] for i in range(3)]


def _fit_axis(samples: Sequence[Sample], axis: int) -> List[float] | None:
    """Fit x/y = a*u + b*v + c via ordinary least squares."""
    ata = [[0.0] * 3 for _ in range(3)]
    atb = [0.0] * 3

    for uv, world in samples:
        u, v = float(uv[0]), float(uv[1])
        target = float(world[axis])
        row = [u, v, 1.0]
        for i in range(3):
            atb[i] += row[i] * target
            for j in range(3):
                ata[i][j] += row[i] * row[j]

    return _solve_3x3(ata, atb)


def fit_affine(samples: Iterable[Sample], *, robust: bool = True) -> tuple[Affine2D, dict]:
    """Fit one affine transform and return diagnostics.

    At least three non-collinear image-space anchors are required.  When
    ``robust`` is enabled, one refit is performed after discarding gross
    residual outliers.  This protects the transform from an occasional bad
    wall endpoint without changing the architectural wall coordinates.
    """
    clean: List[Sample] = []
    seen: set[tuple[float, float]] = set()
    for uv, world in samples:
        if len(uv) < 2 or len(world) < 2:
            continue
        u, v = float(uv[0]), float(uv[1])
        x, y = float(world[0]), float(world[1])
        if not all(math.isfinite(val) for val in (u, v, x, y)):
            continue
        # Keep normalized image coordinates bounded, but tolerate tiny Gemini
        # overshoots such as -0.002 / 1.001 before clipping at call sites.
        key = (round(u, 8), round(v, 8))
        if key in seen:
            continue
        seen.add(key)
        clean.append(((u, v), (x, y)))

    if len(clean) < 3:
        raise ValueError("At least 3 distinct image-space anchors are required")

    def fit(current: Sequence[Sample]) -> Affine2D:
        x_params = _fit_axis(current, 0)
        y_params = _fit_axis(current, 1)
        if x_params is None or y_params is None:
            raise ValueError("Image-space anchors are degenerate; affine calibration is singular")
        return Affine2D(
            x_u=x_params[0], x_v=x_params[1], x_c=x_params[2],
            y_u=y_params[0], y_v=y_params[1], y_c=y_params[2],
        )

    transform = fit(clean)

    def residuals(current: Sequence[Sample], t: Affine2D) -> List[float]:
        return [
            math.hypot(
                t.apply(uv)[0] - world[0],
                t.apply(uv)[1] - world[1],
            )
            for uv, world in current
        ]

    initial_residuals = residuals(clean, transform)
    used = list(clean)
    removed = 0

    if robust and len(clean) >= 6:
        baseline = median(initial_residuals)
        threshold = max(0.20, baseline * 3.0 + 0.05)
        filtered = [sample for sample, residual in zip(clean, initial_residuals) if residual <= threshold]
        # Only accept trimming when it leaves enough non-degenerate anchors.
        if len(filtered) >= 3 and len(filtered) < len(clean):
            try:
                candidate = fit(filtered)
                candidate_residuals = residuals(filtered, candidate)
                # A robust refit must actually improve the median error.
                if median(candidate_residuals) <= median(initial_residuals):
                    transform = candidate
                    used = filtered
                    removed = len(clean) - len(filtered)
            except ValueError:
                pass

    final_residuals = residuals(used, transform)
    all_final_residuals = residuals(clean, transform)
    return transform, {
        "anchor_count": len(clean),
        "used_anchor_count": len(used),
        "outliers_removed": removed,
        "rms_error": math.sqrt(sum(r * r for r in final_residuals) / max(1, len(final_residuals))),
        "median_error": median(final_residuals),
        "max_error": max(all_final_residuals) if all_final_residuals else 0.0,
        "transform": {
            "x_u": transform.x_u,
            "x_v": transform.x_v,
            "x_c": transform.x_c,
            "y_u": transform.y_u,
            "y_v": transform.y_v,
            "y_c": transform.y_c,
        },
    }


def clamp_uv(uv: Sequence[float]) -> List[float]:
    """Clamp Gemini's normalized image coordinate to the valid [0, 1] frame."""
    return [
        max(0.0, min(1.0, float(uv[0]))),
        max(0.0, min(1.0, float(uv[1]))),
    ]
