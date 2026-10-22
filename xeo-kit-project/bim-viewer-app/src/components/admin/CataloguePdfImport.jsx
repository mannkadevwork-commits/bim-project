import { useMemo, useState } from 'react';
import {
  AlertCircle, Check, CheckSquare, FileUp, Loader2, ScanSearch,
  Square, UploadCloud, X,
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const CATEGORY_BY_KIND = { color: 'Paint', fabric: 'Upholstery', texture: 'Architectural Finish' };
const labelClass = 'mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400';
const inputClass = 'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';

function assetUrl(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `${API.replace(/\/$/, '')}/${String(url).replace(/^\//, '')}`;
}

export default function CataloguePdfImport({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [brand, setBrand] = useState('');
  const [collection, setCollection] = useState('');
  const [defaultKind, setDefaultKind] = useState('texture');
  const [scan, setScan] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');


  const selectedCount = useMemo(() => candidates.filter(item => item.selected).length, [candidates]);
  const selectedCandidates = useMemo(() => candidates.filter(item => item.selected), [candidates]);

  const updateCandidate = (index, patch) => setCandidates(current => current.map(item => item.index === index ? { ...item, ...patch } : item));

  const handleScan = async event => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!file) { setError('Choose a PDF catalogue first.'); return; }
    if (file.size > 35 * 1024 * 1024) { setError('PDF catalogues must be 35 MB or smaller.'); return; }
    const body = new FormData();
    body.append('pdf', file);
    setScanning(true);
    setScan(null);
    setCandidates([]);
    try {
      const response = await fetch(`${API}/api/admin/materials/catalogue-scan`, { method: 'POST', body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Catalogue scan failed (${response.status}).`);
      setScan(payload);
      setCandidates((payload.candidates || []).map(candidate => ({
        ...candidate,
        name: candidate.suggested_name || `Page ${candidate.source_page} - Sample ${candidate.index + 1}`,
        selected: true,
        kind: defaultKind,
        category: CATEGORY_BY_KIND[defaultKind],
        shade_code: '',
        color_hex: String(candidate.color_hex || '#D8C6A8').toUpperCase(),
        repeat_x: defaultKind === 'fabric' ? 5 : 2,
        repeat_y: defaultKind === 'fabric' ? 5 : 2,
        roughness: defaultKind === 'fabric' ? 0.92 : 0.8,
      })));
      setNotice(`Scanned ${payload.pages_scanned} pages and found ${payload.candidate_count} possible swatches. Review the crops and rename them before importing.`);
    } catch (scanError) {
      setError(scanError?.message || 'Could not extract swatches from this PDF.');
    } finally {
      setScanning(false);
    }
  };

  const changeDefaultKind = value => {
    setDefaultKind(value);
    setCandidates(current => current.map(item => ({
      ...item,
      kind: value,
      category: CATEGORY_BY_KIND[value],
      repeat_x: value === 'fabric' ? 5 : 2,
      repeat_y: value === 'fabric' ? 5 : 2,
      roughness: value === 'fabric' ? 0.92 : 0.8,
    })));
  };

  const handleImport = async () => {
    setError('');
    setNotice('');
    if (!scan?.scan_id) { setError('Scan a PDF before importing samples.'); return; }
    if (!selectedCount) { setError('Select at least one sample to import.'); return; }
    const invalid = selectedCandidates.find(item => !String(item.name || '').trim() || (item.kind === 'color' && !/^#[0-9A-Fa-f]{6}$/.test(item.color_hex || '')));
    if (invalid) { setError(`Check the name and HEX value for “${invalid.name || `Page ${invalid.source_page} sample`}”.`); return; }
    setImporting(true);
    try {
      const response = await fetch(`${API}/api/admin/materials/catalogue-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scan_id: scan.scan_id,
          brand: brand.trim(),
          collection: collection.trim(),
          source_document: scan.source_document,
          items: selectedCandidates.map(item => ({
            index: item.index,
            source_page: item.source_page,
            name: item.name.trim(),
            kind: item.kind,
            category: item.category,
            shade_code: item.shade_code,
            color_hex: item.color_hex,
          })),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Import failed (${response.status}).`);
      const count = Number(payload.created_count || 0);
      setNotice(`Imported ${count} catalogue sample${count === 1 ? '' : 's'} into the material library.`);
      await onImported?.(count);
      onClose?.();
    } catch (importError) {
      setError(importError?.message || 'Could not import the selected catalogue samples.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-indigo-200 bg-white shadow-sm dark:border-indigo-500/30 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300"><ScanSearch className="h-5 w-5" /></div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Import samples from a PDF catalogue</h3>
            <p className="mt-1 max-w-3xl text-[11px] leading-5 text-slate-500">Detect repeated rectangular sample tiles locally using PDF rendering and computer vision. No AI service is used. Every crop is shown for review; names and types are editable before publishing.</p>
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close PDF import"><X className="h-4 w-4" /></button>
      </div>

      <div className="space-y-4 p-5">
        {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
        {notice && <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"><Check className="mt-0.5 h-4 w-4 shrink-0" />{notice}</div>}

        <form onSubmit={handleScan} className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/50 lg:grid-cols-[minmax(240px,1.6fr)_1fr_1fr_180px_auto] lg:items-end">
          <label><span className={labelClass}>Catalogue PDF *</span><input type="file" accept="application/pdf,.pdf" onChange={event => { setFile(event.target.files?.[0] || null); setScan(null); setCandidates([]); setError(''); setNotice(''); }} className={`${inputClass} file:mr-2 file:rounded-md file:border-0 file:bg-indigo-50 file:px-2 file:py-1 file:text-[10px] file:font-bold file:text-indigo-700`} required /></label>
          <label><span className={labelClass}>Brand / supplier</span><input className={inputClass} value={brand} onChange={event => setBrand(event.target.value)} placeholder="Asian Paints, Merino…" maxLength={120} /></label>
          <label><span className={labelClass}>Collection / range</span><input className={inputClass} value={collection} onChange={event => setCollection(event.target.value)} placeholder="Royale Play Luxe…" maxLength={120} /></label>
          <label><span className={labelClass}>Default sample type</span><select className={inputClass} value={defaultKind} onChange={event => changeDefaultKind(event.target.value)}><option value="texture">Tile / Surface Texture</option><option value="fabric">Fabric / Upholstery</option><option value="color">Color Palette</option></select></label>
          <button type="submit" disabled={scanning || !file} className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}{scanning ? 'Scanning PDF…' : 'Extract samples'}</button>
        </form>
        <p className="text-[10px] leading-4 text-slate-500">Supports PDFs up to 35 MB and 100 pages per scan (up to 600 detected candidates). Best results come from pages with repeated rectangular swatch cards. The system skips the first three cover/introduction pages, detects sample grids, and may need review on unusual layouts.</p>

        {scan && candidates.length > 0 && <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-100 py-3 dark:border-slate-800">
            <div><h4 className="text-sm font-bold text-slate-900 dark:text-white">Review extracted samples</h4><p className="mt-1 text-[11px] text-slate-500">{selectedCount} selected of {candidates.length} detected · source {scan.source_document}</p></div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setCandidates(current => current.map(item => ({ ...item, selected: true })))} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"><CheckSquare className="h-3.5 w-3.5" /> Select all</button>
              <button type="button" onClick={() => setCandidates(current => current.map(item => ({ ...item, selected: false })))} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"><Square className="h-3.5 w-3.5" /> Clear selection</button>
              <button type="button" onClick={handleImport} disabled={importing || selectedCount === 0} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-[11px] font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50">{importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}{importing ? 'Importing…' : `Import selected (${selectedCount})`}</button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {candidates.map(item => <article key={item.index} className={`overflow-hidden rounded-xl border bg-white transition dark:bg-slate-900 ${item.selected ? 'border-indigo-300 ring-1 ring-indigo-100 dark:border-indigo-500/50 dark:ring-indigo-500/10' : 'border-slate-200 opacity-65 dark:border-slate-800'}`}>
              <div className="relative flex h-40 items-center justify-center bg-slate-100 p-2 dark:bg-slate-950">
                <img src={assetUrl(item.preview_url)} alt={`Extracted page ${item.source_page} sample ${item.index + 1}`} loading="lazy" className="h-full w-full object-contain" />
                <label className="absolute left-2 top-2 flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white/95 px-2 py-1 text-[10px] font-bold text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-200"><input type="checkbox" checked={item.selected} onChange={event => updateCandidate(item.index, { selected: event.target.checked })} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" /> Keep</label>
                <span className="absolute bottom-2 right-2 rounded-md bg-slate-950/75 px-2 py-1 text-[9px] font-semibold text-white">PDF p. {item.source_page}</span>
              </div>
              <div className="space-y-2.5 p-3">
                <label className="block"><span className={labelClass}>Name *</span><input value={item.name} onChange={event => updateCandidate(item.index, { name: event.target.value })} className={inputClass} maxLength={120} /></label>
                <div className="grid grid-cols-2 gap-2">
                  <label><span className={labelClass}>Type</span><select value={item.kind} onChange={event => updateCandidate(item.index, { kind: event.target.value, category: CATEGORY_BY_KIND[event.target.value], repeat_x: event.target.value === 'fabric' ? 5 : 2, repeat_y: event.target.value === 'fabric' ? 5 : 2, roughness: event.target.value === 'fabric' ? 0.92 : 0.8 })} className={inputClass}><option value="texture">Texture</option><option value="fabric">Fabric</option><option value="color">Color</option></select></label>
                  <label><span className={labelClass}>Category</span><input value={item.category} onChange={event => updateCandidate(item.index, { category: event.target.value })} className={inputClass} maxLength={80} /></label>
                </div>
                {item.kind === 'color' ? <label className="block"><span className={labelClass}>Sampled HEX (approx.)</span><div className="flex gap-2"><input type="color" value={item.color_hex} onChange={event => updateCandidate(item.index, { color_hex: event.target.value.toUpperCase() })} className="h-9 w-10 cursor-pointer rounded border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-950" /><input value={item.color_hex} onChange={event => updateCandidate(item.index, { color_hex: event.target.value.toUpperCase() })} className={`${inputClass} font-mono uppercase`} maxLength={7} /></div></label> : <label className="block"><span className={labelClass}>Shade / product code (optional)</span><input value={item.shade_code} onChange={event => updateCandidate(item.index, { shade_code: event.target.value })} className={inputClass} placeholder="Add catalogue code…" maxLength={80} /></label>}
                <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[9px] text-slate-400 dark:border-slate-800"><span>{item.width} × {item.height}px crop</span><span>{item.kind === 'color' ? 'Image not published' : item.kind === 'fabric' ? 'Fabric image' : 'Texture image'}</span></div>
              </div>
            </article>)}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800"><p className="max-w-2xl text-[10px] leading-4 text-slate-500">Color values are median samples from the crop and are approximate. Texture/fabric crops are normalized to WebP when saved. Review crop borders and labels before importing.</p><button type="button" onClick={handleImport} disabled={importing || selectedCount === 0} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">{importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}{importing ? 'Importing…' : `Import ${selectedCount} selected samples`}</button></div>
        </>}
      </div>
    </section>
  );
}
