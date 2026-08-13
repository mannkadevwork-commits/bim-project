import { useState, useEffect, useCallback } from 'react';
import { AdminCategoryTree } from '../components/admin/AdminCategoryTree';
import { AdminItemsPanel } from '../components/admin/AdminItemsPanel';
import { ShieldCheck, ArrowLeft } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function AdminPanel() {
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/admin/categories`);
      const data = await res.json();
      setCategories(data);
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
        <h1 className="text-base font-bold text-slate-800 dark:text-white">Catalog Admin</h1>
        <a href="/" className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Viewer
        </a>
      </div>
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
    </div>
  );
}
