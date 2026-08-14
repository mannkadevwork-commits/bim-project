// Compatibility shim: the runtime BIM engine lives in src/engine/useBIMEngine.js.
// Keeping a single implementation prevents the old duplicate hook from drifting
// away from the GLB/IFC transform pipeline.
export { useBIMEngine } from '../engine/useBIMEngine';
