import { useState, useEffect, useRef } from 'react';
import { 
  PanelRightClose, Component, Settings2, Eye, EyeOff, Scissors, 
  Footprints, Orbit, Info, Palette, Maximize2, Move, Ruler,
  Sun, Moon, Trash2, CloudCog, Loader2, Clock, Layers3, X, MousePointer2  
} from 'lucide-react';
import { LayoutMetadataForm } from './LayoutMetadataForm';

const POSITION_RADIUS = 8;   
const ELEVATION_RANGE = [-2, 6]; 
const SCALE_RANGE = [0.1, 5]; // Range for resizing

// Modern Color Categories
const PREDEFINED_COLORS = {
    Wood: ['#8B5A2B', '#A0522D', '#CD853F', '#DEB887', '#F5DEB3'],
    Metal: ['#2C3E50', '#7F8C8D', '#BDC3C7', '#95A5A6', '#D0D3D4'],
    Fabric: ['#2E4053', '#6C3483', '#117864', '#935116', '#FAD7A1'],
    Basics: ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#2ECC71']
};

const formatElementType = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 'Building element';
  const normalized = raw.replace(/^Ifc/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const friendlyNames = {
    wall: 'Wall', walls: 'Wall', slab: 'Floor or slab', door: 'Door', window: 'Window',
    space: 'Room or space', covering: 'Surface finish', 'furnishing element': 'Furniture',
    'building element proxy': 'Building element', beam: 'Beam', column: 'Column', stair: 'Stair', railing: 'Railing',
  };
  return friendlyNames[normalized.toLowerCase()] || normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
};

export const RightPanel = ({
  isOpen, onClose, rightTab, setRightTab,
  selectedObject, selectedElements = [], multiSelectMode = false, onToggleMultiSelect, onClearSelection, onDeleteSelected, activeAsset, selectedAssetId,
  customColor, handleCustomColorChange,
  updateSelectedAsset, deleteSelectedAsset, projectState,
  engineState, engineActions, adoptIsolatedAsset, updateStructuralEdit,
  onDeleteProject, isDarkMode, toggleTheme, activeSavedLayout = null, onSaveLayout, isLayoutSaving = false,
  fileNameForLayoutMetadata = '', existingSavedLayouts = [], saveStatus, onApplyToAllWalls,
  materialLibrary = [], materialLibraryLoading = false, materialLibraryError = '', selectedMaterial = null, onApplyMaterial, onApplyMaterialToAllWalls,
  wallSurfaceScope = 'both', onWallSurfaceScopeChange = () => {}
}) => {
  const [propertySubTab, setPropertySubTab] = useState('design');
  const [materialMode, setMaterialMode] = useState('color');
  const [paletteSearch, setPaletteSearch] = useState('');
  const [paletteBrandFilter, setPaletteBrandFilter] = useState('all');
  const [showSaveLayoutForm, setShowSaveLayoutForm] = useState(false);
  const isMultiSelection = selectedElements.length > 1;
  const selectedWallCount = selectedElements.filter(item => item?.isWall).length;
  const selectedAssetCount = selectedElements.length - selectedWallCount;
  const hasWallSelection = selectedWallCount > 0 || String(selectedObject?.type || '').toLowerCase().includes('ifcwall');

  const paletteColors = materialLibrary.filter((material) => material.kind === 'color');
  const paletteBrands = [...new Set(paletteColors.map((material) => material.brand || 'General colours'))].sort((a, b) => a.localeCompare(b));
  const filteredPaletteColors = paletteColors.filter((material) => {
    const query = paletteSearch.trim().toLowerCase();
    const matchesBrand = paletteBrandFilter === 'all' || (material.brand || 'General colours') === paletteBrandFilter;
    const haystack = [material.name, material.color, material.category, material.brand, material.collection, material.shadeCode, material.shade_code].filter(Boolean).join(' ').toLowerCase();
    return matchesBrand && (!query || haystack.includes(query));
  });

  // Unified State for Transform
  const [liveTransform, setLiveTransform] = useState({ 
      x: 0, y: 0, z: 0, rotY: 0, scaleX: 1, scaleY: 1, scaleZ: 1 
  });
  const boundsRef = useRef({ xMin: -8, xMax: 8, zMin: -8, zMax: 8 });

  useEffect(() => {
    setPropertySubTab('design');
  }, [selectedObject?.id, selectedAssetId, isMultiSelection]);

  // True BIM Resize state (native architectural elements only)
  const [bimDimensions, setBimDimensions] = useState(null);
  const [isInspecting, setIsInspecting] = useState(false);
  // Snapshot of the dimensions as originally inspected, used purely to
  // compute a scale RATIO (new / original) — never sent anywhere, never
  // mutated. bimDimensions above is the editable, user-facing copy.
  const originalDimensionsRef = useRef(null);

  // Sync transform locally based on what was selected
  useEffect(() => {
    if (activeAsset) {
        // It's a dynamically placed asset
        const pos = activeAsset.position || [0, 0, 0];
        const rot = activeAsset.rotation || [0, 0, 0];
        const scale = activeAsset.scale || [1, 1, 1];

        setLiveTransform({ 
            x: pos[0], y: pos[1], z: pos[2], rotY: rot[1] || 0,
            scaleX: scale[0], scaleY: scale[1], scaleZ: scale[2]
        });

        boundsRef.current = {
            xMin: pos[0] - POSITION_RADIUS, xMax: pos[0] + POSITION_RADIUS,
            zMin: pos[2] - POSITION_RADIUS, zMax: pos[2] + POSITION_RADIUS,
        };
    } else if (selectedObject) {
        // It's a native asset in the floor plan (uses relative offset)
        const offset = selectedObject.offset || [0, 0, 0];
        setLiveTransform({
            x: offset[0], y: offset[1], z: offset[2], rotY: 0, scaleX: 1, scaleY: 1, scaleZ: 1
        });
        boundsRef.current = { xMin: -5, xMax: 5, zMin: -5, zMax: 5 };
    }
  }, [selectedAssetId, selectedObject?.id]);

  // Fetch true BIM dimensions whenever the selected native element changes
  useEffect(() => {
    let cancelled = false;

    // A "native element" is one where selectedObject exists but activeAsset doesn't
    if (selectedObject && !activeAsset && !isMultiSelection) {
      setIsInspecting(true);
      engineActions.inspectNativeElement(selectedObject.id).then((data) => {
        if (cancelled) return;
        if (data && !data.error) {
          const dims = {
            height: data.height ?? 0,
            width: data.width ?? 0,
            length: data.length ?? 0,
          };
          setBimDimensions(dims);
          originalDimensionsRef.current = dims; // baseline for ratio math
        } else {
          setBimDimensions(null);
          originalDimensionsRef.current = null;
        }
        setIsInspecting(false);
      });
    } else {
      setBimDimensions(null);
      originalDimensionsRef.current = null;
      setIsInspecting(false);
    }

    return () => { cancelled = true; };
  }, [selectedObject?.id, isMultiSelection]);

  const handleSlider = (axis, rawValue, type) => {
    const value = parseFloat(rawValue);

    if (type === 'scale') {
        setLiveTransform(prev => ({ ...prev, [axis === 0 ? 'scaleX' : axis === 1 ? 'scaleY' : 'scaleZ']: value }));
        engineActions.updateDynamicTransform(selectedAssetId, 'scale', axis, value);
        updateSelectedAsset(axis, value, false, true); // Hook sync
    }
    else if (type === 'rotation') {
        setLiveTransform(prev => ({ ...prev, rotY: value }));
        engineActions.updateDynamicTransform(selectedAssetId, 'rotation', 1, value);
        updateSelectedAsset(1, value, true); // Hook sync
    } 
    else if (type === 'position') {
        setLiveTransform(prev => ({ ...prev, [axis === 0 ? 'x' : axis === 1 ? 'y' : 'z']: value }));
        if (activeAsset) {
            engineActions.updateDynamicTransform(selectedAssetId, 'position', axis, value);
            updateSelectedAsset(axis, value, false); // Hook sync
        } else if (selectedObject) {
            engineActions.updateNativeOffset(selectedObject.id, axis, value);
        }
    }
  };

  return (
    <div className={`relative flex flex-col h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 transition-all duration-300 z-20 ${isOpen ? 'w-[340px]' : 'w-0 overflow-hidden border-none'}`}>
      
      {/* ── Global Controls Header ── */}
      <div className="flex flex-col gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/50">
        
        {/* Row 1: Close Panel, Save, Theme & Delete */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded transition-colors" title="Close Panel">
              <PanelRightClose className="w-4 h-4"/>
            </button>
            <button 
              onClick={() => {
                if (isLayoutSaving) return;
                if (activeSavedLayout?.id) onSaveLayout?.();
                else setShowSaveLayoutForm(true);
              }}
              disabled={isLayoutSaving}
              className="flex items-center gap-2 bg-[#ff914d] hover:bg-[#ff7a28] disabled:opacity-75 disabled:cursor-wait text-white px-3 py-1.5 rounded-md text-[10px] font-bold tracking-wide transition-colors shadow-sm"
              title={activeSavedLayout?.id ? `Save changes to ${activeSavedLayout.name}` : 'Save a reusable version of this design'}
            >
              {isLayoutSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <Layers3 className="w-3.5 h-3.5"/>}
              {isLayoutSaving ? 'Saving…' : 'Save design'}
            </button>
          </div>

          <div className="flex items-center gap-1 bg-white dark:bg-slate-800 rounded-md shadow-sm border border-slate-200 dark:border-slate-700 p-0.5">
            <button onClick={toggleTheme} className="p-1.5 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded transition-colors" title="Toggle Theme">
              {isDarkMode ? <Sun className="w-3.5 h-3.5"/> : <Moon className="w-3.5 h-3.5"/>}
            </button>
            <div className="w-px h-3 bg-slate-300 dark:bg-slate-600"></div>
            <button onClick={onDeleteProject} className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded transition-colors" title="Delete this project and its working data">
              <Trash2 className="w-3.5 h-3.5"/>
            </button>
          </div>
        </div>

        {/* Row 2: Status & Tabs */}
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {saveStatus === 'saving' ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" /><span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">Saving changes…</span></>
              ) : saveStatus === 'saved' ? (
                <><CloudCog className="h-3.5 w-3.5 text-emerald-500" /><span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">All changes saved</span></>
              ) : (
                <><Clock className="h-3.5 w-3.5 text-amber-500" /><span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">Changes not saved yet</span></>
              )}
            </div>

            {(multiSelectMode || isMultiSelection) && (
              <div className="flex items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-2 py-1">
                <span className="text-[10px] font-semibold text-cyan-300">{selectedElements.length} items selected</span>
                {multiSelectMode && (
                  <button type="button" onClick={() => onToggleMultiSelect?.()} className="text-[10px] font-semibold text-cyan-300 hover:text-white">Done</button>
                )}
                <button type="button" onClick={onClearSelection} className="text-[10px] font-semibold text-slate-400 hover:text-white">Clear selection</button>
              </div>
            )}

            <div className="flex bg-slate-200 dark:bg-slate-800 rounded-md p-0.5">
                <button onClick={() => setRightTab('properties')} className={`px-3 py-1.5 text-[11px] font-semibold rounded-lg shadow-sm transition-all ${rightTab === 'properties' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>Properties</button>
                <button onClick={() => setRightTab('settings')} className={`px-3 py-1.5 text-[11px] font-semibold rounded-lg shadow-sm transition-all ${rightTab === 'settings' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>Settings</button>
            </div>
        </div>
      </div>

      {showSaveLayoutForm && !activeSavedLayout?.id && (
        <div className="absolute inset-0 z-[80] overflow-y-auto bg-slate-950/60 p-3 backdrop-blur-sm">
          <div className="min-h-full rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#d96b25]">Saved design</p>
                <h3 className="mt-1 text-lg font-bold text-slate-900 dark:text-white">Save this design</h3>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">We’ll prepare a reusable saved design in the background, including a preview image.</p>
              </div>
              <button type="button" onClick={() => setShowSaveLayoutForm(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5 dark:hover:text-white" aria-label="Close save layout form">
                <X className="h-4 w-4" />
              </button>
            </div>
            <LayoutMetadataForm
              mode="create"
              fileName={fileNameForLayoutMetadata}
              existingLayouts={existingSavedLayouts}
              submitting={isLayoutSaving}
              onSubmit={async (metadata) => {
                const saved = await onSaveLayout?.(metadata);
                if (saved) setShowSaveLayoutForm(false);
              }}
              onCancel={() => setShowSaveLayoutForm(false)}
            />
          </div>
        </div>
      )}

      {/* ── Properties Tab ── */}
      {rightTab === 'properties' && (
        <div className="flex flex-col h-full overflow-hidden">
            {!(selectedObject || activeAsset) ? (
                <div className="flex-1 overflow-y-auto px-4 py-6 text-slate-500 dark:text-slate-400">
                    <div className="mx-auto flex max-w-[270px] flex-col items-center text-center">
                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-orange-200 bg-orange-50 text-[#ff914d] shadow-sm dark:border-orange-500/20 dark:bg-orange-500/10">
                            <MousePointer2 className="h-6 w-6" />
                        </div>
                        <p className="mt-4 text-base font-bold text-slate-900 dark:text-white">Select something to edit</p>
                        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">Click a wall, door, floor or furniture item in the model. Its editing options will appear here.</p>
                    </div>
                    <div className="mx-auto mt-6 max-w-[280px] space-y-3">
                        <div className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800/60">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-200"><MousePointer2 className="h-4 w-4" /></span>
                            <div><p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Choose an element</p><p className="mt-0.5 text-[10px] leading-4 text-slate-500 dark:text-slate-400">Click it in the 3D view or the Model list.</p></div>
                        </div>
                        <div className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800/60">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-[#ff914d] dark:bg-orange-500/10"><Palette className="h-4 w-4" /></span>
                            <div><p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Make it yours</p><p className="mt-0.5 text-[10px] leading-4 text-slate-500 dark:text-slate-400">Change its look, position or size from the tabs above.</p></div>
                        </div>
                        <p className="px-1 text-center text-[10px] leading-4 text-slate-400">Your changes can be reversed with Undo at the top of the canvas.</p>
                    </div>
                </div>
            ) : (
                <>
                    <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
                        <h3 className="text-slate-900 dark:text-white font-bold text-sm break-all">{isMultiSelection ? `${selectedElements.length} items selected` : (activeAsset ? projectState.furniture.find(f => f.instanceId === selectedAssetId)?.name : (selectedObject.name || formatElementType(selectedObject.type)))}</h3>
                        <span className="text-indigo-500 dark:text-indigo-400 text-[10px] uppercase tracking-wider font-bold">{isMultiSelection ? `${selectedWallCount} walls${selectedAssetCount ? ` · ${selectedAssetCount} other items` : ''}` : (activeAsset ? 'Placed item' : formatElementType(selectedObject.type))}</span>
                    </div>

                    <div className="flex border-b border-slate-200 dark:border-slate-800 shrink-0">
                        <button onClick={() => setPropertySubTab('details')} className={`flex-1 py-2.5 text-[11px] font-bold tracking-wider uppercase transition-colors ${propertySubTab === 'details' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-[#ff914d]' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>Details</button>
                        <button onClick={() => setPropertySubTab('design')} className={`flex-1 py-2.5 text-[11px] font-bold tracking-wider uppercase transition-colors ${propertySubTab === 'design' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-[#ff914d]' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>Appearance & position</button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-5">
                        
                        {propertySubTab === 'details' && selectedObject && (
                            <div className="space-y-6">
                                {Object.entries(selectedObject?.groupedProperties || {}).map(([groupName, properties]) => (
                                    <div key={groupName}>
                                        <h4 className="py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 border-b border-slate-100 dark:border-slate-800/50">{groupName}</h4>
                                        <div className="space-y-1.5">
                                            {properties.map((prop, index) => (
                                                <div key={index} className="flex justify-between items-baseline text-xs">
                                                    <span className="text-slate-500 w-1/2 pr-2 leading-tight">{prop.name}</span>
                                                    <span className="text-slate-900 dark:text-slate-300 font-mono text-right break-all w-1/2">{prop.value || '-'}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {propertySubTab === 'details' && activeAsset && !selectedObject && (
                            <div className="text-center py-8 text-slate-500 text-xs italic">No IFC metadata found for this asset.</div>
                        )}

                        {propertySubTab === 'design' && (selectedObject || activeAsset) && (
                            <div className="space-y-8 pb-8">
                                {engineState.isStretching && (
                                  <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 animate-pulse">
                                    <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block"></span>
                                    Stretching — release mouse to apply
                                  </div>
                                )}
                                {/* Material Library */}
                                <div>
                                  <div className="flex items-center justify-between mb-3">
                                    <div><h4 className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5"><Palette className="w-3.5 h-3.5 text-[#ff914d]"/> Appearance</h4><p className="mt-1 text-[10px] leading-4 text-slate-500 dark:text-slate-400">Choose a color, fabric or texture for the selected surface.</p></div>
                                    <span className="text-[9px] text-slate-400 dark:text-slate-500">Separate color, fabric and texture</span>
                                  </div>
                                  {!activeAsset && hasWallSelection && (
                                    <div className="mb-3 rounded-xl border border-indigo-200/80 bg-indigo-50/70 p-2.5 dark:border-indigo-500/20 dark:bg-indigo-500/5">
                                      <div className="flex items-center justify-between gap-3">
                                        <div>
                                          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-indigo-500 dark:text-indigo-300">Apply to wall side</p>
                                          <p className="mt-0.5 text-[8px] text-slate-500 dark:text-slate-400">Choose the side before picking a finish.</p>
                                        </div>
                                        <select
                                          value={wallSurfaceScope}
                                          onChange={(e) => onWallSurfaceScopeChange(e.target.value)}
                                          className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-[9px] font-bold text-slate-700 outline-none focus:border-indigo-400 dark:border-indigo-500/30 dark:bg-slate-900 dark:text-slate-200"
                                        >
                                          <option value="interior">Interior</option>
                                          <option value="exterior">Exterior</option>
                                          <option value="both">Both sides</option>
                                        </select>
                                      </div>
                                    </div>
                                  )}
                                  <div className="flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 mb-3">
                                    {['color','fabric','texture'].map(tab => (
                                      <button key={tab} type="button" onClick={() => setMaterialMode(tab)} className={`flex-1 py-1.5 rounded-lg text-[9px] font-bold transition-colors ${materialMode === tab ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>{tab === 'color' ? 'Palette' : tab === 'fabric' ? 'Fabric' : 'Texture'}</button>
                                    ))}
                                  </div>
                                  {materialMode === 'color' && (
                                    <div className="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl border border-slate-200 dark:border-slate-700/50 space-y-3">
                                      <div className="flex items-center gap-3">
                                        <label className="relative w-11 h-11 rounded-xl border border-slate-200 dark:border-slate-600 overflow-hidden shrink-0 cursor-pointer shadow-sm">
                                          <span className="absolute inset-0" style={{ backgroundColor: customColor || '#FFFFFF' }} />
                                          <input aria-label="Choose material color" type="color" value={customColor || '#FFFFFF'} onChange={(e) => handleCustomColorChange(e, wallSurfaceScope)} className="absolute inset-0 opacity-0 cursor-pointer" />
                                        </label>
                                        <div><div className="text-[9px] text-slate-400 uppercase tracking-wider">Current color</div><div className="font-mono text-xs text-slate-700 dark:text-slate-200 mt-1">{(customColor || '#FFFFFF').toUpperCase()}</div></div>
                                      </div>
                                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
                                        <input value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} placeholder="Search shade, code or HEX…" aria-label="Search architectural color palette" className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[10px] text-slate-700 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200" />
                                        <select value={paletteBrandFilter} onChange={(event) => setPaletteBrandFilter(event.target.value)} aria-label="Filter color palette by brand" className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[10px] text-slate-700 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                                          <option value="all">All brands / palettes</option>
                                          {paletteBrands.map((brand) => <option key={brand} value={brand}>{brand}</option>)}
                                        </select>
                                      </div>
                                      <div className="max-h-72 overflow-y-auto pr-1">
                                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                                          {filteredPaletteColors.map((material) => (
                                            <button key={material.id} type="button" title={`${material.name} · ${material.brand || material.category || 'Color'} · ${material.collection || ''} · ${material.shadeCode || ''} · ${material.color}`} onClick={() => onApplyMaterial?.(material, wallSurfaceScope)} className={`flex min-w-0 items-center gap-2 rounded-lg border p-1.5 text-left transition-colors ${selectedMaterial?.kind === 'color' && selectedMaterial?.color?.toUpperCase() === material.color.toUpperCase() ? 'border-[#ff914d] bg-orange-50 ring-1 ring-[#ff914d]/20 dark:bg-orange-500/10' : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600'}`}>
                                              <span className="h-9 w-9 shrink-0 rounded-md border border-black/10 dark:border-white/10" style={{ backgroundColor: material.color }} />
                                              <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-bold text-slate-700 dark:text-slate-200">{material.name}</span><span className="block truncate text-[9px] text-slate-400">{[material.brand, material.collection, material.shadeCode].filter(Boolean).join(' · ') || material.category}</span><span className="block font-mono text-[9px] text-slate-500">{String(material.color || '#FFFFFF').toUpperCase()}</span></span>
                                            </button>
                                          ))}
                                        </div>
                                        {!filteredPaletteColors.length && <p className="px-2 py-3 text-center text-[10px] text-slate-400">No palette colors match this search.</p>}
                                      </div>
                                    </div>
                                  )}
                                  {materialMode !== 'color' && (
                                    <div className="grid grid-cols-2 gap-2">
                                      {materialLibrary.filter(m => m.kind === materialMode).map(material => (
                                        <button key={material.id} type="button" onClick={() => onApplyMaterial?.(material, wallSurfaceScope)} className={`group flex items-center gap-2 p-2 rounded-xl border text-left transition-all ${selectedMaterial?.kind === material.kind && (selectedMaterial?.id === material.id || selectedMaterial?.texture?.id === material.slug || selectedMaterial?.texture?.id === material.id) ? 'border-[#ff914d] bg-orange-50 dark:bg-orange-500/10 ring-1 ring-[#ff914d]/30' : 'border-slate-200/80 dark:border-slate-700/70 hover:border-slate-300 dark:hover:border-slate-600'}`}>
                                          <span className="w-10 h-10 rounded-lg border border-black/10 dark:border-white/10 shrink-0 overflow-hidden shadow-sm bg-cover bg-center" style={{ backgroundColor: material.color, backgroundImage: material.textureSrc ? `url(${material.textureSrc})` : 'none' }} />
                                          <span className="min-w-0"><span className="block text-[9px] font-semibold text-slate-700 dark:text-slate-200 truncate">{material.name}</span><span className="block text-[8px] text-slate-400 mt-0.5">{material.category}</span></span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {materialMode !== 'color' && !materialLibraryLoading && !materialLibrary.filter(material => material.kind === materialMode).length && (
                                    <div className="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-center dark:border-slate-700">
                                      <p className="text-[10px] font-semibold text-slate-600 dark:text-slate-300">{materialLibraryError ? 'Material library unavailable' : `No ${materialMode === 'fabric' ? 'fabrics' : 'textures'} uploaded yet`}</p>
                                      <p className="mt-1 text-[9px] leading-4 text-slate-400">{materialLibraryError || 'Open Admin → Surface Materials to upload and manage reusable finishes.'}</p>
                                    </div>
                                  )}
                                  {materialMode !== 'color' && materialLibraryLoading && (
                                    <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-4 text-[10px] text-slate-400 dark:border-slate-700"><span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" /> Loading surface materials…</div>
                                  )}
                                  {onApplyMaterialToAllWalls && hasWallSelection && (selectedMaterial || materialMode === 'color') && (selectedMaterial || customColor) && (
                                    <div className="pt-3 mt-3 border-t border-slate-200 dark:border-slate-700/50">
                                      <button type="button" onClick={() => onApplyMaterialToAllWalls(selectedMaterial || materialLibrary.find(m => m.kind === 'color' && m.color.toUpperCase() === (customColor || '').toUpperCase()) || { kind:'color', color:customColor, rgb:[parseInt(customColor.slice(1,3),16)/255,parseInt(customColor.slice(3,5),16)/255,parseInt(customColor.slice(5,7),16)/255] }, wallSurfaceScope)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-indigo-200 dark:border-indigo-500/25 bg-indigo-50 dark:bg-indigo-500/8 text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/14 transition-colors">
                                        <span className="text-left"><span className="block text-[10px] font-bold">Apply finish to every wall</span><span className="block text-[9px] text-indigo-500/80 dark:text-indigo-300/70 mt-0.5">Use this color, fabric or texture across the walls</span></span>
                                        <span className="text-[9px] font-bold uppercase tracking-wider">Apply →</span>
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {!isMultiSelection && (
                                  <>
                                {/* Position */}
                                <div>
                                    <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                                        <Move className="w-3.5 h-3.5"/> {activeAsset ? 'Position' : 'Position adjustment'}
                                    </h4>
                                    <div className="space-y-4">
                                        <div>
                                            <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                Side to side (X) <span className="font-mono text-indigo-500">{liveTransform.x.toFixed(2)}</span>
                                            </label>
                                            <input type="range" min={boundsRef.current.xMin} max={boundsRef.current.xMax} step="0.05" value={liveTransform.x} onChange={(e) => handleSlider(0, e.target.value, 'position')} className="w-full accent-indigo-500" />
                                        </div>
                                        <div>
                                            <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                Height (Y) <span className="font-mono text-indigo-500">{liveTransform.y.toFixed(2)}</span>
                                            </label>
                                            <input type="range" min={ELEVATION_RANGE[0]} max={ELEVATION_RANGE[1]} step="0.02" value={liveTransform.y} onChange={(e) => handleSlider(1, e.target.value, 'position')} className="w-full accent-indigo-500" />
                                        </div>
                                        <div>
                                            <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                Front to back (Z) <span className="font-mono text-indigo-500">{liveTransform.z.toFixed(2)}</span>
                                            </label>
                                            <input type="range" min={boundsRef.current.zMin} max={boundsRef.current.zMax} step="0.05" value={liveTransform.z} onChange={(e) => handleSlider(2, e.target.value, 'position')} className="w-full accent-indigo-500" />
                                        </div>
                                    </div>
                                </div>

                                {!activeAsset && selectedObject && (
                                  <button 
  className="w-full mt-4 py-2 bg-[#ff914d] text-white rounded-lg hover:bg-indigo-700 transition text-xs font-semibold"
  onClick={() => engineActions.isolateAndMakeMoveable(selectedObject.id, adoptIsolatedAsset, updateStructuralEdit)}
  title="Make this building element movable so you can adjust its position."
>
  Enable editing
</button>
                                )}

                                {/* Rotation ONLY for Dynamically Dropped Assets */}
                                {activeAsset && (
                                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                                        <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                            Rotation (Y-Axis) <span className="font-mono text-emerald-500">{liveTransform.rotY.toFixed(0)}°</span>
                                        </label>
                                        <input type="range" min="0" max="360" step="1" value={liveTransform.rotY} onChange={(e) => handleSlider(1, e.target.value, 'rotation')} className="w-full accent-emerald-500" />
                                    </div>
                                )}

                                {/* Resize section: parametric BIM edit for native elements */}
                                {isInspecting && (
                                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-center gap-2 text-slate-400 text-xs py-6">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Inspecting element dimensions...
                                    </div>
                                )}

                                {!isInspecting && !activeAsset && selectedObject && bimDimensions && (
                                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                                        <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                                            <Ruler className="w-3.5 h-3.5"/> Size & dimensions
                                        </h4>
                                        <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 space-y-3">
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Height
                                                </label>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    value={bimDimensions.height}
                                                    onChange={(e) => setBimDimensions(prev => ({ ...prev, height: parseFloat(e.target.value) || 0 }))}
                                                    className="w-full text-xs font-mono px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                                />
                                                <button
                                                    onClick={async () => {
                                                        const result = await engineActions.calibrateWallHeight(selectedObject.id, bimDimensions.height);
                                                        if (!result.success) console.warn('[RightPanel] Height calibration failed:', result.error);
                                                    }}
                                                    className="w-full mt-1.5 py-1.5 bg-[#ff914d] text-white rounded-md hover:bg-indigo-700 transition text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                                                    title="Set this height for every wall in the floor plan"
                                                >
                                                    <Maximize2 className="w-3 h-3" />
                                                    Set Height for Entire Scene
                                                </button>
                                            </div>
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Width
                                                </label>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    value={bimDimensions.width}
                                                    onChange={(e) => setBimDimensions(prev => ({ ...prev, width: parseFloat(e.target.value) || 0 }))}
                                                    className="w-full text-xs font-mono px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Length
                                                </label>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    value={bimDimensions.length}
                                                    onChange={(e) => setBimDimensions(prev => ({ ...prev, length: parseFloat(e.target.value) || 0 }))}
                                                    className="w-full text-xs font-mono px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                                />
                                            </div>
                                            <button
                                                onClick={() => {
                                                    const original = originalDimensionsRef.current;
                                                    const entityId = selectedObject.id;
                                                    if (!original || !entityId) return;

                                                    // Width -> Scale X (axis 0), Length -> Scale Z (axis 2).
                                                    // Delta-based: input.ifc is never touched. We compute a
                                                    // ratio, apply it live to the Xeokit entity, and persist
                                                    // that ratio in projectState.structural_edits so it
                                                    // survives a reload.
                                                    if (original.width > 0 && bimDimensions.width !== original.width) {
                                                        const widthRatio = bimDimensions.width / original.width;
                                                        engineActions.updateStructuralTransform(entityId, 'scale', 0, widthRatio);
                                                        updateStructuralEdit(entityId, 'scale', 0, widthRatio);
                                                    }
                                                    if (original.length > 0 && bimDimensions.length !== original.length) {
                                                        const lengthRatio = bimDimensions.length / original.length;
                                                        engineActions.updateStructuralTransform(entityId, 'scale', 2, lengthRatio);
                                                        updateStructuralEdit(entityId, 'scale', 2, lengthRatio);
                                                    }
                                                }}
                                                className="w-full mt-1 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition text-xs font-semibold cursor-pointer"
                                                title="Scales this wall visually and stores the edit — input.ifc stays read-only"
                                            >
                                                Apply Width/Length — This Wall Only
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {!isInspecting && bimDimensions === null && (activeAsset || selectedObject) && (
                                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                                        {!activeAsset && selectedObject && (
                                            <div className="mb-3 p-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-lg text-[10px] text-amber-700 dark:text-amber-400 leading-relaxed flex items-start gap-1.5">
                                                <Info className="w-3 h-3 mt-0.5 shrink-0"/>
                                                Direct dimension editing isn’t available for this shape. You can still resize it in 3D.
                                            </div>
                                        )}
                                        {/* <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Maximize2 className="w-3.5 h-3.5"/> Scale / Resize</h4>
                                        <div className="space-y-4">
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Scale X (Width) <span className="font-mono text-amber-500">{liveTransform.scaleX.toFixed(2)}x</span>
                                                </label>
                                                <input type="range" min={SCALE_RANGE[0]} max={SCALE_RANGE[1]} step="0.05" value={liveTransform.scaleX} onChange={(e) => handleSlider(0, e.target.value, 'scale')} className="w-full accent-amber-500" />
                                            </div>
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Scale Y (Height) <span className="font-mono text-amber-500">{liveTransform.scaleY.toFixed(2)}x</span>
                                                </label>
                                                <input type="range" min={SCALE_RANGE[0]} max={SCALE_RANGE[1]} step="0.05" value={liveTransform.scaleY} onChange={(e) => handleSlider(1, e.target.value, 'scale')} className="w-full accent-amber-500" />
                                            </div>
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Scale Z (Depth) <span className="font-mono text-amber-500">{liveTransform.scaleZ.toFixed(2)}x</span>
                                                </label>
                                                <input type="range" min={SCALE_RANGE[0]} max={SCALE_RANGE[1]} step="0.05" value={liveTransform.scaleZ} onChange={(e) => handleSlider(2, e.target.value, 'scale')} className="w-full accent-amber-500" />
                                            </div>
                                        </div> */}
                                    </div>
                                )}

                                {activeAsset && (
                                    <button onClick={deleteSelectedAsset} className="w-full mt-4 py-2 flex items-center justify-center gap-2 border border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-900/20 rounded-lg text-xs font-semibold transition-colors cursor-pointer">
                                        <Trash2 className="w-3.5 h-3.5"/> Delete Asset
                                    </button>
                                )}

                                  </>
                                )}

                                {isMultiSelection ? (
                                    <div className="mt-4 rounded-xl border border-cyan-400/15 bg-cyan-500/5 p-3 text-[10px] text-slate-400 leading-relaxed">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <Info className="w-3 h-3 inline mb-0.5 mr-1 text-cyan-300"/>
                                                Multi-select is active. Choose a finish above and it will be applied to all selected elements.
                                            </div>
                                            {onDeleteSelected && (
                                                <button
                                                    type="button"
                                                    onClick={onDeleteSelected}
                                                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-rose-400/20 bg-rose-500/8 px-2.5 py-1.5 text-[9px] font-bold text-rose-400 hover:bg-rose-500/15 hover:text-rose-300 transition-colors"
                                                >
                                                    <Trash2 className="w-3 h-3"/> Delete {selectedElements.length}
                                                </button>
                                            )}
                                        </div>
                                        <div className="mt-2 text-[9px] text-slate-500">Wall-side scope affects walls; other selected elements receive the finish normally.</div>
                                    </div>
                                ) : selectedObject && !activeAsset && (
                                    <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-800 rounded text-[10px] text-slate-500 leading-relaxed border border-slate-100 dark:border-slate-700">
                                        <Info className="w-3 h-3 inline mb-0.5 mr-1 text-slate-400"/>
                                        You are inspecting a native architectural element. You can apply materials and move it via offset.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
      )}

      {/* ── Settings Tab ── */}
      {rightTab === 'settings' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-8">
            <section>
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Ruler className="w-3.5 h-3.5"/> Scene Calibration
                </h4>
                {(() => {
                    const s = engineState.sceneScaleFactor || { x: 1, y: 1, z: 1 };
                    const isCalibrated = Math.abs(s.x - 1) > 0.001 || Math.abs(s.y - 1) > 0.001 || Math.abs(s.z - 1) > 0.001;
                    const isUniform = Math.abs(s.x - s.y) < 0.001 && Math.abs(s.y - s.z) < 0.001;
                    return (
                        <div className={`p-3 rounded-xl border ${isCalibrated ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-900/40' : 'bg-slate-50 border-slate-200 dark:bg-slate-800/50 dark:border-slate-700'}`}>
                            {!isCalibrated ? (
                                <span className="text-[10px] text-slate-400">Not yet calibrated</span>
                            ) : isUniform ? (
                                <div>
                                    <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400 block mb-0.5">Uniform Scale</span>
                                    <span className="text-sm font-mono font-bold text-indigo-600 dark:text-indigo-400">×{s.x.toFixed(3)}</span>
                                </div>
                            ) : (
                                <div className="flex justify-between gap-2">
                                    {['x', 'y', 'z'].map((axis) => (
                                        <div key={axis}>
                                            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400 block">{axis}</span>
                                            <span className="text-xs font-mono font-bold text-indigo-600 dark:text-indigo-400">×{s[axis].toFixed(3)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })()}
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-relaxed">
                    Select a wall and set its Height to calibrate ceiling height scene-wide, or draw a ruler line to fix a uniform import-scale mismatch.
                </p>
            </section>

            <section>
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2"><Settings2 className="w-3.5 h-3.5"/> Global View Modes</h4>
                <div className="grid grid-cols-2 gap-3">
                    <button onClick={engineActions.toggleXRay} className={`py-3 px-3 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer ${engineState.isXRay ? 'bg-indigo-50 border-[#ff914d] text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'}`}>
                        {engineState.isXRay ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                        <span className="text-[10px] font-bold uppercase tracking-wider">X-Ray Mode</span>
                    </button>
                    <button onClick={engineActions.toggleClipping} className={`py-3 px-3 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer ${engineState.isClipping ? 'bg-cyan-50 border-cyan-500 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400' : 'bg-white border-slate-200 text-slate-600 hover:border-cyan-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'}`}>
                        <Scissors className="w-5 h-5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Section Box</span>
                    </button>
                </div>
            </section>

            <section>
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2"><Footprints className="w-3.5 h-3.5"/> Camera Navigation</h4>
                <div className="flex bg-slate-100 dark:bg-slate-800/50 p-1 rounded-lg">
                    <button onClick={() => engineActions.setNavMode('orbit')} className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-md transition-all cursor-pointer ${engineState.navMode === 'orbit' ? 'bg-white dark:bg-slate-700 shadow text-indigo-600 dark:text-white' : 'text-slate-500'}`}>
                        <Orbit className="w-4 h-4"/> Orbit
                    </button>
                    <button onClick={() => engineActions.setNavMode('firstPerson')} className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-md transition-all cursor-pointer ${engineState.navMode === 'firstPerson' ? 'bg-white dark:bg-slate-700 shadow text-cyan-600 dark:text-cyan-400' : 'text-slate-500'}`}>
                        <Footprints className="w-4 h-4"/> Walk
                    </button>
                </div>
            </section>
        </div>
      )}
    </div>
  );
};