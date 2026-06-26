import { useState, useEffect, useRef } from 'react';
import { PanelRightClose, Component, Settings2, Eye, EyeOff, Scissors, Footprints, Orbit, Info, Trash2, Palette, Maximize2, Move } from 'lucide-react';

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

export const RightPanel = ({
  isOpen, onClose, rightTab, setRightTab,
  selectedObject, activeAsset, selectedAssetId,
  customColor, handleCustomColorChange,
  updateSelectedAsset, deleteSelectedAsset, projectState,
  engineState, engineActions
}) => {
  const [propertySubTab, setPropertySubTab] = useState('details');

  // Unified State for Transform
  const [liveTransform, setLiveTransform] = useState({ 
      x: 0, y: 0, z: 0, rotY: 0, scaleX: 1, scaleY: 1, scaleZ: 1 
  });
  const boundsRef = useRef({ xMin: -8, xMax: 8, zMin: -8, zMax: 8 });

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

  const handleSlider = (axis, rawValue, type) => {
    const value = parseFloat(rawValue);

    if (type === 'scale') {
        setLiveTransform(prev => ({ ...prev, [axis === 0 ? 'scaleX' : axis === 1 ? 'scaleY' : 'scaleZ']: value }));
        engineActions.updateDynamicTransform(selectedAssetId, 'scale', axis, value);
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
    <div className={`flex flex-col h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 transition-all duration-300 z-20 ${isOpen ? 'w-[340px]' : 'w-0 overflow-hidden border-none'}`}>
        <div className="flex justify-between items-center px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/50">
            <button onClick={onClose} className="text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400"><PanelRightClose className="w-4 h-4"/></button>
            <div className="flex bg-slate-200 dark:bg-slate-800 rounded-md p-0.5">
                <button onClick={() => setRightTab('properties')} className={`px-3 py-1 text-xs font-bold rounded shadow-sm transition-all ${rightTab === 'properties' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>Properties</button>
                <button onClick={() => setRightTab('settings')} className={`px-3 py-1 text-xs font-bold rounded shadow-sm transition-all ${rightTab === 'settings' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>Settings</button>
            </div>
        </div>

        {rightTab === 'properties' && (
            <div className="flex flex-col h-full overflow-hidden">
                {!(selectedObject || activeAsset) ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400 dark:text-slate-500">
                        <Component className="w-12 h-12 mb-4 opacity-50" />
                        <p className="text-sm font-medium">No Element Selected</p>
                        <p className="text-xs mt-2">Click on any wall, floor, or dropped asset in the 3D view to inspect and edit.</p>
                    </div>
                ) : (
                    <>
                        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
                            <h3 className="text-slate-900 dark:text-white font-bold text-sm break-all">{activeAsset ? projectState.furniture.find(f => f.instanceId === selectedAssetId)?.name : selectedObject.name}</h3>
                            <span className="text-indigo-500 dark:text-indigo-400 text-[10px] uppercase tracking-wider font-bold">{activeAsset ? 'Placed IFC Asset' : selectedObject.type}</span>
                        </div>

                        <div className="flex border-b border-slate-200 dark:border-slate-800 shrink-0">
                            <button onClick={() => setPropertySubTab('details')} className={`flex-1 py-2.5 text-[11px] font-bold tracking-wider uppercase transition-colors ${propertySubTab === 'details' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>Metadata</button>
                            <button onClick={() => setPropertySubTab('design')} className={`flex-1 py-2.5 text-[11px] font-bold tracking-wider uppercase transition-colors ${propertySubTab === 'design' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>Design/Transform</button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-5">
                            
                            {/* YOUR EXACT ORIGINAL METADATA MAP - Restored */}
                            {propertySubTab === 'details' && selectedObject && (
                                <div className="space-y-6">
                                    {Object.entries(selectedObject.groupedProperties).map(([groupName, properties]) => (
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
                                    {/* Universal Material Color Palette */}
                                    <div>
                                        <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Palette className="w-3.5 h-3.5"/> Material Paint</h4>
                                        <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 space-y-4">
                                            {Object.entries(PREDEFINED_COLORS).map(([category, colors]) => (
                                                <div key={category}>
                                                    <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider mb-2 block">{category}</span>
                                                    <div className="flex gap-2">
                                                        {colors.map(hex => (
                                                            <button 
                                                                key={hex}
                                                                onClick={() => handleCustomColorChange({ target: { value: hex } })}
                                                                style={{ backgroundColor: hex }}
                                                                className={`w-6 h-6 rounded-full shadow-sm border-2 transition-transform hover:scale-110 ${customColor?.toUpperCase() === hex.toUpperCase() ? 'border-indigo-500 scale-110' : 'border-transparent'}`}
                                                            />
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                            <div className="pt-3 border-t border-slate-200 dark:border-slate-700/50 flex items-center justify-between">
                                                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Custom Picker</span>
                                                <input type="color" value={customColor || '#FFFFFF'} onChange={handleCustomColorChange} className="w-8 h-8 rounded cursor-pointer border-none bg-transparent p-0" />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Position works for BOTH activeAsset and Native Object (Offset) */}
                                    <div>
                                        <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                                            <Move className="w-3.5 h-3.5"/> {activeAsset ? 'Position' : 'Position (Offset)'}
                                        </h4>
                                        <div className="space-y-4">
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    X Axis (Side) <span className="font-mono text-indigo-500">{liveTransform.x.toFixed(2)}</span>
                                                </label>
                                                <input type="range" min={boundsRef.current.xMin} max={boundsRef.current.xMax} step="0.05" value={liveTransform.x} onChange={(e) => handleSlider(0, e.target.value, 'position')} className="w-full accent-indigo-500" />
                                            </div>
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Y Axis (Elevation) <span className="font-mono text-indigo-500">{liveTransform.y.toFixed(2)}</span>
                                                </label>
                                                <input type="range" min={ELEVATION_RANGE[0]} max={ELEVATION_RANGE[1]} step="0.02" value={liveTransform.y} onChange={(e) => handleSlider(1, e.target.value, 'position')} className="w-full accent-indigo-500" />
                                            </div>
                                            <div>
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Z Axis (Depth) <span className="font-mono text-indigo-500">{liveTransform.z.toFixed(2)}</span>
                                                </label>
                                                <input type="range" min={boundsRef.current.zMin} max={boundsRef.current.zMax} step="0.05" value={liveTransform.z} onChange={(e) => handleSlider(2, e.target.value, 'position')} className="w-full accent-indigo-500" />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Rotation and Scale ONLY for Dynamically Dropped Assets */}
                                    {activeAsset && (
                                        <>
                                            <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                                                <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex justify-between mb-1">
                                                    Rotation (Y-Axis) <span className="font-mono text-emerald-500">{liveTransform.rotY.toFixed(0)}°</span>
                                                </label>
                                                <input type="range" min="0" max="360" step="1" value={liveTransform.rotY} onChange={(e) => handleSlider(1, e.target.value, 'rotation')} className="w-full accent-emerald-500" />
                                            </div>

                                            <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                                                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Maximize2 className="w-3.5 h-3.5"/> Scale / Resize</h4>
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
                                                </div>
                                            </div>

                                            <button onClick={deleteSelectedAsset} className="w-full mt-4 py-2 flex items-center justify-center gap-2 border border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-900/20 rounded-lg text-xs font-semibold transition-colors">
                                                <Trash2 className="w-3.5 h-3.5"/> Delete Asset
                                            </button>
                                        </>
                                    )}
                                    
                                    {/* Native element warning label */}
                                    {selectedObject && !activeAsset && (
                                        <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-800 rounded text-[10px] text-slate-500 leading-relaxed border border-slate-100 dark:border-slate-700">
                                            <Info className="w-3 h-3 inline mb-0.5 mr-1 text-slate-400"/>
                                            You are inspecting a native architectural element. You can apply materials and move it via offset, but scaling is restricted to dynamic assets to prevent geometry tearing.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        )}

        {rightTab === 'settings' && (
            <div className="flex-1 overflow-y-auto p-5 space-y-8">
                <section>
                    <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2"><Settings2 className="w-3.5 h-3.5"/> Global View Modes</h4>
                    <div className="grid grid-cols-2 gap-3">
                        <button onClick={engineActions.toggleXRay} className={`py-3 px-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${engineState.isXRay ? 'bg-indigo-50 border-indigo-500 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'}`}>
                            {engineState.isXRay ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                            <span className="text-[10px] font-bold uppercase tracking-wider">X-Ray Mode</span>
                        </button>
                        <button onClick={engineActions.toggleClipping} className={`py-3 px-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${engineState.isClipping ? 'bg-cyan-50 border-cyan-500 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400' : 'bg-white border-slate-200 text-slate-600 hover:border-cyan-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'}`}>
                            <Scissors className="w-5 h-5" />
                            <span className="text-[10px] font-bold uppercase tracking-wider">Section Box</span>
                        </button>
                    </div>
                </section>
                <section>
                    <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2"><Footprints className="w-3.5 h-3.5"/> Camera Navigation</h4>
                    <div className="flex bg-slate-100 dark:bg-slate-800/50 p-1 rounded-lg">
                        <button onClick={() => engineActions.setNavMode('orbit')} className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-md transition-all ${engineState.navMode === 'orbit' ? 'bg-white dark:bg-slate-700 shadow text-indigo-600 dark:text-white' : 'text-slate-500'}`}>
                            <Orbit className="w-4 h-4"/> Orbit (External)
                        </button>
                        <button onClick={() => engineActions.setNavMode('firstPerson')} className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-md transition-all ${engineState.navMode === 'firstPerson' ? 'bg-white dark:bg-slate-700 shadow text-cyan-600 dark:text-cyan-400' : 'text-slate-500'}`}>
                            <Footprints className="w-4 h-4"/> Walk (Internal)
                        </button>
                    </div>
                </section>
            </div>
        )}
    </div>
  );
};