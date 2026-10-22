const BUILT_IN_COLOR_LIBRARY = [
  { id: 'paint-warm-white', name: 'Warm White', category: 'Paint', kind: 'color', brand: 'HCI Essentials', collection: 'Core palette', color: '#F4F1EA', rgb: [0.9569, 0.9451, 0.9176], swatch: '#F4F1EA' },
  { id: 'paint-soft-sand', name: 'Soft Sand', category: 'Paint', kind: 'color', brand: 'HCI Essentials', collection: 'Core palette', color: '#D8C6A8', rgb: [0.8471, 0.7765, 0.6588], swatch: '#D8C6A8' },
  { id: 'paint-sage', name: 'Sage', category: 'Paint', kind: 'color', brand: 'HCI Essentials', collection: 'Core palette', color: '#9EAF9A', rgb: [0.6196, 0.6863, 0.6039], swatch: '#9EAF9A' },
  { id: 'paint-charcoal', name: 'Charcoal', category: 'Paint', kind: 'color', brand: 'HCI Essentials', collection: 'Core palette', color: '#34383D', rgb: [0.2039, 0.2196, 0.2392], swatch: '#34383D' },
  { id: 'paint-terracotta', name: 'Terracotta', category: 'Accent', kind: 'color', brand: 'HCI Essentials', collection: 'Accent palette', color: '#C96A4A', rgb: [0.7882, 0.4157, 0.2902], swatch: '#C96A4A' },
  { id: 'paint-sky', name: 'Soft Blue', category: 'Accent', kind: 'color', brand: 'HCI Essentials', collection: 'Accent palette', color: '#7EA7C7', rgb: [0.4941, 0.6549, 0.7804], swatch: '#7EA7C7' },
  { id: 'paint-black', name: 'Black', category: 'Basics', kind: 'color', brand: 'HCI Essentials', collection: 'Basic palette', color: '#111111', rgb: [0.0667, 0.0667, 0.0667], swatch: '#111111' },
  { id: 'paint-white', name: 'White', category: 'Basics', kind: 'color', brand: 'HCI Essentials', collection: 'Basic palette', color: '#FFFFFF', rgb: [1, 1, 1], swatch: '#FFFFFF' },
  { id: 'paint-red', name: 'Red', category: 'Basics', kind: 'color', brand: 'HCI Essentials', collection: 'Basic palette', color: '#E74C3C', rgb: [0.9059, 0.3059, 0.2353], swatch: '#E74C3C' },
  { id: 'paint-green', name: 'Green', category: 'Basics', kind: 'color', brand: 'HCI Essentials', collection: 'Basic palette', color: '#2ECC71', rgb: [0.1804, 0.8, 0.4431], swatch: '#2ECC71' },
];

// Fabric and tile assets are intentionally not hard-coded here. The working library
// is provided by GET /api/catalog/materials so Admin and the editor share one source.
export const COLOR_LIBRARY = BUILT_IN_COLOR_LIBRARY;
export const FABRIC_LIBRARY = [];
export const TEXTURE_LIBRARY = [];
export const MATERIAL_LIBRARY = COLOR_LIBRARY;
export const getMaterialById = (id) => MATERIAL_LIBRARY.find((material) => material.id === id) || null;
