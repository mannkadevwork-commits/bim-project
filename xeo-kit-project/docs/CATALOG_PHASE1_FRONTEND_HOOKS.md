# Phase 1 — Frontend: Hooks, Routing & Package Changes

This document covers:
1. New `useCatalog` hook — fetches catalog tree from backend
2. `App.jsx` changes — adds `/admin` route
3. `package.json` changes — adds `react-router-dom`
4. `vite.config.js` — no changes needed
5. `.env` / `VITE_API_URL` — confirm it is set

Prerequisite: All previous frontend docs done.

---

## 1. New File: `bim-viewer-app/src/hooks/useCatalog.js`

Fetches `/api/catalog/tree` once on mount and exposes `tree`, `loading`, `error`.
Includes a manual `refresh()` function in case the admin panel needs to trigger a refetch.

```js
import { useState, useEffect, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export function useCatalog() {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/catalog/tree`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTree(data);
    } catch (err) {
      console.error('[useCatalog] Failed to fetch catalog tree:', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTree(); }, [fetchTree]);

  return { tree, loading, error, refresh: fetchTree };
}
```

---

## 2. Install `react-router-dom`

The admin panel needs a `/admin` route. Run inside `bim-viewer-app/`:

```cmd
cd c:\work\hci_v1\bim-project\xeo-kit-project\bim-viewer-app
npm install react-router-dom
```

This adds `react-router-dom` to `package.json` dependencies automatically.

---

## 3. Changes to `bim-viewer-app/src/App.jsx`

Wrap the app in a router and add the `/admin` route alongside the existing viewer.

### Full updated `App.jsx`

Only the imports and the return JSX change. All existing state and handlers stay identical.

```jsx
import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import BIMViewer from './BIMViewer';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import UploadModal from './components/UploadModal';
import ContactForm from './components/ContactForm';
import AdminPanel from './pages/AdminPanel';
import { AlertTriangle } from 'lucide-react';

function ViewerApp() {
  const [isUploadOpen, setIsUploadOpen] = useState(true);
  const [isContactOpen, setIsContactOpen] = useState(false);
  const [modelFile, setModelFile] = useState(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  const handleDeleteRequest = () => setIsDeleteModalOpen(true);

  const confirmDelete = async () => {
    if (modelFile) {
      const jobId = `job_${modelFile.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      localStorage.removeItem(`hci_state_${jobId}`);
      const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      try {
        await fetch(`${API_BASE_URL}/api/projects/${jobId}`, { method: 'DELETE' });
      } catch (err) {
        console.error('Failed to delete project on backend:', err);
      }
    }
    setModelFile(null);
    setIsDeleteModalOpen(false);
    setIsUploadOpen(true);
  };

  return (
    <div className="relative w-screen h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50 transition-colors duration-300 overflow-hidden flex flex-col">
      {!modelFile && (
        <Navbar
          onOpenUpload={() => setIsUploadOpen(true)}
          onOpenContact={() => setIsContactOpen(true)}
        />
      )}
      <div className="flex-1 relative h-full">
        <BIMViewer
          file={modelFile}
          onDelete={handleDeleteRequest}
          onAdd={() => setIsUploadOpen(true)}
        />
      </div>
      {!modelFile && <Footer />}
      <UploadModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        onFileUpload={(file) => setModelFile(file)}
      />
      <ContactForm
        isOpen={isContactOpen}
        onClose={() => setIsContactOpen(false)}
      />
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start gap-4 mb-4">
              <div className="w-12 h-12 rounded-full bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6 text-rose-600 dark:text-rose-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Delete Current Project?</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  This will remove the current structural layout and clear all placed furniture and unsaved progress from your browser. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setIsDeleteModalOpen(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold transition-colors shadow-sm"
              >
                Yes, Delete Project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Root App — wraps everything in BrowserRouter and defines routes
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ViewerApp />} />
        <Route path="/admin" element={<AdminPanel />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
```

### What changed vs original App.jsx
- Existing `App` function body moved into a new `ViewerApp` function — zero logic changes
- New `App` function wraps in `BrowserRouter` + `Routes`
- `/` route renders `ViewerApp` (identical to before)
- `/admin` route renders `AdminPanel`
- Added imports: `BrowserRouter`, `Routes`, `Route` from `react-router-dom`, `AdminPanel`

---

## 4. Confirm `VITE_API_URL` is set

Check `bim-viewer-app/.env` (create it if it doesn't exist):

```
VITE_API_URL=http://localhost:3000
```

If this file doesn't exist, the hooks fall back to `http://localhost:3000` via the
`|| 'http://localhost:3000'` default already in the code — so this step is optional
for local dev but good practice.

---

## 5. Create the `pages/` folder

```cmd
mkdir c:\work\hci_v1\bim-project\xeo-kit-project\bim-viewer-app\src\pages
```

`AdminPanel.jsx` (from `CATALOG_PHASE1_FRONTEND_ADMINPANEL_CATEGORIES.md`) goes here.

---

## 6. Final folder structure after all frontend changes

```
bim-viewer-app/src/
├── components/
│   ├── admin/
│   │   ├── AdminCategoryTree.jsx    ← NEW
│   │   └── AdminItemsPanel.jsx      ← NEW
│   ├── CatalogTree.jsx              ← NEW
│   ├── LeftPanel.jsx                ← MODIFIED
│   ├── BottomDock.jsx               (unchanged)
│   ├── ContactForm.jsx              (unchanged)
│   ├── Footer.jsx                   (unchanged)
│   ├── MeasurementPanel.jsx         (unchanged)
│   ├── Navbar.jsx                   (unchanged)
│   ├── RenderStudioModal.jsx        (unchanged)
│   ├── RightPanel.jsx               (unchanged)
│   └── UploadModal.jsx              (unchanged)
├── hooks/
│   ├── useCatalog.js                ← NEW
│   ├── useBIMEngine.js              (unchanged)
│   ├── useCloudRender.js            (unchanged)
│   └── useProjectSync.js           (unchanged)
├── pages/
│   └── AdminPanel.jsx               ← NEW
├── App.jsx                          ← MODIFIED
├── BIMViewer.jsx                    ← MODIFIED (useCatalog + pass props)
└── ...rest unchanged
```

---

## 7. How to access the Admin Panel

Once the app is running:

```
http://localhost:5173/admin
```

No auth is required at this stage (single-user local tool as confirmed).
Auth can be added later as a simple middleware on `/api/admin/*` routes.

---

## Next Step

Proceed to: **`CATALOG_PHASE1_CHANGELOG_FILES.md`** — complete list of every file
created and modified with a summary of changes for porting to another release.
