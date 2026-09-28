import { useState, useCallback } from 'react';

function getApiBase() {
  return import.meta.env.VITE_API_URL || 'http://localhost:3000';
}
const API = () => `${getApiBase()}/api/ifc-editor`;

const ROOM_COLORS = [
  '#4A90D9', '#E8A838', '#38C4E8', '#7E57C2',
  '#4CAF50', '#E53935', '#FF7043', '#26A69A',
  '#EC407A', '#AB47BC',
];

export function useIFCEditor(sessionId) {
  const [selectedIds, setSelectedIds]     = useState([]);
  const [selectedNames, setSelectedNames] = useState([]);
  const [rooms, setRooms]                 = useState([]);
  const [isLoading, setIsLoading]         = useState(false);
  const [toast, setToast]                 = useState(null);
  const [nameOverrides, setNameOverrides] = useState({});
  const [activeSpaceId, setActiveSpaceId] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSelect = useCallback((id, name) => {
    setSelectedIds(id ? [id] : []);
    setSelectedNames(id ? [name] : []);
    setActiveSpaceId(null);
  }, []);

  const handleMultiSelect = useCallback((id, name) => {
    setActiveSpaceId(null);
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
    setSelectedNames(prev =>
      prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]
    );
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setSelectedNames([]);
  }, []);

  const defineRoom = useCallback(async (roomName) => {
    if (!sessionId || selectedIds.length < 1 || !roomName.trim()) return null;
    setIsLoading(true);
    try {
      const res = await fetch(`${API()}/define-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, roomName: roomName.trim(), wallIds: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to define room');
      setRooms(prev => [...prev, {
        id: data.spaceId,
        name: roomName.trim(),
        wallIds: [...selectedIds],
        color: ROOM_COLORS[prev.length % ROOM_COLORS.length],
      }]);
      clearSelection();
      showToast(`Room "${roomName.trim()}" saved to IFC`);
      return data;
    } catch (err) {
      showToast(err.message, 'error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, selectedIds, clearSelection]);

  const renameElement = useCallback(async (elementId, newName) => {
    if (!sessionId || !elementId || !newName.trim()) return null;
    setIsLoading(true);
    try {
      const res = await fetch(`${API()}/rename-element`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, elementId, newName: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to rename element');
      // Keep a local override so the UI shows the new name immediately
      // even though XeoKit's metaScene still holds the original IFC name
      setNameOverrides(prev => ({ ...prev, [elementId]: newName.trim() }));
      setSelectedNames(prev =>
        prev.map((n, i) => selectedIds[i] === elementId ? newName.trim() : n)
      );
      showToast(`Renamed to "${newName.trim()}"`);
      return data;
    } catch (err) {
      showToast(err.message, 'error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const selectRoom = useCallback((room) => {
    setActiveSpaceId(room.id);
    setSelectedIds([...room.wallIds]);
    setSelectedNames(room.wallIds.map(() => ''));
  }, []);

  const deleteRoom = useCallback((roomId) => {
    setRooms(prev => prev.filter(r => r.id !== roomId));
    setActiveSpaceId(prev => prev === roomId ? null : prev);
  }, []);

  const updateSpace = useCallback(async (spaceId, newWallIds) => {
    if (!sessionId || !spaceId) return null;
    setIsLoading(true);
    try {
      const res = await fetch(`${API()}/update-space`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, spaceId, wallIds: newWallIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update space');
      setRooms(prev => prev.map(r =>
        r.id === spaceId ? { ...r, wallIds: [...newWallIds] } : r
      ));
      showToast('Space updated in IFC');
      return data;
    } catch (err) {
      showToast(err.message, 'error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const loadRoomsFromIFC = useCallback(async (overrideId) => {
    const id = overrideId || sessionId;
    if (!id) return;
    try {
      const res = await fetch(`${API()}/session/${id}/rooms`);
      const data = await res.json();
      if (data.rooms) {
        setRooms(data.rooms.map((r, i) => ({
          ...r,
          color: ROOM_COLORS[i % ROOM_COLORS.length],
        })));
      }
    } catch (_) {}
  }, [sessionId]);

  return {
    selectedIds, selectedNames, rooms, isLoading, toast,
    nameOverrides, activeSpaceId,
    handleSelect, handleMultiSelect, clearSelection,
    defineRoom, renameElement, selectRoom, deleteRoom, updateSpace, loadRoomsFromIFC,
  };
}
