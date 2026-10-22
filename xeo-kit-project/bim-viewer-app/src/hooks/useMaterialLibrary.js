import { useCallback, useEffect, useMemo, useState } from 'react';
import { COLOR_LIBRARY } from '../utils/materialCatalog';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function rgbFromHex(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return [1, 1, 1];
  const value = match[1];
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function toEditorMaterial(row) {
  const repeat = [Number(row.repeat_x) || 2, Number(row.repeat_y) || 2];
  const texturePath = String(row.texture_url || '');
  const browserUrl = !texturePath ? null : /^https?:\/\//i.test(texturePath)
    ? texturePath
    : `${API_BASE_URL.replace(/\/$/, '')}/${texturePath.replace(/^\//, '')}`;
  const stableId = `material-${row.id}`;
  return {
    id: stableId,
    materialAssetId: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    category: row.category || (row.kind === 'color' ? 'Paint' : row.kind === 'fabric' ? 'Upholstery' : 'Tile & Surface'),
    kind: row.kind === 'color' ? 'color' : row.kind === 'fabric' ? 'fabric' : 'texture',
    brand: row.brand || null,
    collection: row.collection || null,
    shadeCode: row.shade_code || null,
    sourceDocument: row.source_document || null,
    sourcePage: row.source_page || null,
    hexSource: row.hex_source || 'manual',
    color: row.color_hex || '#FFFFFF',
    rgb: rgbFromHex(row.color_hex),
    textureSrc: browserUrl,
    textureUrl: texturePath,
    // Keep the root-relative source in persisted project state. The compiler reads
    // this path from render-app/assets while the editor uses textureSrc above.
    texture: row.kind === 'color' || !texturePath ? null : { id: row.slug || stableId, name: row.name, src: texturePath, repeat },
    repeat,
    roughness: Number(row.roughness ?? 0.8),
    metallic: Number(row.metallic ?? 0),
  };
}

export function useMaterialLibrary() {
  const [uploadedMaterials, setUploadedMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/catalog/materials`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Material library request failed (${response.status}).`);
      setUploadedMaterials(Array.isArray(payload) ? payload.map(toEditorMaterial) : []);
    } catch (fetchError) {
      setUploadedMaterials([]);
      setError(fetchError?.message || 'Material library is unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const materialLibrary = useMemo(() => [...COLOR_LIBRARY, ...uploadedMaterials], [uploadedMaterials]);

  return {
    materialLibrary,
    uploadedMaterials,
    loading,
    error,
    refresh,
  };
}
