import { useState } from 'react';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, FolderOpen, Folder, Loader2 } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function CategoryForm({ initial, categories, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || '');
  const [slug, setSlug] = useState(initial?.slug || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [parentId, setParentId] = useState(initial?.parent_id || '');
  const [thumbnail, setThumbnail] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleNameChange = (val) => {
    setName(val);
    if (!initial) setSlug(val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) { setError('Name and slug are required'); return; }
    setSaving(true);
    setError('');
    const fd = new FormData();
    fd.append('name', name.trim());
    fd.append('slug', slug.trim());
    fd.append('description', description.trim());
    if (parentId) fd.append('parent_id', parentId);
    if (thumbnail) fd.append('thumbnail', thumbnail);
    try {
      const url = initial ? `${API}/api/admin/categories/${initial.id}` : `${API}/api/admin/categories`;
      const res = await fetch(url, { method: initial ? 'PUT' : 'POST', body: fd });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Save failed'); }
      onSave();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const parentOptions = categories.filter(c => !initial || c.id !== initial.id);

  return (
    <form onSubmit={handleSubmit} className="p-4 space-y-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
      <p className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
        {initial ? 'Edit Category' : 'New Category'}
      </p>
      {error && <p className="text-xs text-rose-500 bg-rose-50 dark:bg-rose-900/20 px-2 py-1 rounded">{error}</p>}
      <div className="space-y-2">
        <input type="text" placeholder="Name *" value={name} onChange={e => handleNameChange(e.target.value)}
          className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400" required />
        <input type="text" placeholder="Slug *" value={slug} onChange={e => setSlug(e.target.value)}
          className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400 font-mono" required />
        <textarea placeholder="Description (optional)" value={description} onChange={e => setDescription(e.target.value)} rows={2}
          className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400 resize-none" />
        <select value={parentId} onChange={e => setParentId(e.target.value)}
          className="w-full text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400">
          <option value="">— No parent (root category) —</option>
          {parentOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div>
          <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-1">Thumbnail image (optional)</label>
          <input type="file" accept="image/*" onChange={e => setThumbnail(e.target.files[0])}
            className="w-full text-xs text-slate-600 dark:text-slate-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 cursor-pointer" />
          {initial?.image_url && !thumbnail && (
            <img src={initial.image_url} alt="current" className="mt-1 w-12 h-12 object-cover rounded border border-slate-200 dark:border-slate-700" />
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving}
          className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1">
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {initial ? 'Save Changes' : 'Create Category'}
        </button>
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}

function CategoryRow({ cat, depth, categories, selectedCategoryId, onSelect, onEdit, onDelete, children }) {
  const [open, setOpen] = useState(depth === 0);
  const childArray = Array.isArray(children) ? children.filter(Boolean) : (children ? [children] : []);
  const hasChildren = childArray.length > 0;

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 py-1.5 pr-2 rounded-lg mx-1 transition-colors cursor-pointer group
          ${selectedCategoryId === cat.id ? 'bg-indigo-50 dark:bg-indigo-900/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onSelect(cat.id)}
      >
        <button onClick={e => { e.stopPropagation(); setOpen(o => !o); }} className="w-4 h-4 shrink-0 text-slate-400 hover:text-slate-600">
          {hasChildren ? (open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />) : <span className="w-3.5 h-3.5 block" />}
        </button>
        {open ? <FolderOpen className="w-3.5 h-3.5 text-indigo-400 shrink-0" /> : <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
        <span className={`flex-1 text-xs truncate ${selectedCategoryId === cat.id ? 'font-bold text-indigo-700 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-300'}`}>
          {cat.name}
        </span>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={e => { e.stopPropagation(); onEdit(cat); }} className="p-1 rounded hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-slate-400 hover:text-indigo-600 transition-colors" title="Edit">
            <Pencil className="w-3 h-3" />
          </button>
          <button onClick={e => { e.stopPropagation(); onDelete(cat); }} className="p-1 rounded hover:bg-rose-100 dark:hover:bg-rose-900/40 text-slate-400 hover:text-rose-600 transition-colors" title="Delete">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

export function AdminCategoryTree({ categories, loading, selectedCategoryId, onSelect, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await fetch(`${API}/api/admin/categories/${deleteTarget.id}`, { method: 'DELETE' });
      onRefresh();
      setDeleteTarget(null);
    } catch (err) {
      console.error('[Admin] Delete category failed:', err);
    } finally {
      setDeleting(false);
    }
  };

  const handleSaved = () => { setShowForm(false); setEditingCategory(null); onRefresh(); };

  const buildTree = (items, parentId = null) =>
    items.filter(c => (c.parent_id ?? null) === parentId).map(c => ({ ...c, children: buildTree(items, c.id) }));

  const renderTree = (nodes, depth = 0) =>
    nodes.map(node => (
      <CategoryRow key={node.id} cat={node} depth={depth} categories={categories}
        selectedCategoryId={selectedCategoryId} onSelect={onSelect}
        onEdit={cat => { setEditingCategory(cat); setShowForm(true); }}
        onDelete={setDeleteTarget}>
        {renderTree(node.children, depth + 1)}
      </CategoryRow>
    ));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Categories</span>
        <button onClick={() => { setEditingCategory(null); setShowForm(s => !s); }}
          className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-semibold transition-colors cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>
      {showForm && (
        <CategoryForm initial={editingCategory} categories={categories} onSave={handleSaved}
          onCancel={() => { setShowForm(false); setEditingCategory(null); }} />
      )}
      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="flex items-center justify-center h-20 text-slate-400 gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /><span className="text-xs">Loading...</span>
          </div>
        ) : renderTree(buildTree(categories))}
      </div>
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-6 w-80">
            <p className="text-sm font-bold text-slate-800 dark:text-white mb-2">Delete "{deleteTarget.name}"?</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">This will also delete all sub-categories and items inside it. Cannot be undone.</p>
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
