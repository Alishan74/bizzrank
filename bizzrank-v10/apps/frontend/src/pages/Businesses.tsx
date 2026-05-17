import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi, bizApi, compApi } from '../lib/api';
import { AddBizModal, AddCompModal } from '../components/Shared';

function GBPModal({ onClose, onAdded }: any) {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => authApi.me().then(r => r.data) });
  const { data, isLoading } = useQuery({ queryKey: ['gbp-locs'], queryFn: () => authApi.gbpLocations().then(r => r.data.locations) });
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const limitMap: Record<string, number> = { starter: 1, professional: 5, agency: 999, enterprise: 999 };
  const limit = limitMap[me?.plan ?? 'starter'] ?? 1;

  function toggle(id: string) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : (limit === 999 || s.length < limit) ? [...s, id] : s);
  }

  async function imp() {
    setSaving(true);
    setErr('');
    try {
      await bizApi.importGBP(selected);
      onAdded();
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Import failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-bold">Import from Google Business Profile</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400">×</button>
        </div>
        <div className="p-5">
          {limit < 999 && (
            <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg mb-3">
              Your plan allows <strong>{limit}</strong> location{limit === 1 ? '' : 's'}.
            </p>
          )}
          {isLoading ? (
            <div className="py-8 text-center">
              <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : !data?.length ? (
            <p className="text-center py-8 text-gray-500 text-sm">No GBP locations found.</p>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {data.map((loc: any) => (
                <button
                  key={loc.gbpLocationId}
                  onClick={() => toggle(loc.gbpLocationId)}
                  className={'w-full text-left p-3 rounded-xl border-2 transition-colors ' + (selected.includes(loc.gbpLocationId) ? 'border-brand-500 bg-brand-50' : 'border-gray-100 hover:border-gray-200')}
                >
                  <div className="flex items-center gap-3">
                    <div className={'w-5 h-5 rounded-md border-2 flex items-center justify-center ' + (selected.includes(loc.gbpLocationId) ? 'bg-brand-500 border-brand-500' : 'border-gray-300')}>
                      {selected.includes(loc.gbpLocationId) && <span className="text-white text-xs">✓</span>}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{loc.name}</p>
                      <p className="text-xs text-gray-400">{loc.address}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {err && <p className="mt-3 text-sm text-red-600 bg-red-50 p-3 rounded-xl">{err}</p>}
          <div className="flex gap-3 mt-5">
            <button onClick={imp} className="btn-primary flex-1" disabled={!selected.length || saving}>
              {saving ? 'Importing...' : 'Import ' + selected.length + ' location' + (selected.length !== 1 ? 's' : '')}
            </button>
            <button onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BizCard({ biz, plan }: any) {
  const qc = useQueryClient();
  const [showAddComp, setShowAddComp] = useState(false);

  const { data: compData } = useQuery({
    queryKey: ['competitors', biz.id],
    queryFn: () => compApi.list(biz.id).then(r => r.data),
  });

  const { data: limitData } = useQuery({
    queryKey: ['comp-limit', biz.id],
    queryFn: () => compApi.limit(biz.id).then(r => r.data),
  });

  const competitors: any[] = compData?.competitors ?? [];
  const limit = limitData?.limit ?? 3;
  const remaining = limitData?.remaining ?? limit;

  const remove = useMutation({
    mutationFn: (id: string) => compApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['competitors', biz.id] });
      qc.invalidateQueries({ queryKey: ['comp-limit', biz.id] });
    },
  });

  return (
    <div className="card space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-brand-100 rounded-xl flex items-center justify-center shrink-0">
          <span className="text-brand-600 font-bold">{biz.name[0].toUpperCase()}</span>
        </div>
        <div>
          <h3 className="font-bold">{biz.name}</h3>
          {biz.address && <p className="text-sm text-gray-400">{biz.address}</p>}
          <div className="flex flex-wrap gap-2 mt-1">
            {biz.category && <span className="badge-gray">{biz.category}</span>}
            {biz.opening_hours ? <span className="badge-green">Hours set</span> : <span className="badge-amber">No hours</span>}
            {biz.brand_voice && <span className="badge-blue">Brand voice set</span>}
          </div>
        </div>
      </div>

      <div className="border-t border-gray-100 pt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Competitors</h4>
            <span className="text-xs text-gray-400">{competitors.length}/{limit}</span>
          </div>
          {remaining > 0 && (
            <button onClick={() => setShowAddComp(true)} className="text-xs text-brand-600 hover:underline font-medium">
              + Add ({remaining} left)
            </button>
          )}
        </div>

        <div className="space-y-2">
          {competitors.map((c: any, i: number) => (
            <div key={c.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100 group">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 bg-red-100 rounded-lg flex items-center justify-center">
                  <span className="text-red-600 text-xs font-bold">#{i + 1}</span>
                </div>
                <div>
                  <p className="text-sm font-semibold">{c.name}</p>
                  {c.address && <p className="text-xs text-gray-400">{c.address}</p>}
                </div>
              </div>
              <button
                onClick={() => remove.mutate(c.id)}
                className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                Remove
              </button>
            </div>
          ))}

          {Array.from({ length: Math.max(0, limit - competitors.length) }, (_, i) => (
            <button
              key={i}
              onClick={() => setShowAddComp(true)}
              className="w-full flex items-center gap-3 p-3 border-2 border-dashed border-gray-200 rounded-xl hover:border-brand-300 hover:bg-brand-50 transition-colors group"
            >
              <div className="w-7 h-7 bg-gray-100 rounded-lg flex items-center justify-center group-hover:bg-brand-100">
                <span className="text-gray-400 group-hover:text-brand-600">+</span>
              </div>
              <span className="text-sm text-gray-400 group-hover:text-brand-600">
                Add competitor #{competitors.length + i + 1}
              </span>
            </button>
          ))}
        </div>
      </div>

      {showAddComp && (
        <AddCompModal
          businessId={biz.id}
          bizName={biz.name}
          onClose={() => setShowAddComp(false)}
          onAdded={() => {
            qc.invalidateQueries({ queryKey: ['competitors', biz.id] });
            qc.invalidateQueries({ queryKey: ['comp-limit', biz.id] });
            setShowAddComp(false);
          }}
        />
      )}
    </div>
  );
}

export default function BusinessesPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [showAdd, setShowAdd] = useState(false);
  const [showGBP, setShowGBP] = useState(false);

  useEffect(() => {
    if (searchParams.get('gbp') === 'connected') {
      setShowGBP(true);
      nav('/businesses', { replace: true });
    }
  }, [searchParams]);

  const { data: businesses, isLoading } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then(r => r.data),
  });

  const limitMap: Record<string, number> = { starter: 1, professional: 5, agency: 999, enterprise: 999 };
  const plan = me?.plan ?? 'starter';
  const bizLimit = limitMap[plan] ?? 1;
  const canAdd = bizLimit === 999 || (businesses?.length ?? 0) < bizLimit;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Businesses</h1>
          <p className="text-gray-400 text-sm">Manage your locations and competitors</p>
        </div>
        {canAdd && (
          <div className="flex gap-2">
            <button onClick={() => setShowAdd(true)} className="btn-outline">Search Maps</button>
            <button
              onClick={async () => { const r = await authApi.gbpConnect(); window.location.href = r.data.url; }}
              className="btn-primary"
            >
              Connect GBP
            </button>
          </div>
        )}
      </div>

      {!canAdd && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          Your <strong>{plan}</strong> plan allows <strong>{bizLimit}</strong> location{bizLimit === 1 ? '' : 's'}.
          Upgrade in Profile → Subscription to add more.
        </div>
      )}

      {isLoading ? null : (businesses ?? []).length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">🏢</div>
          <p className="text-gray-500 mb-6">No businesses added yet.</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => setShowAdd(true)} className="btn-outline">Search Maps</button>
            <button
              onClick={async () => { const r = await authApi.gbpConnect(); window.location.href = r.data.url; }}
              className="btn-primary"
            >
              Connect GBP
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {(businesses ?? []).map((b: any) => <BizCard key={b.id} biz={b} plan={plan} />)}
        </div>
      )}

      {showAdd && (
        <AddBizModal
          onClose={() => setShowAdd(false)}
          onAdded={() => { qc.invalidateQueries({ queryKey: ['businesses'] }); setShowAdd(false); }}
        />
      )}
      {showGBP && (
        <GBPModal
          onClose={() => setShowGBP(false)}
          onAdded={() => { qc.invalidateQueries({ queryKey: ['businesses'] }); setShowGBP(false); }}
        />
      )}
    </div>
  );
}
