import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customScanApi } from '../lib/api';

export default function CustomScanPage() {
  const nav = useNavigate();
  const qc  = useQueryClient();
  const [keyword, setKeyword]       = useState('');
  const [address, setAddress]       = useState('');
  const [lat, setLat]               = useState<number|null>(null);
  const [lng, setLng]               = useState<number|null>(null);
  const [radiusKm, setRadiusKm]     = useState('5');
  const [scanType, setScanType]     = useState('both');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSug, setShowSug]       = useState(false);
  const [err, setErr]               = useState('');

  const { data: history, isLoading } = useQuery({
    queryKey: ['custom-scans'],
    queryFn:  () => customScanApi.list().then(r => r.data.scans),
  });

  const mutation = useMutation({
    mutationFn: () => customScanApi.create({ keyword, centerLat: lat, centerLng: lng, centerAddress: address, radiusKm: parseFloat(radiusKm), scanType }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['custom-scans'] }); setKeyword(''); setAddress(''); setLat(null); setLng(null); setErr(''); },
    onError: (e: any) => setErr(e.response?.data?.error ?? 'Failed to start scan'),
  });

  async function searchAddress(q: string) {
    setAddress(q); setLat(null); setLng(null);
    if (q.length < 3) { setSuggestions([]); return; }
    const r = await customScanApi.addressAutocomplete(q);
    setSuggestions(r.data.suggestions ?? []);
    setShowSug(true);
  }

  async function selectAddress(sug: any) {
    setShowSug(false);
    setAddress(sug.description ?? sug.formatted_address ?? sug.name);
    const r = await customScanApi.addressDetails(sug.place_id);
    setLat(r.data.lat); setLng(r.data.lng);
    setSuggestions([]);
  }

  const scanTypeLabel: Record<string,string> = {
    both: 'Organic + Ad Pressure', organic: 'Organic ranking only', ad_pressure: 'Ad pressure only',
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold mb-1">Custom Scan</h1>
        <p className="text-sm text-gray-400">
          Scan any location with any keyword. Results are stored separately and
          do not affect your business intelligence or opportunity score.
        </p>
      </div>

      {/* Scan form */}
      <div className="card space-y-5">
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
          <p className="font-semibold mb-1">🗺️ Explore any location</p>
          <p>Search a competitor's address, a new area you want to expand to, or any location you're curious about. 25 credits per scan — credits never expire.</p>
        </div>

        <div className="relative">
          <label className="label">Center location</label>
          <input
            type="text" className="input" placeholder="Search any address or location..."
            value={address} onChange={e => searchAddress(e.target.value)}
            onBlur={() => setTimeout(() => setShowSug(false), 200)}
          />
          {showSug && suggestions.length > 0 && (
            <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-xl shadow-xl mt-1 overflow-hidden">
              {suggestions.map((s: any, i) => (
                <button key={i} onMouseDown={() => selectAddress(s)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-none">
                  <p className="font-medium truncate">{s.description ?? s.name}</p>
                </button>
              ))}
            </div>
          )}
          {lat && lng && (
            <p className="text-xs text-green-600 mt-1">✓ Location set: {lat.toFixed(5)}, {lng.toFixed(5)}</p>
          )}
        </div>

        <div>
          <label className="label">Keyword</label>
          <input type="text" className="input" placeholder="pizza, dentist, plumber..." value={keyword} onChange={e => setKeyword(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Radius: <span className="text-brand-600">{radiusKm} km</span></label>
            <input type="range" min="1" max="20" step="1" className="w-full accent-brand-500" value={radiusKm} onChange={e => setRadiusKm(e.target.value)} />
          </div>
          <div>
            <label className="label">Scan type</label>
            <select className="input" value={scanType} onChange={e => setScanType(e.target.value)}>
              <option value="both">Organic + Ad Pressure</option>
              <option value="organic">Organic ranking only</option>
              <option value="ad_pressure">Ad pressure only</option>
            </select>
          </div>
        </div>

        <div className="bg-gray-50 rounded-xl p-4 text-sm flex items-center justify-between">
          <div>
            <p className="font-semibold">25 credits · 5×5 grid · {scanTypeLabel[scanType]}</p>
            <p className="text-xs text-gray-400 mt-0.5">Not linked to any business · Results in ~30 seconds</p>
          </div>
          <span className="text-2xl">🗺️</span>
        </div>

        {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}

        <button
          onClick={() => { if (!lat || !lng) return setErr('Select a location from suggestions'); if (!keyword) return setErr('Enter a keyword'); setErr(''); mutation.mutate(); }}
          className="btn-primary w-full py-3"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? 'Starting scan...' : 'Start Custom Scan — 25 credits'}
        </button>
      </div>

      {/* History */}
      <div>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Scan history</h2>
        {isLoading ? (
          <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />)}</div>
        ) : !history?.length ? (
          <div className="card text-center py-10">
            <p className="text-3xl mb-3">🗺️</p>
            <p className="text-gray-400 text-sm">No custom scans yet. Run your first scan above.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {history.map((s: any) => (
              <div key={s.id} className="card flex items-center gap-4 cursor-pointer hover:shadow-md transition-all"
                onClick={() => nav('/custom-scan/' + s.id)}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-gray-100 shrink-0">
                  {s.scan_type === 'ad_pressure' ? '📢' : s.scan_type === 'organic' ? '🔍' : '🗺️'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">"{s.keyword}"</p>
                  <p className="text-xs text-gray-400 truncate">{s.center_address ?? `${s.center_lat?.toFixed(4)}, ${s.center_lng?.toFixed(4)}`} · {s.radius_km}km</p>
                </div>
                <div className="text-right shrink-0">
                  {s.state === 'completed' && s.visibility_score != null && (
                    <p className="text-sm font-bold text-brand-600">{Math.round(s.visibility_score)}/100</p>
                  )}
                  <p className={'text-xs ' + (s.state === 'completed' ? 'text-green-500' : s.state === 'running' ? 'text-blue-500' : 'text-gray-400')}>
                    {s.state === 'running' ? '⟳ Running...' : s.state === 'completed' ? '✓ Done' : s.state}
                  </p>
                  <p className="text-xs text-gray-400">{new Date(s.created_at).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
