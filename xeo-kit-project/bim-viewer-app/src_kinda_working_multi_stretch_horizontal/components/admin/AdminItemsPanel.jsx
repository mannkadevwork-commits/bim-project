import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Loader2, Box, FileBox, X, Sparkles } from 'lucide-react';
import { generateGlbThumbnail } from '../../utils/glbThumbnail';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const assetUrl = (url) => (url && url.startsWith('/') ? `${API}${url}` : url);

function rgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return '#cccccc';
  const [r, g, b] = rgb.map(v => Math.round(v * 255));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [parseFloat(r.toFixed(3)), parseFloat(g.toFixed(3)), parseFloat(b.toFixed(3))];
}

function ItemForm({ initial, categories, categoryId, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || '');
  const [slug, setSlug] = useState(initial?.slug || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [catId, setCatId] = useState(initial?.category_id || categoryId || '');
  const [colorHex, setColorHex] = useState(rgbToHex(initial?.color_rgb));
  const [attributes, setAttributes] = useState(initial?.attributes ? JSON.stringify(initial.attributes, null, 2) : '{}');
  const [thumbnail, setThumbnail] = useState(null);
  const [thumbnailPreview, setThumbnailPreview] = useState(null);
  const [modelFile, setModelFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState('');
  const [generatingThumb, setGeneratingThumb] = useState(false);

  const handleModelChange = async (file) => {
    setModelFile(file);
    if (!file || !file.name.toLowerCase().endsWith('.glb')) return;
    if (thumbnail) return; // don't overwrite a manually chosen thumbnail
    setGeneratingThumb(true);
    try {
      const blob = await generateGlbThumbnail(file);
      const previewUrl = URL.createObjectURL(blob);
      setThumbnailPreview(previewUrl);
      setThumbnail(new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' }));
    } catch (e) {
      console.warn('GLB thumbnail generation failed:', e);
    } finally {
      setGeneratingThumb(false);
    }
  };

  const handleThumbnailChange = (file) => {
    setThumbnail(file);
    if (file) setThumbnailPreview(URL.createObjectURL(file));
  };

  const handleNameChange = (val) => {
    setName(val);
    if (!initial) setSlug(val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) { setError('Name and slug are required'); return; }
    if (!initial && !modelFile) { setError('Model file (.ifc or .glb) is required'); return; }
    try { JSON.parse(attributes); } catch { setError('Attributes must be valid JSON'); return; }

    setSaving(true);
    setError('');
    setUploadProgress('Uploading...');
    const fd = new FormData();
    fd.append('name', name.trim());
    fd.append('slug', slug.trim());
    fd.append('description', description.trim());
    fd.append('category_id', catId);
    fd.append('color_rgb', JSON.stringify(hexToRgb(colorHex)));
    fd.append('attributes', attributes);
    if (thumbnail) fd.append('thumbnail', thumbnail);
    if (modelFile) fd.append('model', modelFile);

    try {
      const url = initial ? `${API}/api/admin/items/${initial.id}` : `${API}/api/admin/items`;
      const res = await fetch(url, { method: initial ? 'PUT' : 'POST', body: fd });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Save failed'); }
      setUploadProgress('');
      onSave();
    } catch (err) {
      setError(err.message);
      setUploadProgress('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-bold text-slate-800 dark:text-white">{initial ? 'Edit Item' : 'Add New Item'}</p>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      {error && <p className="text-xs text-rose-500 bg-rose-50 dark:bg-rose-900/20 px-3 py-2 rounded-lg mb-3">{error}</p>}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">Name *</label>
            <input type="text" value={name} onChange={e => handleNameChange(e.target.value)} placeholder="e.g. Traditional Sofa"
              className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400" required />
          </div>
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">Slug *</label>
            <input type="text" value={slug} onChange={e => setSlug(e.target.value)} placeholder="e.g. sofa-traditional"
              className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400 font-mono" required />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">Category *</label>
            <select value={catId} onChange={e => setCatId(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400" required>
              <option value="">— Select category —</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">Display Color</label>
            <div className="flex items-center gap-2">
              <input type="color" value={colorHex} onChange={e => setColorHex(e.target.value)}
                className="w-10 h-8 rounded border border-slate-200 dark:border-slate-700 cursor-pointer bg-transparent" />
              <span className="text-xs font-mono text-slate-500">{colorHex}</span>
            </div>
          </div>
        </div>
        <div>
          <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">Description</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description..." rows={2}
            className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400 resize-none" />
        </div>
        <div>
          <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">Attributes (JSON)</label>
          <textarea value={attributes} onChange={e => setAttributes(e.target.value)} rows={3}
            className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400 resize-none font-mono" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">
              Thumbnail {initial ? '(blank = keep current)' : '(optional)'}
            </label>
            <input type="file" accept="image/*" onChange={e => handleThumbnailChange(e.target.files[0])}
              className="w-full text-xs text-slate-600 dark:text-slate-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 cursor-pointer" />
            {generatingThumb && (
              <div className="mt-1 flex items-center gap-1 text-[10px] text-indigo-500">
                <Loader2 className="w-3 h-3 animate-spin" /> Generating from GLB...
              </div>
            )}
            {thumbnailPreview && !generatingThumb && (
              <div className="mt-1 relative w-12 h-12">
                <img src={thumbnailPreview} alt="preview" className="w-12 h-12 object-cover rounded border border-slate-200 dark:border-slate-700" />
                <span className="absolute -top-1 -right-1 bg-indigo-500 rounded-full p-0.5"><Sparkles className="w-2 h-2 text-white" /></span>
              </div>
            )}
            {initial?.thumbnail_url && !thumbnailPreview && (
              <img src={assetUrl(initial.thumbnail_url)} alt="current" className="mt-1 w-12 h-12 object-cover rounded border border-slate-200 dark:border-slate-700" />
            )}
          </div>
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">
              Model (.ifc or .glb) {initial ? '(blank = keep current)' : '*'} <span className="text-slate-400">max 400MB</span>
            </label>
            <input type="file" accept=".ifc,.glb" onChange={e => handleModelChange(e.target.files[0])}
              className="w-full text-xs text-slate-600 dark:text-slate-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 cursor-pointer" />
            {initial?.model_url && !modelFile && (
              <p className="mt-1 text-[10px] text-slate-400 font-mono truncate">{initial.model_url}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={saving || generatingThumb}
            className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {uploadProgress || (initial ? 'Save Changes' : 'Create Item')}
          </button>
          <button type="button" onClick={onCancel}
            className="px-4 py-2 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function ItemCard({ item, onEdit, onDelete }) {
  const [imgFailed, setImgFailed] = useState(false);
  const rgb = item.color_rgb;
  const colorStyle = Array.isArray(rgb)
    ? { backgroundColor: `rgb(${Math.round(rgb[0]*255)},${Math.round(rgb[1]*255)},${Math.round(rgb[2]*255)})` }
    : {};

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-900 group">
      <div className="w-full h-28 bg-slate-100 dark:bg-slate-800 relative overflow-hidden">
        {item.thumbnail_url && !imgFailed ? (
          <img src={assetUrl(item.thumbnail_url)} alt={item.name} onError={() => setImgFailed(true)} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-300 dark:text-slate-600">
            {item.file_type === 'glb' ? <FileBox className="w-8 h-8" /> : <Box className="w-8 h-8" />}
          </div>
        )}
        <span className={`absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${item.file_type === 'glb' ? 'bg-violet-600 text-white' : 'bg-indigo-600 text-white'}`}>
          {item.file_type}
        </span>
        <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
          <button onClick={() => onEdit(item)} className="p-2 bg-white/90 hover:bg-white rounded-lg text-slate-700 transition-colors" title="Edit">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDelete(item)} className="p-2 bg-white/90 hover:bg-rose-50 rounded-lg text-rose-600 transition-colors" title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="px-3 py-2 flex items-center gap-2">
        <span className="w-3 h-3 rounded-full border border-slate-200 dark:border-slate-600 shrink-0" style={colorStyle} />
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate flex-1">{item.name}</span>
      </div>
      {item.attributes && Object.keys(item.attributes).length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {Object.entries(item.attributes).slice(0, 3).map(([k, v]) => (
            <span key={k} className="text-[9px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-1.5 py-0.5 rounded font-mono">{k}: {String(v)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminItemsPanel({ categoryId, categories, onRefresh }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchItems = useCallback(async () => {
    if (!categoryId) { setItems([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/admin/items?category_id=${categoryId}`);
      setItems(await res.json());
    } catch (err) {
      console.error('[Admin] Failed to fetch items:', err);
    } finally {
      setLoading(false);
    }
  }, [categoryId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await fetch(`${API}/api/admin/items/${deleteTarget.id}`, { method: 'DELETE' });
      fetchItems();
      setDeleteTarget(null);
    } catch (err) {
      console.error('[Admin] Delete item failed:', err);
    } finally {
      setDeleting(false);
    }
  };

  const handleSaved = () => { setShowForm(false); setEditingItem(null); fetchItems(); };
  const selectedCategoryName = categories.find(c => c.id === categoryId)?.name;

  if (!categoryId) {
    return <div className="flex items-center justify-center h-full text-slate-400 text-sm">← Select a category to manage its items</div>;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-bold text-slate-800 dark:text-white">{selectedCategoryName}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{items.length} item{items.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => { setEditingItem(null); setShowForm(s => !s); }}
          className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Add Item
        </button>
      </div>
      {(showForm || editingItem) && (
        <ItemForm initial={editingItem} categories={categories} categoryId={categoryId}
          onSave={handleSaved} onCancel={() => { setShowForm(false); setEditingItem(null); }} />
      )}
      {loading ? (
        <div className="flex items-center justify-center h-32 text-slate-400 gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /><span className="text-xs">Loading items...</span>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 text-slate-400 gap-2">
          <Box className="w-8 h-8 opacity-30" />
          <p className="text-xs">No items yet. Click "Add Item" to upload one.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {items.map(item => (
            <ItemCard key={item.id} item={item}
              onEdit={item => { setEditingItem(item); setShowForm(false); }}
              onDelete={setDeleteTarget} />
          ))}
        </div>
      )}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-6 w-80">
            <p className="text-sm font-bold text-slate-800 dark:text-white mb-2">Delete "{deleteTarget.name}"?</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">This removes the item from the catalog. The model file on disk is not deleted.</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 py-2 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-50 transition-colors">Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="flex-1 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1">
                {deleting && <Loader2 className="w-3 h-3 animate-spin" />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
