import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { bizApi, adApi } from '../lib/api';
import { AddressInputList, ZipCodeInput } from '../components/Shared';

export default function NewAdScanPage() {
  const nav = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedBizIds, setSelectedBizIds] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [method, setMethod] = useState('auto_grid');
  const [radiusKm, setRadiusKm] = useState('5');
  const [gridSize, setGridSize] = useState('3');
  const [addresses, setAddresses] = useState<any[]>([]);
  const [zipCodes, setZipCodes] = useState<string[]>([]);
  const [hoursOverride, setHoursOverride] = useState({ enabled: false, open: '09:00', close: '18:00' });
  const [err, setErr] = useState('');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  const isMulti = selectedBizIds.length > 1;

  const mutation = useMutation({
    mutationFn: () => adApi.create({
      businessIds: selectedBizIds,
      keyword,
      targetingMethod: isMulti ? 'auto_grid' : method,
      radiusKm: parseFloat(radiusKm),
      gridSize: parseInt(gridSize),
      inputAddresses: method === 'addresses' && !isMulti ? addresses : undefined,
      inputZipCodes: method === 'zip_codes' && !isMulti ? zipCodes : undefined,
      openingHoursOverride: hoursOverride.enabled ? { open: hoursOverride.open, close: hoursOverride.close } : undefined,
    }),
    onSuccess: r => nav('/ad-insights/' + r.data.sessionId),
    onError: (e: any) => setErr(e.response?.data?.error ?? 'Failed to start session'),
  });

  function toggleBiz(id: string) {
    setSelectedBizIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  return (
    <div className="max-w-2xl">
      <button onClick={() => nav(-1)} className="text-sm text-gray-400 hover:text-gray-600 mb-4">← Back</button>

      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 bg-orange-100 rounded-2xl flex items-center justify-center text-2xl">📢</div>
        <div>
          <h1 className="text-xl font-bold">New Ad Scan Session</h1>
          <p className="text-gray-400 text-xs">1 credit per time slot per business · SerpApi accurate sponsored detection</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6">
        {[1, 2, 3].map(s => (
          <div key={s} className={'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + (step >= s ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-400')}>
            {s}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Select businesses and keyword</h2>
          <div>
            <label className="label">Businesses (select one or more)</label>
            <div className="space-y-2">
              {businesses?.map((b: any) => (
                <button
                  key={b.id}
                  onClick={() => toggleBiz(b.id)}
                  className={'w-full text-left p-3 rounded-xl border-2 transition-colors ' + (selectedBizIds.includes(b.id) ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200')}
                >
                  <div className="flex items-center gap-3">
                    <div className={'w-5 h-5 rounded-md border-2 flex items-center justify-center ' + (selectedBizIds.includes(b.id) ? 'bg-orange-500 border-orange-500' : 'border-gray-300')}>
                      {selectedBizIds.includes(b.id) && <span className="text-white text-xs">✓</span>}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{b.name}</p>
                      <p className="text-xs text-gray-400">{b.address}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            {isMulti && (
              <p className="text-xs text-orange-600 bg-orange-50 p-2 rounded-lg mt-2">
                Multi-business mode: Auto Grid only. Each business gets its own scan grid.
              </p>
            )}
          </div>
          <div>
            <label className="label">Keyword</label>
            <input type="text" className="input" value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="pizza, dental, plumber..." />
          </div>
          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
          <button
            onClick={() => {
              if (!selectedBizIds.length || !keyword) return setErr('Select at least one business and enter a keyword');
              setErr('');
              setStep(2);
            }}
            className="btn-primary w-full py-2.5"
          >
            Next →
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Scan targeting</h2>
          {!isMulti && (
            <div className="space-y-3">
              {[
                { id: 'auto_grid', icon: '⊞', title: 'Auto Grid', desc: 'H3 grid around your business.' },
                { id: 'addresses', icon: '📍', title: 'Manual Addresses', desc: 'Up to 9 addresses.' },
                { id: 'zip_codes', icon: '🗺️', title: 'Zip Codes', desc: 'Up to 6 zip codes, 4 points each.' },
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setMethod(opt.id)}
                  className={'w-full text-left p-4 rounded-2xl border-2 transition-colors ' + (method === opt.id ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200')}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{opt.icon}</span>
                    <div>
                      <p className="font-semibold">{opt.title}</p>
                      <p className="text-sm text-gray-500">{opt.desc}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {(isMulti || method === 'auto_grid') && (
            <>
              <div>
                <label className="label">Radius: <span className="text-orange-600">{radiusKm} km</span></label>
                <input type="range" min="1" max="50" step="1" className="w-full accent-orange-500" value={radiusKm} onChange={e => setRadiusKm(e.target.value)} />
              </div>
              <div>
                <label className="label">Grid size</label>
                <select className="input" value={gridSize} onChange={e => setGridSize(e.target.value)}>
                  <option value="2">Small</option>
                  <option value="3">Medium</option>
                  <option value="4">Large</option>
                  <option value="5">Extra Large</option>
                </select>
              </div>
            </>
          )}
          {!isMulti && method === 'addresses' && (
            <AddressInputList addresses={addresses} onChange={setAddresses} max={9} apiCall={q => adApi.addressAutocomplete(q)} detailsCall={id => adApi.addressDetails(id)} />
          )}
          {!isMulti && method === 'zip_codes' && (
            <ZipCodeInput zipCodes={zipCodes} onChange={setZipCodes} max={6} />
          )}
          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="btn-secondary">← Back</button>
            <button onClick={() => setStep(3)} className="btn-primary flex-1">Next →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Business hours and confirm</h2>

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
            <p className="font-semibold mb-1">Auto-scheduling</p>
            <p>Scans run every 1.5 hours during opening hours. Hours are auto-fetched from Google if set on your business.</p>
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer mb-3">
              <div
                className={'w-10 h-5 rounded-full transition-colors ' + (hoursOverride.enabled ? 'bg-orange-500' : 'bg-gray-300')}
                onClick={() => setHoursOverride(h => ({ ...h, enabled: !h.enabled }))}
              >
                <div className={'w-4 h-4 bg-white rounded-full mt-0.5 shadow transition-transform ' + (hoursOverride.enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0.5')} />
              </div>
              <span className="text-sm font-medium">Override hours manually</span>
            </label>
            {hoursOverride.enabled && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label text-xs">Open time</label>
                  <input type="time" className="input" value={hoursOverride.open} onChange={e => setHoursOverride(h => ({ ...h, open: e.target.value }))} />
                </div>
                <div>
                  <label className="label text-xs">Close time</label>
                  <input type="time" className="input" value={hoursOverride.close} onChange={e => setHoursOverride(h => ({ ...h, close: e.target.value }))} />
                </div>
              </div>
            )}
          </div>

          <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-1">
            <p className="font-semibold">Session summary</p>
            <p className="text-gray-500">Keyword: <strong>{keyword}</strong></p>
            <p className="text-gray-500">Businesses: <strong>{selectedBizIds.length}</strong></p>
            <p className="text-gray-500">Targeting: <strong>{isMulti ? 'Auto Grid' : method.replace('_', ' ')}</strong></p>
            <p className="text-xs text-orange-600 mt-2">Credits = time slots x businesses (calculated at runtime)</p>
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}

          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="btn-secondary">← Back</button>
            <button
              onClick={() => mutation.mutate()}
              className="btn-primary flex-1 py-2.5"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? 'Starting...' : 'Start Ad Session'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
