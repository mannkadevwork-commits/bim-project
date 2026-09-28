import { useState } from 'react';
import { LayoutDashboard, Pencil, Loader2, Info, CheckCircle, XCircle } from 'lucide-react';
import { IFCEditorRoomList } from './IFCEditorRoomList';

export function IFCEditorSidebar({
  selectedIds, selectedNames, rooms, isLoading,
  nameOverrides, activeSpaceId,
  onDefineRoom, onRenameElement, onSelectRoom, onDeleteRoom, onUpdateSpace,
}) {
  const [tab, setTab]               = useState('spaces');
  const [spaceName, setSpaceName]   = useState('');
  const [newName, setNewName]       = useState('');
  // editingSpace: the space currently being edited (add/remove walls)
  const [editingSpace, setEditingSpace] = useState(null);

  const singleId   = selectedIds.length === 1 ? selectedIds[0] : null;
  // Point 4: show overridden name if available, fall back to XeoKit name
  const singleName = singleId
    ? (nameOverrides?.[singleId] || (selectedNames.length === 1 ? selectedNames[0] : ''))
    : '';
  const multiCount = selectedIds.length;

  const handleDefineSpace = async () => {
    if (!spaceName.trim()) return;
    await onDefineRoom(spaceName);
    setSpaceName('');
  };

  const handleRename = async () => {
    if (!singleId || !newName.trim()) return;
    await onRenameElement(singleId, newName);
    setNewName('');
  };

  // Enter edit mode: load the space's current walls as the selection
  const handleEditRoom = (room) => {
    setEditingSpace(room);
    onSelectRoom(room); // highlights walls in viewer
    setTab('spaces');
  };

  const handleSaveEdit = async () => {
    if (!editingSpace) return;
    await onUpdateSpace(editingSpace.id, selectedIds);
    setEditingSpace(null);
  };

  const handleCancelEdit = () => {
    setEditingSpace(null);
  };

  return (
    <div className="w-[320px] shrink-0 flex flex-col bg-slate-900 border-l border-slate-800 h-full overflow-hidden">

      {/* Tab bar */}
      <div className="flex border-b border-slate-800 shrink-0">
        <button
          onClick={() => { setTab('spaces'); setEditingSpace(null); }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors ${tab === 'spaces' ? 'text-[#ff914d] border-b-2 border-[#ff914d]' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <LayoutDashboard className="w-3.5 h-3.5" /> Spaces
        </button>
        <button
          onClick={() => { setTab('rename'); setEditingSpace(null); }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors ${tab === 'rename' ? 'text-[#ff914d] border-b-2 border-[#ff914d]' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <Pencil className="w-3.5 h-3.5" /> Rename
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">

        {/* ── SPACES TAB ── */}
        {tab === 'spaces' && (
          <>
            {/* Point 2: pass activeSpaceId and onEditRoom */}
            <IFCEditorRoomList
              rooms={rooms}
              activeSpaceId={activeSpaceId}
              onSelectRoom={onSelectRoom}
              onDeleteRoom={onDeleteRoom}
              onEditRoom={handleEditRoom}
            />

            {/* Point 3: Edit mode banner */}
            {editingSpace && (
              <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-3 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">
                  Editing: {editingSpace.name}
                </p>
                <p className="text-[9px] text-slate-400 leading-relaxed">
                  Shift+Click walls to add or remove them from this space. Current selection: <span className="text-white font-semibold">{multiCount} wall{multiCount !== 1 ? 's' : ''}</span>
                </p>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleSaveEdit}
                    disabled={isLoading || multiCount === 0}
                    className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-[10px] font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                    Save Changes
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="flex-1 py-1.5 border border-slate-700 text-slate-400 hover:text-white text-[10px] font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <XCircle className="w-3 h-3" /> Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Define new space */}
            {!editingSpace && (
              <div className="border-t border-slate-800 pt-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                  Define New Space
                </p>

                {multiCount === 0 ? (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-slate-800 border border-slate-700 text-[10px] text-slate-400 mb-3">
                    <Info className="w-3 h-3 mt-0.5 shrink-0 text-slate-500" />
                    Shift+Click walls in the viewer to select them, then name the space below.
                  </div>
                ) : (
                  <div className="mb-3 px-2.5 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-[10px] text-indigo-300 font-semibold">
                    {multiCount} element{multiCount !== 1 ? 's' : ''} selected
                  </div>
                )}

                <input
                  type="text"
                  placeholder="e.g. Master Bedroom"
                  value={spaceName}
                  onChange={e => setSpaceName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleDefineSpace()}
                  className="w-full text-xs px-3 py-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-[#ff914d] mb-2"
                />
                <button
                  onClick={handleDefineSpace}
                  disabled={isLoading || !spaceName.trim() || multiCount === 0}
                  className="w-full py-2 bg-[#ff914d] hover:bg-[#ff7a28] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LayoutDashboard className="w-3.5 h-3.5" />}
                  Define Space &amp; Save to IFC
                </button>
              </div>
            )}
          </>
        )}

        {/* ── RENAME TAB ── */}
        {tab === 'rename' && (
          <>
            {!singleId ? (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-slate-800 border border-slate-700 text-[10px] text-slate-400">
                <Info className="w-3 h-3 mt-0.5 shrink-0 text-slate-500" />
                Click any single element in the viewer to select it, then type a new name below.
              </div>
            ) : (
              <>
                <div className="p-3 rounded-xl bg-slate-800 border border-slate-700">
                  <p className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Selected Element</p>
                  {/* Point 4: shows overridden name if renamed before */}
                  <p className="text-xs font-semibold text-slate-200 break-all">{singleName || singleId}</p>
                  <p className="text-[9px] text-slate-600 mt-0.5 font-mono break-all">{singleId}</p>
                  {nameOverrides?.[singleId] && (
                    <p className="text-[9px] text-emerald-500 mt-1">✓ Renamed in this session</p>
                  )}
                </div>

                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">New Name</p>
                  <input
                    type="text"
                    placeholder={singleName || 'Enter new element name'}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleRename()}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-[#ff914d] mb-2"
                  />
                  <button
                    onClick={handleRename}
                    disabled={isLoading || !newName.trim()}
                    className="w-full py-2 bg-[#ff914d] hover:bg-[#ff7a28] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
                    Rename &amp; Save to IFC
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 px-4 py-3 border-t border-slate-800 text-[9px] text-slate-600 leading-relaxed">
        All changes are written directly into the IFC file. Download the modified IFC when done.
      </div>
    </div>
  );
}
