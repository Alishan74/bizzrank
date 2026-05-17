import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { bizApi, organicApi } from '../lib/api';
import { AddressInputList, ZipCodeInput } from '../components/Shared';

export default function NewOrganicScanPage() {
  const nav = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [businessId, setBusinessId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [method, setMethod] = useState('');
  const [radiusKm, setRadiusKm] = useState('5');
  const [gridSize, setGridSize] = useState('3');
  const [addresses, setAddresses] = useState<any[]>([]);
  const [zipCodes, setZipCodes] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  const mutation = useMutation({
    mutationFn: () => organicApi.create({
      businessId,
      keyword,
      targetingMethod: method,
      radiusKm: parseFloat(radiusKm),
      gridSize: parseInt(gridSize),
      inputAddresses: method === 'addresses' ? addresses : undefined,
      inputZipCodes: method === 'zip_codes' ? zipCodes : undefined,
    }),
    onSuccess: r => nav('/organic/' + r.data.scanId),
    onError: (e: any) => setErr(e.response?.data?.error ?? 'Failed to start scan'),
  });

  return (
    <div className="max-w-2xl">
      <button onClick={() => nav(-1)} className="text-sm text-gray-400 hover:text-gray-600 mb-4">← Back</button>

      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center text-2xl">🔍</div>
        <div>
          <h1 className="text-xl font-bold">New Organic Scan</h1>
          <p className="text-gray-400 text-xs">1 credit · Pure organic results via SerpApi</p>
        </div>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-2 mb-6">
        {[1, 2, 3].map(s => (
          <div
            key={s}
            className={'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + (step >= s ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-400')}
          >
            {s}
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Select business and keyword</h2>
          <div>
            <label className="label">Business</label>
            <select className="input" value={businessId} onChange={e => setBusinessId(e.target.value)}>
              <option value="">Select your business...</option>
              {businesses?.map((b: any) => (
                <option key={b.id} value={b.id}>{b.name} — {b.address}</option>
              ))}
            </select>
            {!businesses?.length && (
              <p className="text-xs text-orange-500 mt-1">
                No businesses yet — <a href="/businesses" className="underline">add one first</a>
              </p>
            )}
          </div>
          <div>
            <label className="label">Search keyword</label>
            <input
              type="text"
              className="input"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="best pizza, dentist, plumber..."
            />
          </div>
          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
          <button
            onClick={() => {
              if (!businessId || !keyword) return setErr('Select a business and enter a keyword');
              setErr('');
              setStep(2);
            }}
            className="btn-primary w-full py-2.5"
          >
            Next →
          </button>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Choose scan targeting</h2>
          <div className="space-y-3">
            {[
              { id: 'auto_grid', icon: '⊞', title: 'Auto Grid', desc: 'H3 grid generated around your business. Set radius and grid size.' },
              { id: 'addresses', icon: '📍', title: 'Manual Addresses', desc: 'Up to 9 specific addresses. Google Maps suggestions as you type.' },
              { id: 'zip_codes', icon: '🗺️', title: 'Zip Codes', desc: 'Up to 6 zip codes. 4 scan points per zip (2×2 H3 grid).' },
            ].map(opt => (
              <button
                key={opt.id}
                onClick={() => setMethod(opt.id)}
                className={'w-full text-left p-4 rounded-2xl border-2 transition-colors ' + (method === opt.id ? 'border-brand-500 bg-brand-50' : 'border-gray-100 hover:border-gray-200')}
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl">{opt.icon}</span>
                  <div>
                    <p className="font-semibold">{opt.title}</p>
                    <p className="text-sm text-gray-500 mt-0.5">{opt.desc}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="btn-secondary">← Back</button>
            <button
              onClick={() => {
                if (!method) return setErr('Select a targeting method');
                setErr('');
                setStep(3);
              }}
              className="btn-primary flex-1 py-2.5"
            >
              Next →
            </button>
          </div>
          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
        </div>
      )}

      {/* Step 3 */}
      {step === 3 && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">
            {method === 'auto_grid' ? 'Grid settings' : method === 'addresses' ? 'Enter addresses' : 'Enter zip codes'}
          </h2>

          {method === 'auto_grid' && (
            <>
              <div>
                <label className="label">Scan radius: <span className="text-brand-600">{radiusKm} km</span></label>
                <input
                  type="range"
                  min="1" max="50" step="1"
                  className="w-full accent-brand-500"
                  value={radiusKm}
                  onChange={e => setRadiusKm(e.target.value)}
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1"><span>1 km</span><span>50 km</span></div>
              </div>
              <div>
                <label className="label">Grid size (H3 rings)</label>
                <select className="input" value={gridSize} onChange={e => setGridSize(e.target.value)}>
                  <option value="2">Small — 2 rings (~13 points)</option>
                  <option value="3">Medium — 3 rings (~25 points)</option>
                  <option value="4">Large — 4 rings (~37 points)</option>
                  <option value="5">Extra Large — 5 rings (~61 points)</option>
                </select>
              </div>
            </>
          )}

          {method === 'addresses' && (
            <AddressInputList
              addresses={addresses}
              onChange={setAddresses}
              max={9}
              apiCall={q => organicApi.addressAutocomplete(q)}
              detailsCall={id => organicApi.addressDetails(id)}
            />
          )}

          {method === 'zip_codes' && (
            <ZipCodeInput zipCodes={zipCodes} onChange={setZipCodes} max={6} />
          )}

          {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}

          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="btn-secondary">← Back</button>
            <button
              onClick={() => mutation.mutate()}
              className="btn-primary flex-1 py-2.5"
              disabled={
                mutation.isPending ||
                (method === 'addresses' && !addresses.length) ||
                (method === 'zip_codes' && !zipCodes.length)
              }
            >
              {mutation.isPending ? 'Starting scan...' : 'Start Organic Scan'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
