import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronDown, FolderOpen, Plus } from 'lucide-react';

const NEW_PROJECT = '__new_project__';
const NEW_SUBCATEGORY = '__new_subcategory__';

const normalize = (value) => String(value || '').trim();

export const inferFloorplanCategory = (fileName) => {
  const value = String(fileName || '').toLowerCase().replace(/[_.-]+/g, ' ');
  const match = value.match(/\b([1-9][0-9]?)\s*bhk\b/);
  if (match) return `${match[1]} BHK`;
  return null;
};

export const buildLayoutMetadataLabel = (layout) => {
  if (!layout) return '';
  const category = normalize(layout.categoryName);
  const sub = normalize(layout.subCategory);
  if (!category && !sub) return 'Uncategorized';
  return [category, sub].filter(Boolean).join(' · ');
};

export const LayoutMetadataForm = ({
  mode = 'create',
  fileName = '',
  existingLayouts = [],
  initialValue = null,
  submitting = false,
  onSubmit,
  onCancel,
}) => {
  const inferredCategory = useMemo(() => inferFloorplanCategory(fileName), [fileName]);
  const projectOptions = useMemo(() => {
    const values = new Set();
    (existingLayouts || []).forEach((layout) => {
      if (layout?.categoryType === 'project' && normalize(layout.categoryName)) {
        values.add(normalize(layout.categoryName));
      }
    });
    if (initialValue?.categoryType === 'project' && normalize(initialValue.categoryName)) {
      values.add(normalize(initialValue.categoryName));
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [existingLayouts, initialValue]);

  const [categoryType, setCategoryType] = useState(
    initialValue?.categoryType || (inferredCategory ? 'floorplan' : 'project')
  );
  const [categoryName, setCategoryName] = useState(
    initialValue?.categoryName || inferredCategory || ''
  );
  const [newProjectName, setNewProjectName] = useState('');
  const [subCategory, setSubCategory] = useState(initialValue?.subCategory || '');
  const [newSubCategory, setNewSubCategory] = useState('');
  const [layoutName, setLayoutName] = useState(initialValue?.name || '');

  useEffect(() => {
    if (mode !== 'edit' || !initialValue) return;
    setCategoryType(initialValue.categoryType || (inferredCategory ? 'floorplan' : 'project'));
    setCategoryName(initialValue.categoryName || inferredCategory || '');
    setSubCategory(initialValue.subCategory || '');
    setLayoutName(initialValue.name || '');
  }, [mode, initialValue, inferredCategory]);

  useEffect(() => {
    if (categoryType === 'floorplan' && !categoryName && inferredCategory) {
      setCategoryName(inferredCategory);
    }
  }, [categoryType, categoryName, inferredCategory]);

  const resolvedProjectName = categoryType === 'project'
    ? normalize(categoryName === NEW_PROJECT ? newProjectName : categoryName)
    : '';

  const resolvedSubCategory = normalize(
    subCategory === NEW_SUBCATEGORY ? newSubCategory : subCategory
  );

  const subCategoryOptions = useMemo(() => {
    const selectedCategory = categoryType === 'project' ? resolvedProjectName : normalize(categoryName);
    if (!selectedCategory) return [];

    const values = new Set();
    (existingLayouts || []).forEach((layout) => {
      const sameType = (layout?.categoryType || '') === categoryType;
      const sameCategory = normalize(layout?.categoryName) === selectedCategory;
      if (sameType && sameCategory && normalize(layout?.subCategory)) {
        values.add(normalize(layout.subCategory));
      }
    });
    if (mode === 'edit' && normalize(initialValue?.subCategory)) {
      values.add(normalize(initialValue.subCategory));
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [existingLayouts, categoryType, categoryName, resolvedProjectName, mode, initialValue]);

  const categoryReady = categoryType === 'floorplan'
    ? !!normalize(categoryName)
    : !!resolvedProjectName;
  const subCategoryReady = categoryReady && !!resolvedSubCategory;
  const nameReady = !!normalize(layoutName);
  const canSubmit = categoryReady && subCategoryReady && nameReady && !submitting;

  const handleCategoryTypeChange = (nextType) => {
    setCategoryType(nextType);
    setSubCategory('');
    setNewSubCategory('');
    if (nextType === 'floorplan') {
      setCategoryName(inferredCategory || initialValue?.categoryName || '');
      setNewProjectName('');
    } else {
      const existing = initialValue?.categoryType === 'project' ? initialValue.categoryName : '';
      setCategoryName(existing || '');
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit?.({
      name: normalize(layoutName),
      categoryType,
      categoryName: categoryType === 'project' ? resolvedProjectName : normalize(categoryName),
      subCategory: resolvedSubCategory,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">1 · Category</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Choose the top-level group for this saved layout.</p>
          </div>
          {categoryReady && <Check className="h-4 w-4 text-emerald-500" />}
        </div>

        {categoryType === 'project' ? (
          <div className="rounded-xl border border-indigo-200/80 bg-indigo-50/70 p-3 dark:border-indigo-900/50 dark:bg-indigo-950/25">
            <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-300">Project Name</label>
            <div className="relative">
              <select
                value={categoryName || ''}
                onChange={(event) => { setCategoryName(event.target.value); setSubCategory(''); }}
                className="w-full appearance-none rounded-xl border border-indigo-200 bg-white px-3 py-3 pr-9 text-sm font-semibold text-slate-800 outline-none focus:border-indigo-500 dark:border-indigo-800 dark:bg-slate-900 dark:text-white"
              >
                <option value="">Select project name</option>
                {projectOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                <option value={NEW_PROJECT}>+ Enter new project name</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
            {categoryName === NEW_PROJECT && (
              <div className="mt-2 flex items-center gap-2">
                <FolderOpen className="h-4 w-4 shrink-0 text-indigo-500" />
                <input value={newProjectName} onChange={(event) => { setNewProjectName(event.target.value); setSubCategory(''); }} placeholder="e.g. Villa" maxLength={60} autoFocus className="min-w-0 flex-1 rounded-lg border border-indigo-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-500 dark:border-indigo-800 dark:bg-slate-900 dark:text-white" />
              </div>
            )}
          </div>
        ) : (
          <div className="relative">
            <select
              value={categoryType}
              onChange={(event) => handleCategoryTypeChange(event.target.value)}
              className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-3 pr-9 text-sm font-semibold text-slate-800 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            >
              <option value="floorplan">{inferredCategory || initialValue?.categoryName || 'Floor Plan'}</option>
              <option value="project">Project</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        )}
      </div>

      {categoryType === 'floorplan' && (
        <div>
          <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Floor plan</label>
          <div className="relative">
            <select
              value={categoryName}
              onChange={(event) => { setCategoryName(event.target.value); setSubCategory(''); }}
              className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-3 pr-9 text-sm font-semibold text-slate-800 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            >
              <option value="">Select floor plan</option>
              {inferredCategory && <option value={inferredCategory}>{inferredCategory}</option>}
              {!inferredCategory && initialValue?.categoryType === 'floorplan' && <option value={initialValue.categoryName}>{initialValue.categoryName}</option>}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>
)}

      {categoryReady && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">2 · Sub-category</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Reuse an existing sub-category or create a new one.</p>
            </div>
            {subCategoryReady && <Check className="h-4 w-4 text-emerald-500" />}
          </div>
          <div className="relative">
            <select
              value={subCategory}
              onChange={(event) => setSubCategory(event.target.value)}
              className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-3 pr-9 text-sm font-semibold text-slate-800 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            >
              <option value="">Select sub-category</option>
              {subCategoryOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              <option value={NEW_SUBCATEGORY}>+ Enter new sub-category</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
          {subCategory === NEW_SUBCATEGORY && (
            <div className="mt-2 flex items-center gap-2">
              <Plus className="h-4 w-4 shrink-0 text-indigo-500" />
              <input
                value={newSubCategory}
                onChange={(event) => setNewSubCategory(event.target.value)}
                placeholder="e.g. Living Room"
                maxLength={60}
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-indigo-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-500 dark:border-indigo-800 dark:bg-slate-900 dark:text-white"
              />
            </div>
          )}
        </div>
      )}

      {subCategoryReady && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">3 · Layout name</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">This is the name users will see in the Layouts panel.</p>
            </div>
            {nameReady && <Check className="h-4 w-4 text-emerald-500" />}
          </div>
          <input
            value={layoutName}
            onChange={(event) => setLayoutName(event.target.value)}
            maxLength={80}
            placeholder="e.g. Warm Wood Final"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-800 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
        </div>
      )}

      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-slate-200 bg-white/95 pt-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/5">Cancel</button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-xl bg-[#ff914d] px-5 py-2.5 text-xs font-bold text-white shadow-md shadow-[#ff914d]/20 transition hover:bg-[#ff7a28] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'Saving…' : mode === 'edit' ? 'Save Changes' : 'Save Layout'}
          {!submitting && <ArrowRight className="h-3.5 w-3.5" />}
        </button>
      </div>
    </form>
  );
};

export const NEW_LAYOUT_PROJECT_VALUE = NEW_PROJECT;
export const NEW_LAYOUT_SUBCATEGORY_VALUE = NEW_SUBCATEGORY;
