import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bizApi, compApi, organicApi } from '../lib/api';

const STEPS = ['Add Business', 'Add Keyword', 'Add Competitor', 'Run First Scan'] as const;

export default function OnboardingPage() {
  const nav = useNavigate();
  const [step, setStep]       = useState(0);
  const [bizId, setBizId]     = useState('');
  const [bizName, setBizName] = useState('');
  const [keyword, setKeyword] = useState('');
  const [compQ, setCompQ]     = useState('');
  const [bizSugs, setBizSugs] = useState<any[]>([]);
  const [compSugs, setCompSugs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  async function addBusiness(placeId: string, name: string, address: string) {
    setLoading(true); setErr('');
    try {
      const det = await bizApi.placeDetails(placeId);
      const d   = det.data;
      const res = await bizApi.create({
        name, address,
        latitude: d.latitude, longitude: d.longitude,
        googlePlaceId: placeId,
      });
      setBizId(res.data.id ?? res.data.businessId);
      setBizName(name);
      setBizSugs([]);
      setStep(1);
    } catch (e: any) {
      setErr(e.response?.data?.error ?? 'Failed to add business');
    } finally { setLoading(false); }
  }

  async function saveKeyword() {
    if (!keyword.trim()) return setErr('Enter a keyword');
    setLoading(true); setErr('');
    try {
      await fetch('/api/keywords', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (localStorage.getItem('token') ?? ''),
        },
        body: JSON.stringify({ businessId: bizId, keyword: keyword.trim().toLowerCase() }),
      });
      setStep(2);
    } catch {
      setErr('Failed to save keyword');
    } finally { setLoading(false); }
  }

  async function addCompetitor(placeId: string, name: string, address: string) {
    setLoading(true);
    try {
      const det = await compApi.placeDetails(placeId);
      const d   = det.data;
      await compApi.add({
        businessId: bizId, name, address,
        latitude: d.latitude, longitude: d.longitude,
        googlePlaceId: placeId,
      });
    } catch { /* non-critical */ } finally { setLoading(false); }
    setCompSugs([]);
    setStep(3);
  }

  async function runFirstScan() {
    setLoading(true); setErr('');
    try {
      const res = await organicApi.create({
        businessId: bizId,
        keyword: keyword.trim().toLowerCase(),
        targetingMethod: 'auto_grid',
      });
      nav('/organic/' + (res.data.scanId ?? res.data.id));
    } catch (e: any) {
      setErr(e.response?.data?.error ?? 'Failed to start scan');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">

        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-brand-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
            <span className="text-white text-2xl font-bold">B</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Welcome to BizzRank AI</h1>
          <p className="text-gray-500 text-sm mt-1">Set up your first business in 60 seconds</p>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((s, i) => (
            <div key={s} className="flex-1 flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-colors ${
                i < step  ? 'bg-brand-500 text-white' :
                i === step ? 'bg-brand-500 text-white ring-4 ring-brand-100' :
                'bg-gray-200 text-gray-400'
              }`}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={`text-xs hidden sm:block ${i === step ? 'text-brand-700 font-semibold' : 'text-gray-400'}`}>{s}</span>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 ${i < step ? 'bg-brand-500' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 space-y-4">
          {err && <p className="text-sm text-red-600 bg-red-50 p-3 rounded-xl">{err}</p>}

          {/* Step 1 — Add Business */}
          {step === 0 && (
            <>
              <h2 className="text-lg font-bold">Search for your business</h2>
              <p className="text-sm text-gray-500">Start typing — we'll find it on Google Maps automatically</p>
              <div className="relative">
                <input className="input w-full" autoFocus
                  placeholder="e.g. Smith Dental Practice New York"
                  onChange={async e => {
                    const q = e.target.value;
                    if (q.length < 2) { setBizSugs([]); return; }
                    const r = await bizApi.autocomplete(q);
                    setBizSugs(r.data.suggestions ?? []);
                  }} />
                {bizSugs.length > 0 && (
                  <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 rounded-xl shadow-xl z-10 overflow-hidden mt-1">
                    {bizSugs.map((s: any) => (
                      <button key={s.placeId} onClick={() => addBusiness(s.placeId, s.mainText, s.description)}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-50 last:border-0">
                        <p className="text-sm font-semibold text-gray-800">{s.mainText}</p>
                        <p className="text-xs text-gray-400">{s.secondaryText ?? s.description}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {loading && <p className="text-sm text-gray-400 text-center">Adding business…</p>}
            </>
          )}

          {/* Step 2 — Keyword */}
          {step === 1 && (
            <>
              <h2 className="text-lg font-bold">What do customers search for?</h2>
              <p className="text-sm text-gray-500">The keyword customers use to find <strong>{bizName}</strong> on Google Maps</p>
              <input className="input w-full" autoFocus
                placeholder="e.g. dentist, pizza delivery, plumber"
                value={keyword} onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveKeyword()} />
              <p className="text-xs text-gray-400">Tip: use the phrase your customers actually type, not how you describe yourself</p>
              <button onClick={saveKeyword} disabled={!keyword.trim() || loading}
                className="btn-primary w-full">
                {loading ? 'Saving…' : 'Continue →'}
              </button>
            </>
          )}

          {/* Step 3 — Competitor (skippable) */}
          {step === 2 && (
            <>
              <h2 className="text-lg font-bold">Add a competitor <span className="text-gray-400 font-normal text-sm">(optional)</span></h2>
              <p className="text-sm text-gray-500">Compare your rankings head-to-head on the heatmap</p>
              <div className="relative">
                <input className="input w-full" placeholder="Search for a competitor…"
                  value={compQ} onChange={async e => {
                    setCompQ(e.target.value);
                    if (e.target.value.length < 2) { setCompSugs([]); return; }
                    const r = await compApi.autocomplete(e.target.value);
                    setCompSugs(r.data.suggestions ?? []);
                  }} />
                {compSugs.length > 0 && (
                  <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 rounded-xl shadow-xl z-10 overflow-hidden mt-1">
                    {compSugs.map((s: any) => (
                      <button key={s.placeId} onClick={() => addCompetitor(s.placeId, s.mainText, s.description)}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-50 last:border-0">
                        <p className="text-sm font-semibold text-gray-800">{s.mainText}</p>
                        <p className="text-xs text-gray-400">{s.secondaryText ?? s.description}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => setStep(3)}
                className="w-full text-sm text-gray-400 hover:text-gray-600 py-2 transition-colors">
                Skip for now →
              </button>
            </>
          )}

          {/* Step 4 — Run Scan */}
          {step === 3 && (
            <div className="text-center space-y-4">
              <div className="text-5xl">🗺️</div>
              <h2 className="text-lg font-bold">Ready to run your first scan</h2>
              <div className="bg-brand-50 rounded-xl p-4 text-left space-y-2 text-sm text-gray-600">
                <div className="flex items-center gap-2"><span className="text-brand-500 font-bold">✓</span>Business: <strong>{bizName}</strong></div>
                <div className="flex items-center gap-2"><span className="text-brand-500 font-bold">✓</span>Keyword: <strong>{keyword}</strong></div>
                <div className="flex items-center gap-2"><span className="text-brand-500 font-bold">✓</span>25-point grid scan of your local area</div>
              </div>
              <p className="text-xs text-gray-400">Takes ~30 seconds · Uses 25 credits</p>
              <button onClick={runFirstScan} disabled={loading}
                className="btn-primary w-full py-3 text-base">
                {loading ? 'Starting scan…' : '🚀 Run first scan'}
              </button>
              <button onClick={() => nav('/overview')}
                className="text-xs text-gray-400 hover:underline block w-full">
                Skip — go to dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
