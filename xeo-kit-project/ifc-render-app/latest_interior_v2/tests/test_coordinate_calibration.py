from coordinate_calibration import fit_affine


def test_affine_reconstructs_world_frame():
    samples = [
        ((0.0, 0.0), (10.0, 20.0)),
        ((1.0, 0.0), (18.0, 20.0)),
        ((0.0, 1.0), (10.0, 24.0)),
        ((1.0, 1.0), (18.0, 24.0)),
    ]
    transform, diagnostics = fit_affine(samples)
    assert [round(v, 6) for v in transform.apply([0.5, 0.5])] == [14.0, 22.0]
    assert diagnostics["median_error"] < 1e-6


def test_affine_tolerates_one_gross_wall_anchor():
    samples = [
        ((0.0, 0.0), (10.0, 20.0)),
        ((1.0, 0.0), (18.0, 20.0)),
        ((0.0, 1.0), (10.0, 24.0)),
        ((1.0, 1.0), (18.0, 24.0)),
        ((0.25, 0.5), (12.0, 22.0)),
        ((0.75, 0.5), (100.0, -50.0)),
    ]
    transform, diagnostics = fit_affine(samples, robust=True)
    mapped = transform.apply([0.5, 0.5])
    assert [round(v, 3) for v in mapped] == [14.0, 22.0]
    assert diagnostics["outliers_removed"] >= 1
