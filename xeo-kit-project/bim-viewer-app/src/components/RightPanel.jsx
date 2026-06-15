import { useState } from 'react';
import { PanelRightClose, Component, Settings2, Eye, EyeOff, Scissors, Footprints, Orbit, Info, Trash2 } from 'lucide-react';

export const RightPanel = ({ 
  isOpen, onClose, rightTab, setRightTab,
  selectedObject, activeAsset, selectedAssetId,
  customColor, handleCustomColorChange,
  updateSelectedAsset, deleteSelectedAsset, projectState,
  engineState, engineActions
}) => {
  const [propertySubTab, setPropertySubTab] = useState('details');

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
                            {propertySubTab === 'details' && activeAsset && (
                                <div className="text-center py-8 text-slate-500 text-xs italic">Appended IFC Asset.<br/>Native metadata editing coming soon.</div>
                            )}

                            {propertySubTab === 'design' && selectedObject && (
                                <div>
                                    <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">Surface Material</h4>
                                    <div className="flex items-center gap-3 mb-6 bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                                        <input type="color" value={customColor} onChange={handleCustomColorChange} className="w-8 h-8 rounded cursor-pointer border-none bg-transparent p-0" />
                                        <div>
                                            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Custom Color Picker</p>
                                            <p className="text-[10px] text-slate-400 font-mono">{customColor.toUpperCase()}</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {propertySubTab === 'design' && activeAsset && (
                                <div className="space-y-5">
                                    <div>
                                        <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex justify-between mb-1">X Position (Side) <span className="font-mono text-indigo-500">{(activeAsset.position?.[0] || 0).toFixed(2)}</span></label>
                                        <input type="range" min={(activeAsset.position?.[0] || 0) - 5} max={(activeAsset.position?.[0] || 0) + 5} step="0.1" value={activeAsset.position?.[0] || 0} onChange={(e) => updateSelectedAsset(0, e.target.value)} className="w-full accent-indigo-500" />
                                    </div>
                                    <div>
                                        <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex justify-between mb-1">Y Position (Elevation) <span className="font-mono text-indigo-500">{(activeAsset.position?.[1] || 0).toFixed(2)}</span></label>
                                        <input type="range" min={(activeAsset.position?.[1] || 0) - 2} max={(activeAsset.position?.[1] || 0) + 5} step="0.1" value={activeAsset.position?.[1] || 0} onChange={(e) => updateSelectedAsset(1, e.target.value)} className="w-full accent-indigo-500" />
                                    </div>
                                    <div>
                                        <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex justify-between mb-1">Z Position (Depth) <span className="font-mono text-indigo-500">{(activeAsset.position?.[2] || 0).toFixed(2)}</span></label>
                                        <input type="range" min={(activeAsset.position?.[2] || 0) - 5} max={(activeAsset.position?.[2] || 0) + 5} step="0.1" value={activeAsset.position?.[2] || 0} onChange={(e) => updateSelectedAsset(2, e.target.value)} className="w-full accent-indigo-500" />
                                    </div>
                                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                                        <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex justify-between mb-1">Rotation (Y-Axis) <span className="font-mono text-emerald-500">{activeAsset.rotation?.[1]?.toFixed(0) || 0}°</span></label>
                                        <input type="range" min="0" max="360" step="15" value={activeAsset.rotation?.[1] || 0} onChange={(e) => updateSelectedAsset(1, e.target.value, true)} className="w-full accent-emerald-500" />
                                    </div>
                                    <button onClick={deleteSelectedAsset} className="w-full mt-4 py-2 flex items-center justify-center gap-2 border border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-900/20 rounded-lg text-xs font-semibold transition-colors">
                                        <Trash2 className="w-3.5 h-3.5"/> Delete Asset
                                    </button>
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
                    <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 rounded-xl">
                        <h5 className="text-xs font-bold text-amber-800 dark:text-amber-500 mb-2 flex items-center gap-1.5"><Info className="w-3.5 h-3.5"/> How to move</h5>
                        {engineState.navMode === 'orbit' ? (
                            <ul className="space-y-2.5 text-xs text-amber-700 dark:text-amber-600">
                                <li className="flex justify-between border-b border-amber-200/50 dark:border-amber-900/30 pb-1"><span>Rotate around object</span> <kbd className="font-mono bg-white dark:bg-slate-800 px-1.5 rounded shadow-sm">Left-Click Drag</kbd></li>
                                <li className="flex justify-between border-b border-amber-200/50 dark:border-amber-900/30 pb-1"><span>Pan camera</span> <kbd className="font-mono bg-white dark:bg-slate-800 px-1.5 rounded shadow-sm">Right-Click Drag</kbd></li>
                                <li className="flex justify-between border-b border-amber-200/50 dark:border-amber-900/30 pb-1"><span>Zoom in/out</span> <kbd className="font-mono bg-white dark:bg-slate-800 px-1.5 rounded shadow-sm">Scroll Wheel</kbd></li>
                                <li className="flex justify-between border-b border-amber-200/50 dark:border-amber-900/30 pb-1"><span>Fly to element</span> <kbd className="font-mono bg-white dark:bg-slate-800 px-1.5 rounded shadow-sm">Double Click</kbd></li>
                            </ul>
                        ) : (
                            <ul className="space-y-2.5 text-xs text-amber-700 dark:text-amber-600">
                                <li className="flex justify-between border-b border-amber-200/50 dark:border-amber-900/30 pb-1"><span>Look around (Head)</span> <kbd className="font-mono bg-white dark:bg-slate-800 px-1.5 rounded shadow-sm">Left-Click Drag</kbd></li>
                                <li className="flex justify-between border-b border-amber-200/50 dark:border-amber-900/30 pb-1 text-emerald-700 dark:text-emerald-500 font-medium"><span>Walk Forward/Back</span> <kbd className="font-mono bg-white dark:bg-slate-800 px-1.5 rounded shadow-sm">W A S D</kbd></li>
                                <li className="flex justify-between border-b border-amber-200/50 dark:border-amber-900/30 pb-1"><span>Adjust walk speed</span> <kbd className="font-mono bg-white dark:bg-slate-800 px-1.5 rounded shadow-sm">Scroll Wheel</kbd></li>
                            </ul>
                        )}
                    </div>
                </section>
            </div>
        )}
    </div>
  );
};