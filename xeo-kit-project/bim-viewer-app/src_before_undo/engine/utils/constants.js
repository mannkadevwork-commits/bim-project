export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const AXIS_NAMES = ['X', 'Y', 'Z'];

export const AXIS_HANDLE_COLORS = {
  X: [0.95, 0.25, 0.25],
  Y: [0.25, 0.85, 0.35],
  Z: [0.3, 0.5, 0.95],
  XY: [0.95, 0.85, 0.25],
  XZ: [0.9, 0.35, 0.9],
  YZ: [0.25, 0.85, 0.9],
  XYZ: [0.95, 0.95, 0.95],
};

export const STRETCH_HANDLE_FACE_OPACITY = 0.85;
export const STRETCH_HANDLE_EDGE_OPACITY = 0.5;
export const STRETCH_HANDLE_CORNER_OPACITY = 0.3;
export const STRETCH_HANDLE_HOVER_SCALE = 1.22;
export const STRETCH_HANDLE_DRAG_SCALE = 1.38;
export const STRETCH_HANDLE_ANIM_MS = 150;

export const SELECTION_CAGE_COLOR = [0.35, 0.62, 1];

// Extracted from inside the hook (getWallSnapData) to global constants
export const WALL_IFC_CLASSES = new Set(['IfcWall', 'IfcWallStandardCase', 'IfcCurtainWall']);