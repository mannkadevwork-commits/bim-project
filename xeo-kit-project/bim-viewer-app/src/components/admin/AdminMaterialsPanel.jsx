import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Pencil, Trash2, Loader2, X, Layers3, UploadCloud, Search,
  Power, Image as ImageIcon, CheckCircle2, AlertCircle, RotateCw, FileUp,
} from 'lucide-react';
import CataloguePdfImport from './CataloguePdfImport';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CATEGORY_PRESETS = ['Paint', 'Architectural Finish', 'Laminate Color', 'Upholstery', 'Curtain', 'Rug', 'Tile', 'Stone', 'Wood', 'Concrete', 'Wallpaper', 'Marble', 'Other'];

const assetUrl = (url) => {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${API.replace(/\/$/, '')}/${String(url).replace(/^\//, '')}`;
};

const slugify = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

function MaterialForm({ initial, onCancel, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [slug, setSlug] = useState(initial?.slug || '');
  const [slugEdited, setSlugEdited] = useState(Boolean(initial));
  const [description, setDescription] = useState(initial?.description || '');
  const [kind, setKind] = useState(initial?.kind || 'texture');
  const [category, setCategory] = useState(initial?.category || 'Tile');
  const [colorHex, setColorHex] = useState(String(initial?.color_hex || '#D8C6A8').trim().toUpperCase());
  const [brand, setBrand] = useState(initial?.brand || '');
  const [collection, setCollection] = useState(initial?.collection || '');
  const [shadeCode, setShadeCode] = useState(initial?.shade_code || '');
  const [sourceDocument, setSourceDocument] = useState(initial?.source_document || '');
  const [sourcePage, setSourcePage] = useState(initial?.source_page ? String(initial.source_page) : '');
  const [hexSource, setHexSource] = useState(initial?.hex_source || 'manual');
  const [repeatX, setRepeatX] = useState(String(initial?.repeat_x ?? (initial?.kind === 'fabric' ? 5 : 2)));
  const [repeatY, setRepeatY] = useState(String(initial?.repeat_y ?? (initial?.kind === 'fabric' ? 5 : 2)));
  const [roughness, setRoughness] = useState(String(initial?.roughness ?? (initial?.kind === 'fabric' ? 0.92 : 0.8)));
  const [isActive, setIsActive] = useState(initial?.is_active !== false);
  const [imageFile, setImageFile] = useState(null);
  const [imageError, setImageError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');

  useEffect(() => {
    if (!imageFile) { setPreviewUrl(''); return undefined; }
    const objectUrl = URL.createObjectURL(imageFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [imageFile]);

  const displayedPreview = previewUrl || (initial?.texture_url ? assetUrl(initial.texture_url) : '');
  const isColor = kind === 'color';

  const handleNameChange = (value) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };

  const handleKindChange = (nextKind) => {
    setKind(nextKind);
    setImageError('');
    if (nextKind === 'color') {
      setImageFile(null);
      if (!initial) { setCategory('Paint'); setHexSource('manual'); }
    } else if (!initial) {
      setCategory(nextKind === 'fabric' ? 'Upholstery' : 'Tile');
      setRepeatX(nextKind === 'fabric' ? '5' : '2');
      setRepeatY(nextKind === 'fabric' ? '5' : '2');
      setRoughness(nextKind === 'fabric' ? '0.92' : '0.8');
    }
  };

  const handleImageChange = (file) => {
    setImageError('');
    setImageFile(null);
    if (!file) return;
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    const allowedExtensions = /\.(png|jpe?g|webp)$/i;
    if ((file.type && !allowedTypes.includes(file.type)) || !allowedExtensions.test(file.name)) {
      setImageError('Choose a PNG, JPG or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError('Image must be 10 MB or smaller.');
      return;
    }
    setImageFile(file);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (!name.trim() || !slug.trim()) { setError('Name and slug are required.'); return; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { setError('Slug can contain lowercase letters, numbers and hyphens only.'); return; }
    if (!isColor && !imageFile && !initial?.texture_url) { setError('Upload a cropped material image to create a fabric or texture.'); return; }
    if (!/^#[0-9A-F]{6}$/.test(colorHex.trim().toUpperCase())) { setError('Enter a valid six-digit HEX value such as #D8C6A8.'); return; }
    if (imageError) { setError(imageError); return; }

    const numbers = { repeat_x: Number(repeatX), repeat_y: Number(repeatY), roughness: Number(roughness) };
    if (!isColor && ![numbers.repeat_x, numbers.repeat_y].every(value => Number.isFinite(value) && value >= 0.05 && value <= 100)) {
      setError('Texture repeat values must be between 0.05 and 100.'); return;
    }
    if (!isColor && (!Number.isFinite(numbers.roughness) || numbers.roughness < 0 || numbers.roughness > 1)) {
      setError('Roughness must be between 0 and 1.'); return;
    }

    const formData = new FormData();
    formData.append('name', name.trim());
    formData.append('slug', slug.trim());
    formData.append('description', description.trim());
    formData.append('kind', kind);
    formData.append('category', category.trim() || (isColor ? 'Paint' : kind === 'fabric' ? 'Upholstery' : 'Tile & Surface'));
    formData.append('color_hex', colorHex.trim().toUpperCase());
    formData.append('brand', brand.trim());
    formData.append('collection', collection.trim());
    formData.append('shade_code', shadeCode.trim());
    formData.append('source_document', sourceDocument.trim());
    formData.append('source_page', sourcePage.trim());
    formData.append('hex_source', hexSource);
    formData.append('repeat_x', String(isColor ? 2 : numbers.repeat_x));
    formData.append('repeat_y', String(isColor ? 2 : numbers.repeat_y));
    formData.append('roughness', String(isColor ? 0.85 : numbers.roughness));
    formData.append('metallic', '0');
    formData.append('is_active', String(isActive));
    if (imageFile && !isColor) formData.append('image', imageFile);

    setSaving(true);
    try {
      const endpoint = initial ? `${API}/api/admin/materials/${initial.id}` : `${API}/api/admin/materials`;
      const response = await fetch(endpoint, { method: initial ? 'PUT' : 'POST', body: formData });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Material save failed (${response.status}).`);
      await onSaved();
    } catch (saveError) {
      setError(saveError?.message || 'Could not save this material.');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';
  const labelClass = 'mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400';
  const materialTypeLabel = isColor ? 'Color palette swatch' : kind === 'fabric' ? 'Fabric / Upholstery' : 'Tile / Surface Texture';

  return (
    <div className="mb-6 rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">{initial ? `Edit ${isColor ? 'palette color' : 'surface material'}` : `Add ${isColor ? 'palette color' : 'surface material'}`}</h3>
          <p className="mt-1 text-[11px] text-slate-500">Keep supplier, collection and shade references alongside the color or cropped finish sample.</p>
        </div>
        <button type="button" onClick={onCancel} className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800" aria-label="Close material form"><X className="h-4 w-4" /></button>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
          {imageError && <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{imageError}</div>}

          <div className="grid gap-3 md:grid-cols-2">
            <label><span className={labelClass}>Name *</span><input className={inputClass} value={name} onChange={event => handleNameChange(event.target.value)} placeholder="e.g. Quiet Dawn or Bouclé Ivory" maxLength={120} required /></label>
            <label><span className={labelClass}>Slug *</span><input className={`${inputClass} font-mono`} value={slug} onChange={event => { setSlugEdited(true); setSlug(slugify(event.target.value)); }} placeholder="quiet-dawn" maxLength={120} required /></label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label><span className={labelClass}>Entry type *</span><select className={inputClass} value={kind} onChange={event => handleKindChange(event.target.value)}><option value="color">Color palette / paint</option><option value="fabric">Fabric / upholstery image</option><option value="texture">Tile / surface texture image</option></select></label>
            <label><span className={labelClass}>Category</span><input className={inputClass} list="material-category-presets" value={category} onChange={event => setCategory(event.target.value)} placeholder="Paint, stone, laminate…" maxLength={80} /><datalist id="material-category-presets">{CATEGORY_PRESETS.map(option => <option key={option} value={option} />)}</datalist></label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label><span className={labelClass}>Brand / supplier</span><input className={inputClass} value={brand} onChange={event => setBrand(event.target.value)} placeholder="Asian Paints, Merino…" maxLength={120} /></label>
            <label><span className={labelClass}>Collection / range</span><input className={inputClass} value={collection} onChange={event => setCollection(event.target.value)} placeholder="Royale Play Luxe / Marmorino…" maxLength={120} /></label>
            <label><span className={labelClass}>Shade / product code</span><input className={inputClass} value={shadeCode} onChange={event => setShadeCode(event.target.value)} placeholder="e.g. 9523 or 27121 LV" maxLength={80} /></label>
            <label><span className={labelClass}>Source document</span><input className={inputClass} value={sourceDocument} onChange={event => setSourceDocument(event.target.value)} placeholder="Catalogue PDF filename" maxLength={255} /></label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label><span className={labelClass}>Source PDF page</span><input className={inputClass} type="number" min="1" max="10000" value={sourcePage} onChange={event => setSourcePage(event.target.value)} placeholder="e.g. 23" /></label>
            <label><span className={labelClass}>HEX provenance</span><select className={inputClass} value={hexSource} onChange={event => setHexSource(event.target.value)}><option value="manual">Manual / sampled by admin</option><option value="sampled_from_pdf">Sampled from PDF artwork (approximate)</option><option value="manufacturer_provided">Manufacturer-provided HEX</option></select></label>
          </div>

          <label className="block"><span className={labelClass}>Notes</span><textarea className={inputClass} rows={2} value={description} onChange={event => setDescription(event.target.value)} placeholder="Finish, application, crop notes or supplier notes…" maxLength={2000} /></label>

          {isColor ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
              <p className="mb-3 text-xs font-bold text-slate-800 dark:text-slate-200">Architectural color</p>
              <div className="flex flex-wrap items-center gap-3">
                <label className="relative h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-black/10 shadow-sm dark:border-white/10" title="Choose color">
                  <span className="absolute inset-0" style={{ backgroundColor: colorHex }} />
                  <input aria-label="Choose palette color" type="color" value={colorHex} onChange={event => setColorHex(event.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" />
                </label>
                <div className="min-w-0 flex-1">
                  <label><span className={labelClass}>HEX code *</span><input className={`${inputClass} font-mono uppercase`} value={colorHex} onChange={event => setColorHex(event.target.value.toUpperCase())} placeholder="#D8C6A8" pattern="^#[0-9A-Fa-f]{6}$" maxLength={7} required /></label>
                </div>
              </div>
              <p className="mt-3 text-[10px] leading-4 text-amber-700 dark:text-amber-300">Brochure colors are approximate on-screen matches unless the supplier explicitly provides the HEX value. Printed shade cards and applied finishes can vary.</p>
            </div>
          ) : (
            <div className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50 sm:grid-cols-2">
              <div>
                <p className="mb-3 text-xs font-bold text-slate-800 dark:text-slate-200">Texture scale</p>
                <div className="grid grid-cols-2 gap-3">
                  <label><span className={labelClass}>Repeat X</span><input className={inputClass} type="number" min="0.05" max="100" step="0.25" value={repeatX} onChange={event => setRepeatX(event.target.value)} required /></label>
                  <label><span className={labelClass}>Repeat Y</span><input className={inputClass} type="number" min="0.05" max="100" step="0.25" value={repeatY} onChange={event => setRepeatY(event.target.value)} required /></label>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-slate-500">Crop the material sample from the catalogue, without page labels or borders, then upload it below.</p>
              </div>
              <div>
                <p className="mb-3 text-xs font-bold text-slate-800 dark:text-slate-200">Surface response</p>
                <div className="max-w-xs"><label><span className={labelClass}>Roughness</span><input className={inputClass} type="number" min="0" max="1" step="0.05" value={roughness} onChange={event => setRoughness(event.target.value)} required /></label></div>
                <p className="mt-2 text-[10px] leading-4 text-slate-500">Fabric usually needs high roughness; adjust the repeat to match the physical weave or pattern size.</p>
              </div>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={isActive} onChange={event => setIsActive(event.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" /><span><strong>Available in BIM editor</strong><span className="ml-1 text-slate-400">— inactive entries remain in Admin but are hidden from selection.</span></span></label>
        </div>

        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex aspect-square items-center justify-center overflow-hidden" style={{ backgroundColor: isColor ? colorHex : '#e2e8f0' }}>
              {isColor ? <div className="rounded-lg bg-white/75 px-3 py-2 font-mono text-sm font-bold text-slate-800 shadow-sm">{colorHex}</div> : displayedPreview ? <img src={displayedPreview} alt="Material texture preview" className="h-full w-full object-cover" /> : <div className="flex flex-col items-center gap-2 text-slate-400"><ImageIcon className="h-10 w-10" /><span className="text-[11px]">Image preview</span></div>}
            </div>
            <div className="border-t border-slate-200 p-3 dark:border-slate-800"><div className="text-xs font-bold text-slate-800 dark:text-slate-200">{name || 'Untitled entry'}</div><div className="mt-1 text-[10px] text-slate-500">{materialTypeLabel} · {category || 'Uncategorised'}</div>{brand && <div className="mt-1 text-[10px] text-slate-500">{brand}{collection ? ` · ${collection}` : ''}</div>}{shadeCode && <div className="mt-1 font-mono text-[10px] text-slate-500">{shadeCode}</div>}</div>
          </div>
          {!isColor && <>
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-indigo-300 bg-indigo-50/60 px-4 py-5 text-center transition hover:border-indigo-500 hover:bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/5 dark:hover:bg-indigo-500/10">
              <UploadCloud className="h-6 w-6 text-indigo-600 dark:text-indigo-300" />
              <span className="text-xs font-bold text-indigo-700 dark:text-indigo-200">{imageFile ? 'Replace selected image' : initial?.texture_url ? 'Replace texture image' : 'Choose cropped material image *'}</span>
              <span className="text-[10px] text-slate-500">PNG, JPG or WebP · max 10 MB</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" onChange={event => handleImageChange(event.target.files?.[0])} className="sr-only" />
            </label>
            {imageFile && <div className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[10px] text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"><span className="truncate">{imageFile.name}</span><span className="shrink-0">{(imageFile.size / 1024 / 1024).toFixed(2)} MB</span></div>}
            {initial?.texture_url && !imageFile && <p className="break-all text-[10px] text-slate-400">Current asset: {initial.texture_url}</p>}
          </>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800 xl:col-span-2">
          <button type="button" onClick={onCancel} disabled={saving} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={saving || Boolean(imageError)} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}{saving ? 'Saving…' : initial ? 'Save changes' : isColor ? 'Save palette color' : 'Upload material'}</button>
        </div>
      </form>
    </div>
  );
}

function MaterialCard({ material, onEdit, onToggle, onDelete }) {
  const isColor = material.kind === 'color';
  return (
    <article className={`group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 ${material.is_active ? '' : 'opacity-60'}`}>
      <div className="relative aspect-[4/3] overflow-hidden" style={{ backgroundColor: isColor ? material.color_hex || '#FFFFFF' : '#f1f5f9' }}>
        {isColor ? <div className="absolute inset-x-0 bottom-0 bg-white/80 px-3 py-2 font-mono text-xs font-bold text-slate-800">{String(material.color_hex || '#FFFFFF').trim().toUpperCase()}</div> : material.texture_url ? <img src={assetUrl(material.texture_url)} alt={material.name} className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]" /> : <div className="flex h-full items-center justify-center text-slate-400"><ImageIcon className="h-9 w-9" /></div>}
        <div className="absolute left-2 top-2 flex gap-1.5"><span className={`rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-white ${isColor ? 'bg-emerald-700' : material.kind === 'fabric' ? 'bg-violet-600' : 'bg-indigo-600'}`}>{isColor ? 'Color palette' : material.kind === 'fabric' ? 'Fabric' : 'Texture'}</span>{!material.is_active && <span className="rounded-md bg-amber-500 px-2 py-1 text-[9px] font-bold uppercase text-white">Inactive</span>}</div>
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/55 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button type="button" onClick={() => onToggle(material)} title={material.is_active ? 'Hide in editor' : 'Show in editor'} className="rounded-lg bg-white p-2 text-amber-600 transition hover:bg-amber-50"><Power className="h-4 w-4" /></button>
          <button type="button" onClick={() => onEdit(material)} title="Edit entry" className="rounded-lg bg-white p-2 text-slate-700 transition hover:bg-indigo-50"><Pencil className="h-4 w-4" /></button>
          <button type="button" onClick={() => onDelete(material)} title="Delete library entry" className="rounded-lg bg-white p-2 text-rose-600 transition hover:bg-rose-50"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex min-w-0 items-start gap-2"><span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border border-black/10" style={{ backgroundColor: material.color_hex || '#FFFFFF' }} /><div className="min-w-0 flex-1"><h3 className="truncate text-xs font-bold text-slate-800 dark:text-slate-100">{material.name}</h3><p className="mt-0.5 truncate text-[10px] text-slate-500">{material.category}</p></div></div>
        {(material.brand || material.collection || material.shade_code) && <p className="line-clamp-2 text-[10px] leading-4 text-slate-500">{[material.brand, material.collection, material.shade_code].filter(Boolean).join(' · ')}</p>}
        {isColor ? <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[9px] text-slate-500 dark:border-slate-800"><span>{material.hex_source === 'manufacturer_provided' ? 'Manufacturer HEX' : material.hex_source === 'sampled_from_pdf' ? 'PDF sample · approximate' : 'Manual HEX'}</span><span>{material.source_page ? `PDF p. ${material.source_page}` : ''}</span></div> : <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[9px] text-slate-500 dark:border-slate-800"><span>Repeat {Number(material.repeat_x).toFixed(2)} × {Number(material.repeat_y).toFixed(2)}</span><span>Rough {Number(material.roughness).toFixed(2)}</span></div>}
        {material.description && <p className="line-clamp-2 text-[10px] leading-4 text-slate-500">{material.description}</p>}
      </div>
    </article>
  );
}

export function AdminMaterialsPanel() {
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [showCatalogueImport, setShowCatalogueImport] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const fetchMaterials = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API}/api/admin/materials`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Could not load materials (${response.status}).`);
      setMaterials(Array.isArray(payload) ? payload : []);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load the material library.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMaterials(); }, [fetchMaterials]);

  const handleSaved = async () => {
    setShowForm(false);
    setEditing(null);
    setNotice('Material library updated. Active materials are available in the BIM editor.');
    await fetchMaterials();
  };

  const handleToggle = async (material) => {
    setBusyId(material.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API}/api/admin/materials/${material.id}/toggle`, { method: 'PATCH' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not update material status.');
      setNotice(`${material.name} is now ${payload.is_active ? 'available' : 'hidden'} in the BIM editor.`);
      await fetchMaterials();
    } catch (toggleError) {
      setError(toggleError?.message || 'Could not update material status.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    setError('');
    try {
      const response = await fetch(`${API}/api/admin/materials/${deleteTarget.id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not delete material.');
      setDeleteTarget(null);
      setNotice('Library entry removed. Its image file is retained so previously saved projects can still render.');
      await fetchMaterials();
    } catch (deleteError) {
      setError(deleteError?.message || 'Could not delete material.');
    } finally {
      setBusyId(null);
    }
  };

  const filteredMaterials = useMemo(() => materials.filter(material => {
    const matchesKind = kindFilter === 'all' || material.kind === kindFilter;
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? material.is_active : !material.is_active);
    const query = search.trim().toLowerCase();
    const matchesQuery = !query || [material.name, material.slug, material.category, material.description, material.brand, material.collection, material.shade_code, material.color_hex].some(value => String(value || '').toLowerCase().includes(query));
    return matchesKind && matchesStatus && matchesQuery;
  }), [materials, kindFilter, statusFilter, search]);

  return (
    <div className="mx-auto max-w-[1600px] p-5 md:p-7">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200"><Layers3 className="h-3.5 w-3.5" /> Material Library</div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">Architectural color palettes & surface materials</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">Manage HEX palette swatches, fabrics, laminates and surface textures in one library. Upload a catalogue PDF to detect sample tiles in bulk, review/rename each crop, and publish the selected entries into the same library.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { setShowCatalogueImport(value => !value); setShowForm(false); setEditing(null); setError(''); }} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-xs font-bold text-indigo-700 shadow-sm transition hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200 dark:hover:bg-indigo-500/20"><FileUp className="h-4 w-4" /> Upload PDF catalogue</button>
          <button type="button" onClick={() => { setEditing(null); setShowForm(value => !value); setShowCatalogueImport(false); setError(''); }} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-indigo-700"><Plus className="h-4 w-4" /> Add palette / material</button>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {notice && <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{notice}</div>}

      {showCatalogueImport && <CataloguePdfImport onClose={() => setShowCatalogueImport(false)} onImported={async count => { setNotice(`Imported ${count} catalogue sample${count === 1 ? '' : 's'}. Active entries are available in the BIM editor.`); await fetchMaterials(); }} />}

      {(showForm || editing) && <MaterialForm key={editing?.id || 'new-material'} initial={editing} onCancel={() => { setShowForm(false); setEditing(null); }} onSaved={handleSaved} />}

      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search materials by name, slug or category…" className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-950" /></div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Material type filter" value={kindFilter} onChange={event => setKindFilter(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"><option value="all">All types</option><option value="color">Color palette</option><option value="fabric">Fabric</option><option value="texture">Tile / Texture</option></select>
          <select aria-label="Material status filter" value={statusFilter} onChange={event => setStatusFilter(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
          <button type="button" onClick={fetchMaterials} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"><RotateCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between"><p className="text-xs text-slate-500">{filteredMaterials.length} of {materials.length} material{materials.length === 1 ? '' : 's'}</p><p className="text-[10px] text-slate-400">Texture images normalize to WebP · brochure HEX values are marked approximate</p></div>

      {loading ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-xs text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading material library…</div>
      ) : filteredMaterials.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {filteredMaterials.map(material => <div key={material.id} className={busyId === material.id ? 'pointer-events-none opacity-50' : ''}><MaterialCard material={material} onEdit={target => { setShowForm(false); setEditing(target); setError(''); }} onToggle={handleToggle} onDelete={setDeleteTarget} /></div>)}
        </div>
      ) : (
        <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
          <div className="mb-3 rounded-2xl bg-indigo-50 p-3 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"><ImageIcon className="h-6 w-6" /></div>
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{materials.length ? 'No matching entries' : 'Your palette and material library is empty'}</h3>
          <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">{materials.length ? 'Try changing the search or filters.' : 'Add a HEX color directly or upload a cropped fabric/tile/laminate sample. Active entries appear in the BIM editor under Properties → Design → Surface Finish.'}</p>
          {!materials.length && <button type="button" onClick={() => { setEditing(null); setShowForm(true); }} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-indigo-700"><Plus className="h-3.5 w-3.5" /> Add first entry</button>}
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="delete-material-title" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
            <h3 id="delete-material-title" className="text-sm font-bold text-slate-900 dark:text-white">Remove “{deleteTarget.name}” from the library?</h3>
            <p className="mt-2 text-xs leading-5 text-slate-500">The material will no longer appear in the BIM editor. Its image file will be retained so saved projects that already reference it can continue to render.</p>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDeleteTarget(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300">Cancel</button><button type="button" disabled={busyId === deleteTarget.id} onClick={handleDelete} className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-rose-700 disabled:opacity-50">{busyId === deleteTarget.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Remove from library</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
