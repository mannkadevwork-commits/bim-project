"""
renderer_v2.render_node
========================

Defines ``RenderNode``: the single, uniform representation of "one object
in the scene" that V2 uses in place of directly-mutated mesh objects.

Every IfcWallStandardCase, every IfcDoor, every furniture instance, and
(in future PRs) every light or annotation becomes exactly one RenderNode.
Geometry and material data are NOT embedded here -- a node only carries
*references* (``geometry_ref`` / ``material_ref``) into the stores owned by
``RenderScene``, so the same source geometry or material can be shared by
multiple nodes without duplicating data, and so a node's identity/transform
history can be inspected and serialized independently of its (potentially
large) mesh data.

Why ``coordinate_space`` is its own field
------------------------------------------
The current renderer decides whether to apply an axis correction based on
scattered, ad hoc checks (structural meshes always get it in one place;
furniture gets it conditionally on file extension in another; furniture
position/rotation explicitly never does). That fragmentation is the direct
cause of the "did we rotate this twice" bug class. Making
``coordinate_space`` an explicit, validated field on every node means a
future Coordinate Normalizer stage can ask each node "are you native or
normalized?" instead of inferring it from context, and can refuse to
normalize an already-normalized node.

PR-2 additions: ``render_id`` and ``world_transform``
-------------------------------------------------------
``render_id`` is a new, independent identifier -- distinct from ``id``
(this node's identity within its RenderScene), ``global_id`` (IFC
identity), and ``instance_id`` (frontend furniture identity). It exists to
stay stable across different EXPORT targets (e.g. the same logical node
appearing in a GLB export and a future Blender export should carry the
same render_id even if the exporters mint different internal ids of their
own). If not supplied explicitly, one is generated once at construction
time and is preserved verbatim by to_dict()/from_dict() thereafter -- it
is never regenerated on a round trip, which is what "stable" means here.

``world_transform`` is a new field reserved for a future stage (a
Transform Resolver that walks parent chains) to populate. This PR only
declares the field and defaults it to None; nothing in this module
computes it, per PR-2's scope.
"""

from __future__ import annotations

import dataclasses
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

VALID_SOURCE_TYPES = frozenset({
    "structural",   # IFC-native building elements (walls, doors, slabs...)
    "furniture",    # Dropped/placed furniture instances
    "light",        # Future: scene lights
    "annotation",   # Future: panorama waypoints, measurement callouts, etc.
    "camera",       # Future: saved camera positions
})
"""Known values for RenderNode.source_type.

To add a new category (e.g. a new asset kind), add it here rather than
bypassing validation -- this set is the single place that documents which
kinds of objects the scene graph knows how to hold.
"""

VALID_COORDINATE_SPACES = frozenset({
    "native",       # As extracted from the source format, untransformed
                    # (e.g. Z-up for raw IFC/OBJ geometry).
    "normalized",   # Already converted into the app's canonical Y-up
                    # runtime space.
})
"""Known values for RenderNode.coordinate_space."""


def identity_matrix() -> List[List[float]]:
    """Return a fresh 4x4 identity transform as a list of 4 row-lists.

    Used as the default ``local_transform`` for a node that hasn't had any
    transform applied yet. Returned as plain nested lists (not a numpy
    array) so this module has no numeric-library dependency and every
    RenderNode is trivially JSON-serializable.
    """
    return [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


@dataclass
class RenderNode:
    """One object in the V2 scene graph.

    Fields
    ------
    id
        Stable internal identifier for this node within its RenderScene.
        Required, must be non-empty.
    source_type
        What kind of object this is. Must be one of ``VALID_SOURCE_TYPES``.
    global_id
        The IFC GlobalId for structural elements. ``None`` for nodes that
        have no IFC origin (e.g. furniture that was never an IFC element).
        Carried as real data here -- not encoded into a display name -- so
        downstream lookups (material overrides, structural edits keyed by
        GlobalId in project_state.json) never depend on name-sanitization
        or collide the way the current OBJ/MTL naming scheme can.
    instance_id
        The frontend-assigned instance id for furniture/placed items
        (matches project_state.json's furniture[].instanceId).
    render_id
        A new, export-stable identifier, independent of id/global_id/
        instance_id. See module docstring "PR-2 additions" section. Not a
        replacement for any existing identity field.
    name
        Optional human-readable display name. Purely cosmetic -- never
        used as a lookup key (that's what global_id/instance_id are for).
    ifc_type
        The IFC entity type (e.g. "IfcWallStandardCase"), if applicable.
    geometry_ref
        Key into RenderScene.geometry_store identifying this node's
        geometry. ``None`` if the node has no geometry of its own (e.g. a
        pure grouping/organizational node).
    material_ref
        Key into RenderScene.material_store identifying this node's
        resolved material. ``None`` if not yet resolved.
    local_transform
        4x4 transform (as 4 row-lists of floats) relative to this node's
        parent. Defaults to the identity matrix. This is the *authored*
        transform -- e.g. exactly what project_state.json saved for a
        furniture item, or the structural-edit delta for a wall -- not a
        transform that has been baked into vertex data.
    world_transform
        4x4 transform in world space, or None if not yet computed. This
        PR only declares the field; it is populated by a future Transform
        Resolver stage that composes local_transform up the parent chain,
        not by anything in this module.
    coordinate_space
        Whether local_transform/geometry are in "native" or "normalized"
        space. See module docstring for why this exists as an explicit,
        validated field.
    metadata
        Free-form bag for anything that doesn't need its own first-class
        field yet (e.g. IFC property set values). Deliberately unstructured
        so this PR doesn't have to anticipate every future need.
    children
        List of child node ids (not child objects) -- keeps a RenderNode
        trivially serializable without circular references. The actual
        RenderNode objects live in RenderScene.nodes, keyed by id.
    parent
        Id of this node's parent, or ``None`` for a root-level node.
    provenance
        Free-form record of *how* this node's current state was derived,
        e.g. {"material_source": "override"} vs {"material_source":
        "native"} vs {"material_source": "default"}. Intended to replace
        free-text warning strings with queryable facts in later PRs.
    edit_history
        Ordered list of operations applied to this node's transform/
        material/etc. over time, e.g. a structural resize delta. Kept as
        data (not baked into geometry) so a later PR can implement
        undo/redo by popping the last entry and recomputing state, instead
        of re-deriving everything from scratch.
    """

    id: str
    source_type: str
    global_id: Optional[str] = None
    instance_id: Optional[str] = None
    render_id: Optional[str] = None
    name: Optional[str] = None
    ifc_type: Optional[str] = None
    geometry_ref: Optional[str] = None
    material_ref: Optional[str] = None
    local_transform: List[List[float]] = field(default_factory=identity_matrix)
    world_transform: Optional[List[List[float]]] = None
    coordinate_space: str = "native"
    metadata: Dict[str, Any] = field(default_factory=dict)
    children: List[str] = field(default_factory=list)
    parent: Optional[str] = None
    provenance: Dict[str, Any] = field(default_factory=dict)
    edit_history: List[Dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        """Validate the fields that, if wrong, would silently corrupt
        the scene graph rather than raise -- these are checked eagerly
        instead of left to fail later inside some downstream stage.

        Also assigns render_id if one wasn't supplied. This only fires
        when render_id is falsy (i.e. a brand-new node), so loading an
        existing node via from_dict() with its render_id already set
        preserves that value verbatim -- which is what makes render_id
        "stable across exports" rather than regenerated on every reload.
        """
        if not self.id:
            raise ValueError("RenderNode.id must be a non-empty string.")

        if self.source_type not in VALID_SOURCE_TYPES:
            raise ValueError(
                f"RenderNode '{self.id}': source_type must be one of "
                f"{sorted(VALID_SOURCE_TYPES)}, got {self.source_type!r}. "
                f"Add new categories to VALID_SOURCE_TYPES rather than "
                f"bypassing this check."
            )

        if self.coordinate_space not in VALID_COORDINATE_SPACES:
            raise ValueError(
                f"RenderNode '{self.id}': coordinate_space must be one of "
                f"{sorted(VALID_COORDINATE_SPACES)}, got "
                f"{self.coordinate_space!r}."
            )

        if not self.render_id:
            self.render_id = uuid.uuid4().hex

    def add_child(self, child_id: str) -> None:
        """Register ``child_id`` as a child of this node (idempotent).

        Does NOT set the child's own ``parent`` field -- that's the
        responsibility of whoever holds both node objects (RenderScene),
        since a bare RenderNode doesn't have access to other nodes.
        """
        if not child_id:
            raise ValueError("child_id must be a non-empty string.")
        if child_id == self.id:
            raise ValueError(f"Node '{self.id}' cannot be its own child.")
        if child_id not in self.children:
            self.children.append(child_id)

    def remove_child(self, child_id: str) -> bool:
        """Remove ``child_id`` from this node's children, if present.

        Returns True if a child was removed, False if it wasn't listed.
        Does NOT clear the child's own ``parent`` field -- see add_child.
        """
        if child_id in self.children:
            self.children.remove(child_id)
            return True
        return False

    def to_dict(self) -> Dict[str, Any]:
        """Serialize this node to a plain, JSON-safe dict.

        Every field is already a JSON-safe primitive (str/None/list/dict
        of floats and strings), so this is a straightforward recursive
        dataclass-to-dict conversion.
        """
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RenderNode":
        """Reconstruct a RenderNode from a dict produced by ``to_dict``.

        Unknown keys in ``data`` are ignored (forward-compatible with
        future fields being added to serialized data written by a newer
        version of this class). A missing/empty ``local_transform`` is
        filled in with the identity matrix rather than left absent, so a
        node loaded from partial/legacy data still has a well-formed
        transform.

        Required keys (``id``, ``source_type``) are NOT defaulted -- a
        dict missing them will raise a ``TypeError``, since silently
        inventing an id or source_type would hide a real data problem.

        PR-1 data missing ``render_id``/``world_transform`` (written
        before this PR existed) loads cleanly: world_transform simply
        stays None, and render_id is freshly generated by __post_init__
        since it's absent -- backward compatible by construction.
        """
        known_fields = {f.name for f in dataclasses.fields(cls)}
        filtered = {k: v for k, v in data.items() if k in known_fields}
        if not filtered.get("local_transform"):
            filtered["local_transform"] = identity_matrix()
        return cls(**filtered)