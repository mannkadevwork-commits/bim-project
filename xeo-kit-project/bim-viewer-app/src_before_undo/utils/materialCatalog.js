const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const MATERIAL_ASSET_BASE = `${API_BASE_URL}/assets/materials`;

export const COLOR_LIBRARY = [
  { id: 'paint-warm-white', name: 'Warm White', category: 'Paint', kind: 'color', color: '#F4F1EA', rgb: [0.9569, 0.9451, 0.9176], swatch: '#F4F1EA' },
  { id: 'paint-soft-sand', name: 'Soft Sand', category: 'Paint', kind: 'color', color: '#D8C6A8', rgb: [0.8471, 0.7765, 0.6588], swatch: '#D8C6A8' },
  { id: 'paint-sage', name: 'Sage', category: 'Paint', kind: 'color', color: '#9EAF9A', rgb: [0.6196, 0.6863, 0.6039], swatch: '#9EAF9A' },
  { id: 'paint-charcoal', name: 'Charcoal', category: 'Paint', kind: 'color', color: '#34383D', rgb: [0.2039, 0.2196, 0.2392], swatch: '#34383D' },
  { id: 'paint-terracotta', name: 'Terracotta', category: 'Accent', kind: 'color', color: '#C96A4A', rgb: [0.7882, 0.4157, 0.2902], swatch: '#C96A4A' },
  { id: 'paint-sky', name: 'Soft Blue', category: 'Accent', kind: 'color', color: '#7EA7C7', rgb: [0.4941, 0.6549, 0.7804], swatch: '#7EA7C7' },
  { id: 'paint-black', name: 'Black', category: 'Basics', kind: 'color', color: '#111111', rgb: [0.0667, 0.0667, 0.0667], swatch: '#111111' },
  { id: 'paint-white', name: 'White', category: 'Basics', kind: 'color', color: '#FFFFFF', rgb: [1, 1, 1], swatch: '#FFFFFF' },
  { id: 'paint-red', name: 'Red', category: 'Basics', kind: 'color', color: '#E74C3C', rgb: [0.9059, 0.3059, 0.2353], swatch: '#E74C3C' },
  { id: 'paint-green', name: 'Green', category: 'Basics', kind: 'color', color: '#2ECC71', rgb: [0.1804, 0.8, 0.4431], swatch: '#2ECC71' },
];

export const FABRIC_LIBRARY = [
  { id: 'fabric-slate', name: 'Slate Fabric', category: 'Upholstery', kind: 'fabric', textureSrc: `${MATERIAL_ASSET_BASE}/fabric.png`, color: '#566063', rgb: [0.337, 0.376, 0.388], repeat: [5, 5], roughness: 0.92, metallic: 0 },
];

export const TEXTURE_LIBRARY = [
  { id: 'oak-natural', name: 'Natural Oak', category: 'Wood', kind: 'texture', textureSrc: `${MATERIAL_ASSET_BASE}/oak.png`, color: '#A46C39', rgb: [0.643, 0.424, 0.224], repeat: [3, 3], roughness: 0.72, metallic: 0 },
  { id: 'marble-soft', name: 'Soft Marble', category: 'Stone', kind: 'texture', textureSrc: `${MATERIAL_ASSET_BASE}/marble.png`, color: '#EBE9E4', rgb: [0.922, 0.914, 0.894], repeat: [2, 2], roughness: 0.4, metallic: 0 },
  { id: 'concrete-light', name: 'Light Concrete', category: 'Stone', kind: 'texture', textureSrc: `${MATERIAL_ASSET_BASE}/concrete.png`, color: '#B0B2AF', rgb: [0.69, 0.698, 0.686], repeat: [2.5, 2.5], roughness: 0.9, metallic: 0 },
  { id: 'terrazzo-neutral', name: 'Neutral Terrazzo', category: 'Tile', kind: 'texture', textureSrc: `${MATERIAL_ASSET_BASE}/terrazzo.png`, color: '#CDC9C0', rgb: [0.804, 0.788, 0.753], repeat: [2, 2], roughness: 0.48, metallic: 0 },
  { id: 'stone-grey', name: 'Grey Stone', category: 'Stone', kind: 'texture', textureSrc: `${MATERIAL_ASSET_BASE}/stone.png`, color: '#918E86', rgb: [0.569, 0.557, 0.525], repeat: [2, 2], roughness: 0.82, metallic: 0 },
];

export const MATERIAL_LIBRARY = [...COLOR_LIBRARY, ...FABRIC_LIBRARY, ...TEXTURE_LIBRARY];
export const getMaterialById = (id) => MATERIAL_LIBRARY.find((material) => material.id === id) || null;