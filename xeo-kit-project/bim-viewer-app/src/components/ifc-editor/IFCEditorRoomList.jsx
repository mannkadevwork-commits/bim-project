import { LayoutDashboard, Trash2, Pencil } from 'lucide-react';

export function IFCEditorRoomList({ rooms, activeSpaceId, onSelectRoom, onDeleteRoom, onEditRoom }) {
  if (!rooms.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500">
        <LayoutDashboard className="w-8 h-8 mb-3 opacity-40" />
        <p className="text-xs font-medium">No spaces defined yet</p>
        <p className="text-[10px] mt-1 text-slate-600">Select walls and use "Define Space" below</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rooms.map(room => {
        const isActive = activeSpaceId === room.id;
        return (
          <div
            key={room.id}
            onClick={() => onSelectRoom(room)}
            className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition-all ${
              isActive
                ? 'border-[#ff914d] bg-[#ff914d]/10 ring-1 ring-[#ff914d]/30'
                : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span
                className={`w-3 h-3 rounded-full shrink-0 transition-all ${isActive ? 'ring-2 ring-white/30' : ''}`}
                style={{ backgroundColor: room.color }}
              />
              <div className="min-w-0">
                <p className={`text-xs font-semibold truncate ${isActive ? 'text-white' : 'text-slate-200'}`}>
                  {room.name}
                </p>
                <p className="text-[9px] text-slate-500">
                  {room.wallIds.length} wall{room.wallIds.length !== 1 ? 's' : ''}
                  {isActive && <span className="ml-1.5 text-[#ff914d] font-bold">● selected</span>}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0 ml-2" onClick={e => e.stopPropagation()}>
              <button
                onClick={() => onEditRoom(room)}
                className="p-1.5 text-slate-500 hover:text-indigo-400 transition-colors"
                title="Edit walls in this space"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                onClick={() => onDeleteRoom(room.id)}
                className="p-1.5 text-slate-600 hover:text-rose-400 transition-colors"
                title="Remove from list"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
