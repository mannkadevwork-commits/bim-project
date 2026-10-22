import { useState, useEffect, useCallback } from 'react';
import { AdminCategoryTree } from '../components/admin/AdminCategoryTree';
import { AdminItemsPanel } from '../components/admin/AdminItemsPanel';
import { AdminMaterialsPanel } from '../components/admin/AdminMaterialsPanel';
import { ShieldCheck, ArrowLeft, Boxes, Layers3 } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function AdminPanel() {
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adminView, setAdminView] = useState('catalog');

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/admin/categories`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Category request failed (${res.status})`);
      const data = await res.json();
      setCategories(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[Admin] Failed to fetch categories:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  return (
    <div className="flex flex-col h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
        <ShieldCheck className="w-5 h-5 text-indigo-600" />
        <div>
          <h1 className="text-base font-bold text-slate-800 dark:text-white">Catalog Admin</h1>
          <p className="mt-0.5 text-[10px] text-slate-400">Manage placeable assets and reusable surface materials</p>
        </div>
        <a href="/" className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Viewer
        </a>
      </div>

      <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 shrink-0">
        <button
          type="button"
          onClick={() => setAdminView('catalog')}
          className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-bold transition-colors ${adminView === 'catalog' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
        >
          <Boxes className="w-4 h-4" /> GLB / IFC Catalog
        </button>
        <button
          type="button"
          onClick={() => setAdminView('materials')}
          className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-bold transition-colors ${adminView === 'materials' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
        >
          <Layers3 className="w-4 h-4" /> Color Palettes & Materials
          <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold ${adminView === 'materials' ? 'bg-white/20 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>HEX · Fabric · Tile · Texture</span>
        </button>
      </div>

      {adminView === 'catalog' ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="w-72 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-y-auto">
            <AdminCategoryTree
              categories={categories}
              loading={loading}
              selectedCategoryId={selectedCategoryId}
              onSelect={setSelectedCategoryId}
              onRefresh={fetchCategories}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            <AdminItemsPanel
              categoryId={selectedCategoryId}
              categories={categories}
              onRefresh={fetchCategories}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <AdminMaterialsPanel />
        </div>
      )}
    </div>
  );
}
