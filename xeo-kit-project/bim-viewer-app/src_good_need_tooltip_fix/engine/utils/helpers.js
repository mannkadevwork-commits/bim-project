import { AXIS_NAMES } from './constants';

export const brightenColor = (color, factor = 1.25) => 
  color.map(c => Math.min(1, c * factor));

export const axesKey = (axesList) =>
  [...axesList].sort((a, b) => a.axis - b.axis).map(a => AXIS_NAMES[a.axis]).join('');

export const vec3Distance = (a, b) => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export const axisDirKey = (axis, dir) => `${axis}_${dir}`;