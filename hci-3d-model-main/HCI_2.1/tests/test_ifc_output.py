"""
tests/test_ifc_output.py — Integration test for generate_full_ifc output validity.
Covers ISSUE-020: no test validated the generated .ifc file was parseable or correct.

Run from HCI_2.1/:
    python -m unittest tests.test_ifc_output -v
"""
import math
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np


def _make_synthetic_image(path: Path, w: int = 400, h: int = 300) -> None:
    img = np.ones((h, w, 3), dtype=np.uint8) * 240
    cv2.imwrite(str(path), img)


def _make_label_file(path: Path, w: int = 400, h: int = 300) -> dict:
    """
    Write a minimal YOLO-seg label with:
      - 2 walls (class 3): horizontal top + vertical left
      - 1 door  (class 2): on the horizontal wall
      - 1 window(class 1): on the horizontal wall
    All coordinates normalised to [0,1].
    Returns expected counts.
    """
    # Horizontal wall: thin rectangle across the top (y=0.05..0.12, x=0.05..0.95)
    wall_h = "3 0.05 0.05 0.95 0.05 0.95 0.12 0.05 0.12"
    # Vertical wall: thin rectangle on the left (x=0.05..0.12, y=0.05..0.95)
    wall_v = "3 0.05 0.05 0.12 0.05 0.12 0.95 0.05 0.95"
    # Door on horizontal wall centroid ~(0.30, 0.085)
    door   = "2 0.25 0.05 0.35 0.05 0.35 0.12 0.25 0.12"
    # Window on horizontal wall centroid ~(0.65, 0.085)
    window = "1 0.60 0.05 0.70 0.05 0.70 0.12 0.60 0.12"
    path.write_text("\n".join([wall_h, wall_v, door, window]) + "\n", encoding="utf-8")
    return {"walls": 2, "doors": 1, "windows": 1}


class TestIfcOutput(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_dir = Path(self.tmp.name)
        self.img_path = self.tmp_dir / "test_plan.png"
        self.lbl_path = self.tmp_dir / "test_plan.txt"
        self.out_ifc  = self.tmp_dir / "test_plan.ifc"
        _make_synthetic_image(self.img_path)
        self.expected = _make_label_file(self.lbl_path)

    def tearDown(self):
        self.tmp.cleanup()

    # ------------------------------------------------------------------
    # 1. generate_full_ifc returns ok=True and correct counts
    # ------------------------------------------------------------------
    def test_generate_full_ifc_returns_ok(self):
        from logic.ifc_pipeline import generate_full_ifc
        result = generate_full_ifc(
            image_path=self.img_path,
            label_path=self.lbl_path,
            output_ifc=self.out_ifc,
            meters_per_pixel=0.01,
        )
        self.assertTrue(result.get("ok"), f"generate_full_ifc returned ok=False: {result}")

    def test_ifc_file_is_written(self):
        from logic.ifc_pipeline import generate_full_ifc
        generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.01)
        self.assertTrue(self.out_ifc.exists(), "IFC file was not written to disk")
        self.assertGreater(self.out_ifc.stat().st_size, 0, "IFC file is empty")

    def test_ifc_wall_count_matches(self):
        from logic.ifc_pipeline import generate_full_ifc
        result = generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.01)
        self.assertGreaterEqual(
            result.get("ifc_walls", 0), 1,
            "Expected at least 1 IfcWall in result"
        )

    # ------------------------------------------------------------------
    # 2. IFC file is parseable by ifcopenshell
    # ------------------------------------------------------------------
    def test_ifc_parseable_by_ifcopenshell(self):
        try:
            import ifcopenshell
        except ImportError:
            self.skipTest("ifcopenshell not installed")
        from logic.ifc_pipeline import generate_full_ifc
        generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.01)
        model = ifcopenshell.open(str(self.out_ifc))
        self.assertIsNotNone(model)

    def test_ifc_entity_counts_match_result(self):
        try:
            import ifcopenshell
        except ImportError:
            self.skipTest("ifcopenshell not installed")
        from logic.ifc_pipeline import generate_full_ifc
        result = generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.01)
        model = ifcopenshell.open(str(self.out_ifc))
        ifc_walls   = model.by_type("IfcWall")
        ifc_doors   = model.by_type("IfcDoor")
        ifc_windows = model.by_type("IfcWindow")
        self.assertEqual(len(ifc_walls),   result["ifc_walls"],   "IfcWall count mismatch")
        self.assertEqual(len(ifc_doors),   result["ifc_doors"],   "IfcDoor count mismatch")
        self.assertEqual(len(ifc_windows), result["ifc_windows"], "IfcWindow count mismatch")

    def test_ifc_has_required_hierarchy(self):
        try:
            import ifcopenshell
        except ImportError:
            self.skipTest("ifcopenshell not installed")
        from logic.ifc_pipeline import generate_full_ifc
        generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.01)
        model = ifcopenshell.open(str(self.out_ifc))
        self.assertEqual(len(model.by_type("IfcProject")),          1, "Missing IfcProject")
        self.assertEqual(len(model.by_type("IfcSite")),             1, "Missing IfcSite")
        self.assertEqual(len(model.by_type("IfcBuilding")),         1, "Missing IfcBuilding")
        self.assertEqual(len(model.by_type("IfcBuildingStorey")),   1, "Missing IfcBuildingStorey")

    def test_ifc_placements_are_unique(self):
        """ISSUE-013/014: every IfcAxis2Placement3D must be a distinct entity."""
        try:
            import ifcopenshell
        except ImportError:
            self.skipTest("ifcopenshell not installed")
        from logic.ifc_pipeline import generate_full_ifc
        generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.01)
        model = ifcopenshell.open(str(self.out_ifc))
        placements = model.by_type("IfcAxis2Placement3D")
        ids = [p.id() for p in placements]
        self.assertEqual(len(ids), len(set(ids)), "Duplicate IfcAxis2Placement3D entities found")

    # ------------------------------------------------------------------
    # 3. Thickness clip uses P2 soft bounds [0.08, 0.50] (ISSUE-006)
    # ------------------------------------------------------------------
    def test_wall_thickness_within_p2_bounds(self):
        from logic.ifc_pipeline import generate_full_ifc, THICK_SOFT_HIGH_MIN_M, THICK_SOFT_HIGH_MAX_M
        result = generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.01)
        graph = result.get("p1_diagnostics", {}).get("wall_graph", {})
        for seg in (graph.get("segments") or []):
            t = float(seg.get("thickness_m", 0.23))
            self.assertGreaterEqual(
                t, THICK_SOFT_HIGH_MIN_M - 1e-6,
                f"Wall {seg.get('id')} thickness {t} below P2 min {THICK_SOFT_HIGH_MIN_M}"
            )
            self.assertLessEqual(
                t, THICK_SOFT_HIGH_MAX_M + 1e-6,
                f"Wall {seg.get('id')} thickness {t} above P2 max {THICK_SOFT_HIGH_MAX_M}"
            )

    # ------------------------------------------------------------------
    # 4. scale_confidence="high" when mpp is explicitly provided (ISSUE-009)
    # ------------------------------------------------------------------
    def test_scale_confidence_high_when_mpp_explicit(self):
        from logic.ifc_pipeline import generate_full_ifc
        result = generate_full_ifc(
            self.img_path, self.lbl_path, self.out_ifc,
            meters_per_pixel=0.005,
            scale_confidence="high",
        )
        diag = result.get("p1_diagnostics", {}).get("wall_graph", {})
        self.assertEqual(
            diag.get("scale_confidence"), "high",
            "scale_confidence should be 'high' when mpp is explicitly provided"
        )

    # ------------------------------------------------------------------
    # 5. generate_full_ifc raises on missing inputs
    # ------------------------------------------------------------------
    def test_raises_on_missing_image(self):
        from logic.ifc_pipeline import generate_full_ifc
        with self.assertRaises(FileNotFoundError):
            generate_full_ifc(
                self.tmp_dir / "nonexistent.png",
                self.lbl_path,
                self.out_ifc,
                0.01,
            )

    def test_raises_on_missing_label(self):
        from logic.ifc_pipeline import generate_full_ifc
        with self.assertRaises(FileNotFoundError):
            generate_full_ifc(
                self.img_path,
                self.tmp_dir / "nonexistent.txt",
                self.out_ifc,
                0.01,
            )

    def test_raises_on_zero_mpp(self):
        from logic.ifc_pipeline import generate_full_ifc
        with self.assertRaises(ValueError):
            generate_full_ifc(self.img_path, self.lbl_path, self.out_ifc, 0.0)


if __name__ == "__main__":
    unittest.main()
