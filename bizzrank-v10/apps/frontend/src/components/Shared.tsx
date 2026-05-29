import { useRef, useState } from 'react';
import { compApi, bizApi } from '../lib/api';
import { useMutation } from '@tanstack/react-query';

export function StateBadge({ state, large }: { state: string; large?: boolean }) {
  const map: Record<string, string> = {
    completed: 'badge-green',
    running: 'badge-blue',
    pending: 'badge-gray',
    failed: 'badge-red',
    scheduled: 'badge-purple',
    stopped: 'badge-gray',
    skipped: 'badge-gray',
  };
  const cls = (map[state] ?? 'badge-gray') + (large ? ' px-3 py-1 text-sm' : '');
  return <span className={cls}>{state}</span>;
}

export function ScoreBar({ score, color }: { score: number; color?: string }) {
  const pct = Math.min(100, Math.max(0, score));
  const c = color ?? (pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-400');
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={c + ' h-full rounded-full'} style={{ width: pct + '%' }} />
      </div>
      <span className="text-xs font-bold">{Math.round(pct)}</span>
    </div>
  );
}

export function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 w-56 bg-gray-200 rounded-lg" />
      <div className="h-40 bg-gray-100 rounded-2xl" />
      <div className="h-64 bg-gray-100 rounded-2xl" />
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <h2 className="font-bold">{title}</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 text-lg">×</button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function AddressInputList({
  addresses, onChange, max, apiCall, detailsCall,
}: {
  addresses: any[];
  onChange: (a: any[]) => void;
  max: number;
  apiCall: (q: string) => any;
  detailsCall: (id: string) => any;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSugs] = useState<any[]>([]);
  const [loading, setLoad] = useState(false);
  const ref = useRef<any>(null);

  function onInput(v: string) {
    setQuery(v);
    if (ref.current) clearTimeout(ref.current);
    if (v.length < 2) return setSugs([]);
    ref.current = setTimeout(async () => {
      setLoad(true);
      const r = await apiCall(v);
      setSugs(r.data.suggestions ?? []);
      setLoad(false);
    }, 350);
  }

  async function pick(s: any) {
    setSugs([]);
    setQuery('');
    const r = await detailsCall(s.placeId);
    onChange([...addresses, { address: s.description, lat: r.data.lat, lng: r.data.lng, placeId: s.placeId }]);
  }

  return (
    <div>
      <label className="label">
        Addresses <span className="text-gray-400 font-normal">({addresses.length}/{max} added)</span>
      </label>
      <div className="space-y-2 mb-3">
        {addresses.map((a, i) => (
          <div key={i} className="flex items-center justify-between p-2 bg-brand-50 rounded-xl border border-brand-100">
            <span className="text-sm text-brand-700 flex items-center gap-2">
              <span className="badge-blue">{i + 1}</span>
              {a.address}
            </span>
            <button onClick={() => onChange(addresses.filter((_, j) => j !== i))} className="text-xs text-gray-400 hover:text-red-500">✕</button>
          </div>
        ))}
      </div>
      {addresses.length < max && (
        <div className="relative">
          <input
            type="text"
            className="input pr-8"
            placeholder="Type an address..."
            value={query}
            onChange={e => onInput(e.target.value)}
          />
          {loading && <div className="absolute right-3 top-3 w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />}
          {suggestions.length > 0 && (
            <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden shadow-lg max-h-52 overflow-y-auto">
              {suggestions.map((s: any) => (
                <button key={s.placeId} onClick={() => pick(s)} className="w-full text-left px-4 py-3 hover:bg-brand-50 border-b border-gray-100 last:border-0 text-sm">
                  {s.mainText} <span className="text-gray-400 text-xs">{s.secondaryText}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ZipCodeInput({ zipCodes, onChange, max }: { zipCodes: string[]; onChange: (z: string[]) => void; max: number }) {
  const [val, setVal] = useState('');

  function add() {
    const z = val.trim();
    if (!z || zipCodes.includes(z) || zipCodes.length >= max) return;
    onChange([...zipCodes, z]);
    setVal('');
  }

  return (
    <div>
      <label className="label">
        Zip codes <span className="text-gray-400 font-normal">({zipCodes.length}/{max} — 4 scan points each)</span>
      </label>
      <div className="flex flex-wrap gap-2 mb-3">
        {zipCodes.map(z => (
          <div key={z} className="flex items-center gap-1 badge-blue">
            <span>{z}</span>
            <button onClick={() => onChange(zipCodes.filter(x => x !== z))} className="hover:text-red-600">✕</button>
          </div>
        ))}
      </div>
      {zipCodes.length < max && (
        <div className="flex gap-2">
          <input
            type="text"
            className="input"
            placeholder="e.g. 90210"
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
            maxLength={10}
          />
          <button onClick={add} className="btn-outline shrink-0">Add</button>
        </div>
      )}
    </div>
  );
}

export function SmallGrid({
  heatmapPoints, onCellClick,
}: {
  heatmapPoints: any[];
  onCellClick: (p: any) => void;
}) {
  if (!heatmapPoints?.length) {
    return <p className="text-sm text-gray-400 text-center py-4">No data yet</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {heatmapPoints.slice(0, 25).map((p: any, i: number) => {
          const rank = p.rank;
          const bg = !rank
            ? 'bg-gray-100 text-gray-400 hover:bg-gray-200'
            : rank <= 3
            ? 'bg-green-500 text-white hover:bg-green-600'
            : rank <= 10
            ? 'bg-amber-400 text-white hover:bg-amber-500'
            : 'bg-red-400 text-white hover:bg-red-500';

          const url = p.googleMapsUrl ?? ('https://www.google.com/maps/search/?api=1&query=' + p.lat + ',' + p.lng);
          const tooltip = (p.locationName || p.label || '') + (rank ? ' — Rank #' + rank : ' — Not ranked');

          return (
            <div
              key={i}
              onClick={() => onCellClick({ ...p, googleMapsUrl: url })}
              className={'w-8 h-8 rounded-md flex items-center justify-center cursor-pointer transition-all ' + bg}
              title={tooltip}
            >
              <span className="text-xs font-bold leading-none">{rank ?? '–'}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-green-500 inline-block" />Top 3</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-400 inline-block" />4–10</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-400 inline-block" />11+</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-gray-100 border inline-block" />Not ranked</span>
        <span className="text-gray-400 ml-auto">Click cell → Google Maps</span>
      </div>
    </div>
  );
}

export function SponsoredGrid({
  heatmapPoints, onCellClick,
}: {
  heatmapPoints: any[];
  onCellClick: (p: any) => void;
}) {
  if (!heatmapPoints?.length) {
    return <div className="text-center py-6 bg-green-50 rounded-xl"><p className="text-green-700 font-semibold">No sponsored activity detected</p></div>;
  }

  const hasAnyAds = heatmapPoints.some(p => p.hasSponsored || p.adCount > 0);
  if (!hasAnyAds) {
    return <div className="text-center py-6 bg-green-50 rounded-xl"><p className="text-green-700 font-semibold">✅ No sponsored activity detected</p></div>;
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {heatmapPoints.slice(0, 25).map((p: any, i: number) => {
          const hasAds = p.hasSponsored || (p.adCount > 0);
          const bg = !hasAds
            ? 'bg-gray-100 text-gray-400 hover:bg-gray-200'
            : p.hasPromotedPin
            ? 'bg-purple-500 text-white hover:bg-purple-600'
            : 'bg-orange-500 text-white hover:bg-orange-600';

          const url = p.googleMapsUrl ?? ('https://www.google.com/maps/search/?api=1&query=' + p.lat + ',' + p.lng);

          return (
            <div
              key={i}
              onClick={() => onCellClick({ ...p, googleMapsUrl: url })}
              className={'w-8 h-8 rounded-md flex items-center justify-center cursor-pointer transition-all ' + bg}
              title={(p.locationName || p.label || '') + ' — ' + (p.adCount ?? 0) + ' ads'}
            >
              <span className="text-xs font-bold leading-none">{p.adCount > 0 ? p.adCount : '–'}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-orange-500 inline-block" />Sponsored</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-purple-500 inline-block" />Promoted Pin</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-gray-100 border inline-block" />No ads</span>
        <span className="text-gray-400 ml-auto">Click cell → Google Maps</span>
      </div>
    </div>
  );
}

export function AddCompModal({ businessId, bizName, onClose, onAdded }: any) {
  const [q, setQ] = useState('');
  const [sugs, setSugs] = useState<any[]>([]);
  const [selected, setSel] = useState<any>(null);
  const [loading, setLoad] = useState(false);
  const [saving, setSave] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<any>(null);

  function onInput(v: string) {
    setQ(v);
    setSel(null);
    if (ref.current) clearTimeout(ref.current);
    if (v.length < 2) return setSugs([]);
    ref.current = setTimeout(async () => {
      setLoad(true);
      const r = await compApi.autocomplete(v);
      setSugs(r.data.suggestions ?? []);
      setLoad(false);
    }, 350);
  }

  async function pick(s: any) {
    setSugs([]);
    setQ(s.description);
    setLoad(true);
    const r = await compApi.placeDetails(s.placeId);
    setSel(r.data);
    setLoad(false);
  }

  async function save() {
    if (!selected) return;
    setSave(true);
    setErr('');
    try {
      await compApi.add({
        businessId, name: selected.name, address: selected.address,
        latitude: selected.latitude, longitude: selected.longitude,
        googlePlaceId: selected.placeId, phone: selected.phone,
        website: selected.website, category: selected.category, rating: selected.rating,
      });
      onAdded();
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Failed to add competitor');
    } finally {
      setSave(false);
    }
  }

  return (
    <Modal title={'Add Competitor — ' + bizName} onClose={onClose}>
      <p className="text-sm text-gray-500 mb-4">Search Google Maps to find and add a competitor.</p>
      <div className="relative">
        <input type="text" className="input pr-8" placeholder="Competitor name or address..." value={q} onChange={e => onInput(e.target.value)} autoFocus />
        {loading && <div className="absolute right-3 top-3 w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />}
      </div>
      {sugs.length > 0 && (
        <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden shadow-lg max-h-60 overflow-y-auto">
          {sugs.map((s: any) => (
            <button key={s.placeId} onClick={() => pick(s)} className="w-full text-left px-4 py-3 hover:bg-brand-50 border-b border-gray-100 last:border-0 transition-colors">
              <p className="text-sm font-semibold">{s.mainText}</p>
              <p className="text-xs text-gray-400">{s.secondaryText}</p>
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl">
          <p className="font-bold">{selected.name}</p>
          <p className="text-sm text-gray-600">{selected.address}</p>
          {selected.rating && <span className="text-xs text-amber-600">★ {selected.rating}</span>}
        </div>
      )}
      {err && <p className="mt-3 text-sm text-red-600 bg-red-50 p-3 rounded-xl">{err}</p>}
      <div className="flex gap-3 mt-5">
        <button onClick={save} className="btn-primary flex-1" disabled={!selected || saving}>{saving ? 'Adding...' : 'Add competitor'}</button>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
      </div>
    </Modal>
  );
}

export function AddBizModal({ onClose, onAdded }: any) {
  const [step, setStep] = useState<'search' | 'keyword'>('search');
  const [q, setQ] = useState('');
  const [sugs, setSugs] = useState<any[]>([]);
  const [selected, setSel] = useState<any>(null);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoad] = useState(false);
  const [saving, setSave] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<any>(null);

  function suggestKeyword(cat: string): string {
    const c = (cat ?? '').toLowerCase();
    if (c.includes('restaurant') || c.includes('food') || c.includes('diner') || c.includes('cafe')) return 'best restaurant near me';
    if (c.includes('plumb')) return 'emergency plumber near me';
    if (c.includes('electric')) return 'electrician near me';
    if (c.includes('dental') || c.includes('dentist')) return 'dentist near me';
    if (c.includes('salon') || c.includes('hair') || c.includes('barber')) return 'hair salon near me';
    if (c.includes('gym') || c.includes('fitness')) return 'gym near me';
    if (c.includes('lawyer') || c.includes('attorney')) return 'lawyer near me';
    if (c.includes('hotel') || c.includes('motel')) return 'hotel near me';
    if (c.includes('car') || c.includes('auto') || c.includes('mechanic')) return 'auto repair near me';
    if (c.includes('medical') || c.includes('clinic') || c.includes('doctor')) return 'doctor near me';
    if (c.includes('clean')) return 'cleaning service near me';
    const first = c.split(' ')[0].replace(/[^a-z]/g, '');
    return first ? first + ' near me' : 'local business near me';
  }

  function onInput(v: string) {
    setQ(v); setSel(null);
    if (ref.current) clearTimeout(ref.current);
    if (v.length < 2) return setSugs([]);
    ref.current = setTimeout(async () => {
      setLoad(true);
      const r = await bizApi.autocomplete(v);
      setSugs(r.data.suggestions ?? []);
      setLoad(false);
    }, 350);
  }

  async function pick(s: any) {
    setSugs([]); setQ(s.description);
    setLoad(true);
    const r = await bizApi.placeDetails(s.placeId);
    setSel(r.data);
    setLoad(false);
    if (r.data?.category) setKeyword(suggestKeyword(r.data.category));
    setStep('keyword');
  }

  async function save() {
    if (!selected) return;
    if (!keyword.trim()) { setErr('Please enter a core keyword'); return; }
    setSave(true); setErr('');
    try {
      const res = await bizApi.create({
        name: selected.name, address: selected.address,
        latitude: selected.latitude, longitude: selected.longitude,
        phone: selected.phone, website: selected.website,
        category: selected.category, googlePlaceId: selected.placeId,
        openingHours: selected.openingHours,
      });
      if (res.data?.id) {
        try {
          const { default: api } = await import('../lib/api');
          await api.post('/keywords', { businessId: res.data.id, keyword: keyword.trim().toLowerCase() });
        } catch { /* non-fatal */ }
      }
      onAdded();
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Failed to add business');
    } finally { setSave(false); }
  }

  const base = selected?.category?.toLowerCase().split(' ')[0]?.replace(/[^a-z]/g, '') ?? 'business';

  if (step === 'search') {
    return (
      <Modal title="Add Your Business" onClose={onClose}>
        <p className="text-sm text-gray-500 mb-4">Search Google Maps — auto-fills address, coordinates and hours.</p>
        <div className="relative">
          <input type="text" className="input pr-8" placeholder="Business name or address..."
            value={q} onChange={e => onInput(e.target.value)} autoFocus />
          {loading && <div className="absolute right-3 top-3 w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />}
        </div>
        {sugs.length > 0 && (
          <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden shadow-lg max-h-60 overflow-y-auto">
            {sugs.map((s: any) => (
              <button key={s.placeId} onClick={() => pick(s)}
                className="w-full text-left px-4 py-3 hover:bg-brand-50 border-b border-gray-100 last:border-0 transition-colors">
                <p className="text-sm font-semibold">{s.mainText}</p>
                <p className="text-xs text-gray-400">{s.secondaryText}</p>
              </button>
            ))}
          </div>
        )}
        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
        {selected && (
          <div className="mt-4">
            <div className="p-3 bg-brand-50 rounded-xl border border-brand-200 mb-4">
              <p className="font-semibold text-sm">{selected.name}</p>
              <p className="text-xs text-gray-500">{selected.address}</p>
            </div>
            <button onClick={() => setStep('keyword')} className="btn-primary w-full">
              Next: Set Core Keyword →
            </button>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="Core Keyword for AI Engine" onClose={onClose}>
      <div className="p-3 bg-brand-50 rounded-xl border border-brand-200 mb-5">
        <p className="font-semibold text-sm">{selected?.name}</p>
        <p className="text-xs text-gray-500">{selected?.address}</p>
      </div>
      <label className="label">What do customers search to find you?</label>
      <p className="text-xs text-gray-400 mb-3">
        The Intelligence Engine monitors your Google Maps ranking for this keyword daily and runs automated weekly scans.
      </p>
      <input type="text" className="input mb-3"
        placeholder="e.g. emergency plumber near me, best restaurant near me"
        value={keyword} onChange={e => setKeyword(e.target.value)} autoFocus />
      <div className="flex flex-wrap gap-2 mb-5">
        {[base + ' near me', 'best ' + base, base + ' open now', base + ' in ' + (selected?.address?.split(',')[1]?.trim() ?? 'my city')].map(s => (
          <button key={s} onClick={() => setKeyword(s)}
            className="text-xs px-2.5 py-1.5 bg-gray-100 hover:bg-brand-100 hover:text-brand-700 rounded-lg transition-colors">
            {s}
          </button>
        ))}
      </div>
      {err && <p className="mb-3 text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
      <div className="flex gap-3">
        <button onClick={() => { setStep('search'); setErr(''); }} className="btn-secondary">← Back</button>
        <button onClick={save} className="btn-primary flex-1" disabled={saving || !keyword.trim()}>
          {saving ? 'Adding...' : 'Add Business + Start Monitoring'}
        </button>
      </div>
      <p className="text-xs text-gray-400 text-center mt-2">More keywords can be added from the Businesses page</p>
    </Modal>
  );
}

export function GridPointModal({ point, onClose }: { point: any; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold mb-3">Grid Point Location</h3>
        <p className="text-sm text-gray-600 mb-1">{point.locationName || point.label}</p>
        <p className="text-xs text-gray-400 mb-3">{point.lat?.toFixed(5)}, {point.lng?.toFixed(5)}</p>
        {point.rank && <p className="text-sm font-semibold mb-4">Rank: #{point.rank}</p>}
        <a
          href={point.googleMapsUrl}
          target="_blank"
          rel="noreferrer"
          className="btn-primary w-full text-center block mb-2"
        >
          Open in Google Maps
        </a>
        <button onClick={onClose} className="btn-secondary w-full">Close</button>
      </div>
    </div>
  );
}
