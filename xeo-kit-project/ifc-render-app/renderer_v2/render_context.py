"""
renderer_v2.render_context
============================

Defines ``RenderContext``: renderer-wide settings that apply to a whole
render job, as opposed to any single object in it.

RenderContext deliberately knows nothing about geometry, nodes, or the
scene graph -- it holds only the kind of settings that today live
scattered across render-config.json and inline constants in
aps-pipeline.js (e.g. ACESFilmicToneMapping, tone-mapping exposure,
hemisphere light colors). This PR does not wire it up to those existing
values or change how they're used -- it only defines the shape a future
PR will populate and pass into the V2 pipeline.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Dict


@dataclass
class RenderContext:
    """Renderer-wide settings for one render job.

    Fields
    ------
    coordinate_system
        The canonical runtime coordinate convention the whole pipeline
        normalizes into, e.g. "y_up". This describes the *target* space
        for RenderNode.coordinate_space == "normalized" -- it is not
        itself a per-node value.
    gamma
        Gamma value used for color-space handling.
    tone_mapping
        Name of the tone-mapping operator to use (e.g. "aces_filmic",
        matching the current viewer's THREE.ACESFilmicToneMapping), kept
        as a string rather than a library-specific enum so this module
        has no rendering-library dependency.
    environment
        Free-form settings for scene environment/background (e.g.
        background color, HDRI path). Left open-schema deliberately, since
        environment lighting isn't implemented yet.
    camera_defaults
        Free-form default camera settings (fov, near/far planes, default
        angle), mirroring what render-config.json holds today.
    shadow_settings
        Free-form shadow-map settings (map type, bias, camera frustum
        sizing).
    ground_plane
        Free-form settings for an optional ground/floor plane (color,
        offset, visibility).

    Every settings sub-field is an open ``Dict[str, Any]`` rather than its
    own dataclass because this PR's scope is establishing that these
    *categories* of setting exist and belong on RenderContext -- not
    finalizing their internal schema, which depends on decisions later
    PRs (lighting, camera framing) haven't made yet.
    """

    coordinate_system: str = "y_up"
    gamma: float = 2.2
    tone_mapping: str = "aces_filmic"
    environment: Dict[str, Any] = field(default_factory=dict)
    camera_defaults: Dict[str, Any] = field(default_factory=dict)
    shadow_settings: Dict[str, Any] = field(default_factory=dict)
    ground_plane: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize these settings to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RenderContext":
        """Reconstruct a RenderContext from a dict produced by ``to_dict``.

        Unknown keys are ignored; missing keys fall back to this class's
        own defaults (rather than raising), since every field here has a
        sensible default and a partially-specified settings dict is a
        normal, expected input (e.g. a config file that only overrides
        tone_mapping).
        """
        known_fields = {f.name for f in dataclasses.fields(cls)}
        filtered = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered)