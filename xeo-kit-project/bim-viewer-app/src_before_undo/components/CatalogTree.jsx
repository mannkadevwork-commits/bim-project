import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical, Search, Box, DoorOpen, Layers3, X } from 'lucide-react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';

// Thumbnail generation is deliberately tiny and on-demand. Sidecar images win;
// GLB previews are generated only for visible cards and cached for this session.
const thumbnailCache = new Map();
const thumbnailQueue = [];
let activeThumbnailJobs = 0;
const MAX_THUMBNAIL_JOBS = 2;

const enqueueThumbnail = (url, task) => new Promise((resolve, reject) => {
  thumbnailQueue.push({ url, task, resolve, reject });
  pumpThumbnailQueue();
});

const pumpThumbnailQueue = () => {
  while (activeThumbnailJobs < MAX_THUMBNAIL_JOBS && thumbnailQueue.length) {
    const job = thumbnailQueue.shift();
    activeThumbnailJobs += 1;
    Promise.resolve()
      .then(job.task)
      .then(value => job.resolve(value), error => job.reject(error))
      .finally(() => {
        activeThumbnailJobs -= 1;
        pumpThumbnailQueue();
      });
  }
};

const disposeObject = (root) => {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(material => {
      if (!material) return;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        material[key]?.dispose?.();
      }
      material.dispose?.();
    });
  });
};

const renderGlbThumbnail = (url) => {
  if (thumbnailCache.has(url)) return Promise.resolve(thumbnailCache.get(url));

  return enqueueThumbnail(url, () => new Promise((resolve, reject) => {
    const width = 144;
    const height = 96;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8fafc);

    const camera = new THREE.PerspectiveCamera(28, width / height, 0.01, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b8, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.8);
    key.position.set(3, 5, 4);
    scene.add(key);

    const mount = document.createElement('div');
    mount.style.position = 'absolute';
    mount.style.width = '1px';
    mount.style.height = '1px';
    mount.style.overflow = 'hidden';
    mount.style.opacity = '0';
    mount.appendChild(renderer.domElement);
    document.body.appendChild(mount);

    new GLTFLoader().load(
      url,
      (gltf) => {
        const root = gltf.scene;
        scene.add(root);
        root.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.1);
        const distance = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) * 1.22;

        camera.position.set(
          center.x + distance * 0.82,
          center.y + distance * 0.62,
          center.z + distance * 0.82
        );
        camera.lookAt(center);
        camera.near = Math.max(0.001, maxDim / 1000);
        camera.far = Math.max(10, distance * 6);
        camera.updateProjectionMatrix();

        renderer.render(scene, camera);
        const dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.82);
        thumbnailCache.set(url, dataUrl);
        disposeObject(root);
        renderer.dispose();
        mount.remove();
        resolve(dataUrl);
      },
      undefined,
      (error) => {
        renderer.dispose();
        mount.remove();
        reject(error);
      }
    );
  }));
};

const GlbThumbnail = ({ url, sidecarUrl, alt }) => {
  const hostRef = useRef(null);
  const [src, setSrc] = useState(sidecarUrl || null);
  const [visible, setVisible] = useState(Boolean(sidecarUrl));

  useEffect(() => {
    if (sidecarUrl) {
      setSrc(sidecarUrl);
      return undefined;
    }
    const host = hostRef.current;
    if (!host || !url || !/\.(glb|gltf)(\?|$)/i.test(url)) return undefined;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '160px' });
    observer.observe(host);
    return () => observer.disconnect();
  }, [url, sidecarUrl]);

  useEffect(() => {
    if (!visible || sidecarUrl || src || !url) return;
    let cancelled = false;
    renderGlbThumbnail(url)
      .then(value => { if (!cancelled) setSrc(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [visible, sidecarUrl, src, url]);

  return (
    <div ref={hostRef} className="h-20 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50">
      {src ? (
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full items-center justify-center text-slate-400">
          <Box className="h-7 w-7" />
        </div>
      )}
    </div>
  );
};

const matchesSearch = (item, query) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item?.name, item?.original_name, item?.category, item?.subCategory, item?.sub_category, item?.categoryPath, item?.category_path]
    .some(value => String(value || '').toLowerCase().includes(q));
};

const filterNode = (node, query) => {
  const filteredItems = (node.items || []).filter(item => matchesSearch(item, query));
  const filteredChildren = (node.children || [])
    .map(child => filterNode(child, query))
    .filter(Boolean);
  if (!query.trim() || filteredItems.length || filteredChildren.length || String(node.name || '').toLowerCase().includes(query.trim().toLowerCase())) {
    return { ...node, items: filteredItems, children: filteredChildren };
  }
  return null;
};

const nodeItemCount = node => (node.items || []).length + (node.children || []).reduce((sum, child) => sum + nodeItemCount(child), 0);

const ItemCard = ({ item, placementMode, setPlacementMode, resetSelection }) => {
  const asset = {
    ...item,
    catalogId: item.catalogId ?? item.id,
    src: item.url ?? item.src,
    fileType: item.fileType ?? item.file_type,
    file_type: item.file_type ?? item.fileType,
  };

  const activate = () => {
    resetSelection?.();
    setPlacementMode?.(asset);
  };

  const onDragStart = (event) => {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/json', JSON.stringify(asset));
  };

  const active = placementMode?.catalogId === asset.catalogId || placementMode?.id === asset.id;
  const TypeIcon = asset.type === 'door' ? DoorOpen : asset.type === 'structural' ? Layers3 : Box;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDoubleClick={activate}
      onClick={activate}
      className={`group flex cursor-grab items-center gap-3 rounded-xl border p-2.5 transition active:cursor-grabbing ${active
        ? 'border-indigo-400 bg-indigo-50/80 dark:border-indigo-500 dark:bg-indigo-950/30'
        : 'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900/40 dark:hover:border-indigo-700'
      }`}
      title="Drag into the 3D view or click to place"
    >
      <GlbThumbnail url={asset.url} sidecarUrl={asset.thumbnail_url || asset.thumbnailUrl} alt={asset.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <TypeIcon className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
          <p className="truncate text-xs font-bold text-slate-800 dark:text-slate-100">{asset.name}</p>
        </div>
        <p className="mt-1 truncate text-[10px] text-slate-400">{asset.subCategory || asset.category}</p>
        <div className="mt-1 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-slate-400">
          <GripVertical className="h-3 w-3" />
          <span>{String(asset.file_type || 'model').toUpperCase()}</span>
        </div>
      </div>
    </div>
  );
};

const TreeNode = ({ node, depth = 0, searchActive, placementMode, setPlacementMode, resetSelection }) => {
  const [expanded, setExpanded] = useState(depth === 0 || searchActive);
  const hasContent = (node.children?.length || 0) > 0 || (node.items?.length || 0) > 0;
  if (!hasContent) return null;

  const count = nodeItemCount(node);
  return (
    <div className={depth ? 'ml-3 border-l border-slate-200 pl-2 dark:border-slate-800' : ''}>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800/60"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
          <span className="truncate text-[11px] font-bold text-slate-700 dark:text-slate-200">{node.name}</span>
        </span>
        <span className="ml-2 shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-400 dark:bg-slate-800 dark:text-slate-500">{count}</span>
      </button>

      {expanded && (
        <div className="space-y-1.5 pb-1">
          {(node.items || []).map(item => (
            <ItemCard
              key={item.id}
              item={item}
              placementMode={placementMode}
              setPlacementMode={setPlacementMode}
              resetSelection={resetSelection}
            />
          ))}
          {(node.children || []).map(child => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              searchActive={searchActive}
              placementMode={placementMode}
              setPlacementMode={setPlacementMode}
              resetSelection={resetSelection}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const CatalogTree = ({ tree = [], loading = false, error = null, placementMode, setPlacementMode, resetSelection }) => {
  const [query, setQuery] = useState('');
  const filteredTree = useMemo(() => {
    const q = query.trim();
    if (!q) return tree;
    return tree.map(node => filterNode(node, q)).filter(Boolean);
  }, [tree, query]);

  const resultCount = useMemo(() => filteredTree.reduce((sum, node) => sum + nodeItemCount(node), 0), [filteredTree]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 p-3 dark:border-slate-800">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search furniture, category, sub-category…"
            className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-9 text-xs outline-none transition focus:border-indigo-400 focus:bg-white dark:border-slate-700 dark:bg-slate-900/60 dark:text-white dark:focus:border-indigo-500 dark:focus:bg-slate-900"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-800">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
          <span>{query ? `${resultCount} result${resultCount === 1 ? '' : 's'}` : 'Drag an asset into the 3D view'}</span>
          {query && <span>name + category + sub-category</span>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-xs text-slate-400">Loading catalog…</div>
        ) : error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-300">{error}</div>
        ) : filteredTree.length ? (
          <div className="space-y-1">
            {filteredTree.map(node => (
              <TreeNode
                key={node.id}
                node={node}
                searchActive={Boolean(query)}
                placementMode={placementMode}
                setPlacementMode={setPlacementMode}
                resetSelection={resetSelection}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center dark:border-slate-700">
            <Search className="mx-auto mb-2 h-6 w-6 text-slate-400" />
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">No catalog items found</p>
            <p className="mt-1 text-[10px] text-slate-400">Try a model name or folder/sub-category.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default CatalogTree;
