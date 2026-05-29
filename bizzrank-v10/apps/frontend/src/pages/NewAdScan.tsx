import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { bizApi, adApi } from '../lib/api';
import { AddressInputList, ZipCodeInput } from '../components/Shared';

export default function NewAdScanPage() {
  const nav = useNavigate();
  const [step, setStep] = useState<1|2|3>(1);
  const [selectedBizIds, setSelectedBizIds] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [method, setMethod]   = useState('auto_grid');
  const [radiusKm, setRadiusKm] = useState('5');
  const [gridSize, setGridSize] = useState('3');
  const [addresses, setAddresses] = useState<any[]>([]);
  const [zipCodes, setZipCodes]   = useState<string[]>([]);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime]     = useState('21:00');
  const [err, setErr] = useState('');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  const isMulti = selectedBizIds.length > 1;

  // Calculate number of scans: every hour from start to end inclusive
  const calcScans = () => {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins   = eh * 60 + em;
    if (endMins <= startMins) return 0;
    return Math.floor((endMins - startMins) / 60) + 1;
  };
  const numScans    = calcScans();
  const totalSlots  = numScans * selectedBizIds.length;
  const creditCost  = totalSlots * 25;

  const mutation = useMutation({
    mutationFn: () => adApi.create({
      businessIds: selectedBizIds,
      keyword,
      targetingMethod: isMulti ? 'auto_grid' : method,
      radiusKm: parseFloat(radiusKm),
      gridSize: parseInt(gridSize),
      inputAddresses: method === 'addresses' && !isMulti ? addresses : undefined,
      inputZipCodes:  method === 'zip_codes'  && !isMulti ? zipCodes  : undefined,
      openingHoursOverride: { open: startTime, close: endTime },
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
          <h1 className="text-xl font-bold">New Ad Pressure Session</h1>
          <p className="text-gray-400 text-xs">Scans run every 1 hour · 25 credits per slot</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6">
        {[1,2,3].map(s => (
          <div key={s} className={'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + (step >= s ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-400')}>{s}</div>
        ))}
      </div>

      {step === 1 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Select business and keyword</h2>
          <div>
            <label className="label">Businesses</label>
            <div className="space-y-2">
              {businesses?.map((b: any) => (
                <button key={b.id} onClick={() => toggleBiz(b.id)}
                  className={'w-full text-left p-3 rounded-xl border-2 transition-colors ' + (selectedBizIds.includes(b.id) ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200')}>
                  <div className="flex items-center gap-3">
                    <div className={'w-5 h-5 rounded-md border-2 flex items-center justify-center ' + (selectedBizIds.includes(b.id) ? 'bg-orange-500 border-orange-500' : 'border-gray-300')}>
                      {selectedBizIds.includes(b.id) && <span className="text-white text-xs">✓</span>}
                    </div>
                    <div><p className="text-sm font-semibold">{b.name}</p><p className="text-xs text-gray-400">{b.address}</p></div>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Keyword</label>
            <input type="text" className="input" value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="pizza, dental, plumber..." />
          </div>
          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
          <button onClick={() => { if (!selectedBizIds.length || !keyword) return setErr('Select a business and enter a keyword'); setErr(''); setStep(2); }} className="btn-primary w-full py-2.5">Next →</button>
        </div>
      )}

      {step === 2 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Targeting</h2>
          {!isMulti && (
            <div className="space-y-3">
              {[{ id:'auto_grid', icon:'⊞', title:'Auto Grid', desc:'H3 grid around your business.' },
                { id:'addresses', icon:'📍', title:'Manual Addresses', desc:'Up to 9 addresses.' },
                { id:'zip_codes', icon:'🗺️', title:'Zip Codes', desc:'Up to 6 zip codes.' }
              ].map(opt => (
                <button key={opt.id} onClick={() => setMethod(opt.id)}
                  className={'w-full text-left p-4 rounded-2xl border-2 transition-colors ' + (method === opt.id ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200')}>
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{opt.icon}</span>
                    <div><p className="font-semibold">{opt.title}</p><p className="text-sm text-gray-500">{opt.desc}</p></div>
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
                  <option value="2">Small</option><option value="3">Medium</option>
                  <option value="4">Large</option><option value="5">Extra Large</option>
                </select>
              </div>
            </>
          )}
          {!isMulti && method === 'addresses' && <AddressInputList addresses={addresses} onChange={setAddresses} max={9} apiCall={q => adApi.addressAutocomplete(q)} detailsCall={id => adApi.addressDetails(id)} />}
          {!isMulti && method === 'zip_codes'  && <ZipCodeInput zipCodes={zipCodes} onChange={setZipCodes} max={6} />}
          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="btn-secondary">← Back</button>
            <button onClick={() => setStep(3)} className="btn-primary flex-1">Next →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card space-y-5">
          <h2 className="font-bold">Monitoring window</h2>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
            <p className="font-semibold mb-1">How it works</p>
            <p>Choose the start and end time you want to monitor. The system scans every 1 hour within that window. You'll see exactly who is advertising on Google Maps in your area throughout the day.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Start time</label>
              <input type="time" className="input" value={startTime} onChange={e => setStartTime(e.target.value)} />
            </div>
            <div>
              <label className="label">End time</label>
              <input type="time" className="input" value={endTime} onChange={e => setEndTime(e.target.value)} />
            </div>
          </div>
          {numScans > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div><p className="text-xs text-gray-500">Hourly scans</p><p className="text-xl font-bold text-orange-600">{numScans}</p></div>
                <div><p className="text-xs text-gray-500">Businesses</p><p className="text-xl font-bold text-orange-600">{selectedBizIds.length}</p></div>
                <div><p className="text-xs text-gray-500">Total credits</p><p className="text-xl font-bold text-orange-600">{creditCost}</p></div>
              </div>
              <p className="text-xs text-orange-600 text-center mt-2">{numScans} scans × {selectedBizIds.length} {selectedBizIds.length === 1 ? 'business' : 'businesses'} × 25 pts = {creditCost} credits</p>
            </div>
          )}
          {numScans === 0 && (
            <p className="text-sm text-red-600 bg-red-50 p-3 rounded-xl">End time must be after start time</p>
          )}
          <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-1">
            <p className="font-semibold">Session summary</p>
            <p className="text-gray-500">Keyword: <strong>{keyword}</strong></p>
            <p className="text-gray-500">Window: <strong>{startTime} → {endTime}</strong> (every 1hr)</p>
            <p className="text-gray-500">Targeting: <strong>{isMulti ? 'Auto Grid' : method.replace('_', ' ')}</strong></p>
          </div>
          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="btn-secondary">← Back</button>
            <button onClick={() => mutation.mutate()} className="btn-primary flex-1 py-2.5"
              disabled={mutation.isPending || numScans === 0}>
              {mutation.isPending ? 'Starting...' : `Start Session — ${creditCost} credits`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
