"""
renderer_v2.scene_report
==========================

Defines ``SceneReport`` and ``ReportEntry``: structured, stage-tagged
diagnostics for the V2 pipeline.

The current renderer collects diagnostics as a single flat list of free-
text strings (``warnings: []`` in scene_merger.py's stdout contract),
with no record of which stage produced a given warning, which element it
concerns, or its severity. That makes it impossible to answer questions
like "how many elements fell back to a default material" without parsing
message text. SceneReport replaces that with structured entries that can
be filtered, counted, and grouped by stage/severity/element.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

VALID_SEVERITIES = ("info", "warning", "error")
"""Allowed values for ReportEntry.severity, in ascending order of
seriousness."""


@dataclass
class ReportEntry:
    """A single diagnostic entry.

    Fields
    ------
    stage
        Name of the pipeline stage that produced this entry (e.g.
        "material_resolver", "coordinate_normalizer"). Free-form string
        rather than an enum, since the set of stages is expected to grow
        as later PRs add them.
    severity
        One of ``VALID_SEVERITIES``.
    message
        Human-readable description.
    element_id
        The RenderNode.id (or global_id/instance_id, at the producing
        stage's discretion) this entry concerns, if any. ``None`` for
        scene-wide entries not tied to a specific element.
    metadata
        Free-form structured data relevant to this entry (e.g.
        {"expected_color": "#117864", "resolved_color": "#cccccc"}),
        letting a consumer act on facts instead of parsing ``message``.
    """

    stage: str
    severity: str
    message: str
    element_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize this entry to a plain, JSON-safe dict."""
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ReportEntry":
        """Reconstruct a ReportEntry from a dict produced by ``to_dict``."""
        known_fields = {f.name for f in dataclasses.fields(cls)}
        filtered = {k: v for k, v in data.items() if k in known_fields}
        return cls(**filtered)


@dataclass
class SceneReport:
    """Collects diagnostics produced while building/validating a scene.

    One SceneReport is expected to accumulate entries across every stage
    of a single render job, so a later "did this render actually
    faithfully reproduce the frontend" question can be answered by
    inspecting one object instead of grepping stderr output.
    """

    entries: List[ReportEntry] = field(default_factory=list)

    def _add(
        self,
        stage: str,
        severity: str,
        message: str,
        element_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ReportEntry:
        if severity not in VALID_SEVERITIES:
            raise ValueError(
                f"severity must be one of {VALID_SEVERITIES}, got {severity!r}."
            )
        entry = ReportEntry(
            stage=stage,
            severity=severity,
            message=message,
            element_id=element_id,
            metadata=dict(metadata) if metadata else {},
        )
        self.entries.append(entry)
        return entry

    def info(
        self,
        stage: str,
        message: str,
        element_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ReportEntry:
        """Record an informational entry (no fidelity or correctness impact)."""
        return self._add(stage, "info", message, element_id, metadata)

    def warning(
        self,
        stage: str,
        message: str,
        element_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ReportEntry:
        """Record a warning (a fallback was used, or something is degraded
        but the render can still proceed)."""
        return self._add(stage, "warning", message, element_id, metadata)

    def error(
        self,
        stage: str,
        message: str,
        element_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ReportEntry:
        """Record an error (something is wrong enough that the render's
        correctness or completion is in question)."""
        return self._add(stage, "error", message, element_id, metadata)

    def has_errors(self) -> bool:
        """True if any entry recorded so far has severity "error"."""
        return any(entry.severity == "error" for entry in self.entries)

    def summary(self) -> Dict[str, Any]:
        """Return aggregate counts: total, counts by severity, and counts
        broken down by stage x severity.

        This is the structured replacement for eyeballing a warnings list
        -- e.g. ``summary()["by_stage"]["material_resolver"]["warning"]``
        answers "how many elements needed a diagnosable fallback" without
        parsing any message text.
        """
        counts: Dict[str, int] = {severity: 0 for severity in VALID_SEVERITIES}
        by_stage: Dict[str, Dict[str, int]] = {}

        for entry in self.entries:
            counts[entry.severity] += 1
            stage_counts = by_stage.setdefault(
                entry.stage, {severity: 0 for severity in VALID_SEVERITIES}
            )
            stage_counts[entry.severity] += 1

        return {
            "total": len(self.entries),
            "counts": counts,
            "by_stage": by_stage,
            "has_errors": self.has_errors(),
        }

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the full report (entries + summary) to a plain,
        JSON-safe dict."""
        return {
            "entries": [entry.to_dict() for entry in self.entries],
            "summary": self.summary(),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SceneReport":
        """Reconstruct a SceneReport from a dict produced by ``to_dict``.

        Only ``entries`` is read back -- ``summary`` is derived, never
        stored as source of truth, so a stale summary in old data can
        never disagree with the entries it's supposedly summarizing.
        """
        raw_entries = data.get("entries") or []
        return cls(entries=[ReportEntry.from_dict(e) for e in raw_entries])