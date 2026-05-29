import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bizApi, aiVisibilityApi } from '../lib/api';

const PLATFORM_META: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  chatgpt:    { label: 'ChatGPT',          icon: '🤖', color: 'text-green-700',  bg: 'bg-green-50'  },
  perplexity: { label: 'Perplexity',       icon: '🔮', color: 'text-purple-700', bg: 'bg-purple-50' },
  gemini:     { label: 'Gemini',           icon: '✨', color: 'text-blue-700',   bg: 'bg-blue-50'   },
  google_ai:  { label: 'Google AI Overview', icon: '🔍', color: 'text-orange-700', bg: 'bg-orange-50' },
};

function ScoreRing({ score, size = 80 }: { score: number; size?: number }) {
  const r       = (size / 2) - 8;
  const circ    = 2 * Math.PI * r;
  const offset  = circ - (score / 100) * circ;
  const color   = score >= 60 ? '#1D9E75' : score >= 30 ? '#F59E0B' : '#EF4444';

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#E5E7EB" strokeWidth="8" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="8"
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} />
      <text x={size/2} y={size/2 + 1} textAnchor="middle" dominantBaseline="middle"
        fontSize={size * 0.22} fontWeight="bold" fill={color}>{score}</text>
    </svg>
  );
}

function TrendBadge({ trend }: { trend: string }) {
  if (trend === 'improving') return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">↑ Improving</span>;
  if (trend === 'declining') return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">↓ Declining</span>;
  return <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">→ Stable</span>;
}

export default function AIVisibilityPage() {
  const qc = useQueryClient();
  const [selectedBizId, setSelectedBizId] = useState('');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses),
    onSuccess: (d: any[]) => { if (d?.length && !selectedBizId) setSelectedBizId(d[0].id); },
  });

  const bizId = selectedBizId || businesses?.[0]?.id || '';

  const { data: statusData, isLoading } = useQuery({
    queryKey:       ['ai-visibility', bizId],
    queryFn:        () => aiVisibilityApi.status(bizId).then(r => r.data),
    enabled:        !!bizId,
    refetchInterval: 30000,
  });

  const checkMutation = useMutation({
    mutationFn: () => aiVisibilityApi.check(bizId),
    onSuccess:  () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-visibility', bizId] }), 10000);
    },
  });

  const latest     = statusData?.latest;
  const comparison = statusData?.comparison;
  const history    = statusData?.history ?? [];
  const platforms  = statusData?.configuredPlatforms ?? [];
  const isConfigured = statusData?.isConfigured ?? false;

  return (
    <div className="max-w-4xl space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-purple-100 rounded-2xl flex items-center justify-center text-2xl">🤖</div>
          <div>
            <h1 className="text-xl font-bold">AI Visibility</h1>
            <p className="text-sm text-gray-400">Track how your business appears in ChatGPT, Gemini & Perplexity · Checked weekly</p>
          </div>
        </div>
        {isConfigured && (
          <button onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending || !bizId}
            className="btn-primary text-sm px-4 py-2">
            {checkMutation.isPending ? 'Checking...' : '▶ Check Now — 25 credits'}
          </button>
        )}
      </div>

      {/* Business selector */}
      {businesses && businesses.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {businesses.map((b: any) => (
            <button key={b.id} onClick={() => setSelectedBizId(b.id)}
              className={'px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors ' +
                (b.id === bizId ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
              {b.name}
            </button>
          ))}
        </div>
      )}

      {/* Not configured warning */}
      {!isLoading && !isConfigured && (
        <div className="card bg-amber-50 border-2 border-amber-200">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <p className="font-semibold text-amber-900 mb-1">AI platform API keys not configured</p>
              <p className="text-sm text-amber-700 mb-3">
                To track your AI visibility, add at least one API key to your <code className="bg-amber-100 px-1 rounded">.env</code> file:
              </p>
              <div className="bg-white rounded-xl p-3 font-mono text-xs text-gray-700 space-y-1 border border-amber-200">
                <p>OPENAI_API_KEY=sk-...          <span className="text-gray-400"># ChatGPT — $0.001/check</span></p>
                <p>PERPLEXITY_API_KEY=pplx-...    <span className="text-gray-400"># Perplexity — $0.001/check</span></p>
                <p>GEMINI_API_KEY=...             <span className="text-gray-400"># Gemini (already used for reviews)</span></p>
              </div>
              <p className="text-xs text-amber-600 mt-2">
                If GEMINI_API_KEY is already set, Gemini visibility tracking is already active.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* No data yet */}
      {isConfigured && !isLoading && !latest && (
        <div className="card text-center py-12">
          <p className="text-4xl mb-3">🤖</p>
          <p className="font-semibold text-gray-700">No AI visibility data yet</p>
          <p className="text-sm text-gray-400 mt-1 mb-4">
            Weekly checks run every Wednesday at 3am UTC. Or run a manual check now.
          </p>
          <button onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
            className="btn-primary">
            {checkMutation.isPending ? 'Running check...' : 'Run first check — 25 credits'}
          </button>
        </div>
      )}

      {/* Main score */}
      {latest && (
        <>
          {/* Score overview */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="card flex items-center gap-4 md:col-span-1">
              <ScoreRing score={latest.overall_score} size={90} />
              <div>
                <p className="font-bold text-lg">AI Score</p>
                <TrendBadge trend={statusData?.trend ?? 'stable'} />
                <p className="text-xs text-gray-400 mt-1">
                  {latest.prompts_passed}/{latest.prompts_tested} prompts
                </p>
              </div>
            </div>

            <div className="card md:col-span-2">
              <p className="font-semibold text-sm mb-3">Score by platform</p>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(PLATFORM_META).map(([key, meta]) => {
                  const score = latest[`${key}_score`] ?? 0;
                  const active = platforms.includes(key);
                  return (
                    <div key={key} className={'flex items-center gap-3 p-3 rounded-xl ' + meta.bg + (active ? '' : ' opacity-40')}>
                      <span className="text-xl">{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <p className={'text-xs font-semibold ' + meta.color}>{meta.label}</p>
                          <p className={'text-sm font-bold ' + meta.color}>{active ? score + '%' : 'N/A'}</p>
                        </div>
                        <div className="h-1.5 bg-white rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-current transition-all"
                            style={{ width: active ? score + '%' : '0%', color: meta.color.replace('text-', '#').replace('-700','') }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Key insight */}
          <div className="card bg-purple-50 border border-purple-200">
            <div className="flex items-start gap-3">
              <span className="text-xl">💡</span>
              <div>
                <p className="font-semibold text-purple-900 mb-1">Key insight</p>
                <p className="text-sm text-purple-700">{latest.top_insight}</p>
              </div>
            </div>
          </div>

          {/* Actions */}
          {latest.actions?.length > 0 && (
            <div className="card">
              <p className="font-semibold text-sm mb-3">🎯 Recommended actions</p>
              <div className="space-y-2">
                {latest.actions.map((action: string, i: number) => (
                  <div key={i} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                    <div className="w-5 h-5 bg-purple-100 rounded-full flex items-center justify-center text-xs font-bold text-purple-700 shrink-0 mt-0.5">{i + 1}</div>
                    <p className="text-sm text-gray-700">{action}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Competitor comparison */}
          {comparison && (comparison.competitors?.length ?? 0) > 0 && (
            <div className="card">
              <p className="font-semibold text-sm mb-4">AI Visibility — You vs Competitors</p>
              <div className="space-y-3">
                {/* Your business first */}
                <div className="flex items-center gap-3 p-3 bg-brand-50 border border-brand-200 rounded-xl">
                  <div className="w-8 h-8 bg-brand-100 rounded-lg flex items-center justify-center text-brand-700 font-bold text-xs shrink-0">You</div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-800">{comparison.business.name}</p>
                    <div className="h-2 bg-gray-100 rounded-full mt-1 overflow-hidden">
                      <div className="h-full bg-brand-500 rounded-full" style={{ width: comparison.business.score + '%' }} />
                    </div>
                  </div>
                  <p className="text-sm font-bold text-brand-600 shrink-0">{comparison.business.score}%</p>
                </div>
                {/* Competitors */}
                {comparison.competitors.map((comp: any) => (
                  <div key={comp.placeId} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <div className="w-8 h-8 bg-gray-200 rounded-lg flex items-center justify-center text-gray-600 font-bold text-xs shrink-0">C</div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-700 truncate">{comp.name}</p>
                      <div className="h-2 bg-gray-100 rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-red-400 rounded-full" style={{ width: comp.score + '%' }} />
                      </div>
                    </div>
                    <p className="text-sm font-bold text-gray-600 shrink-0">{comp.score}%</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* History chart */}
          {history.length > 1 && (
            <div className="card">
              <p className="font-semibold text-sm mb-4">Score history</p>
              <div className="flex items-end gap-2 h-24">
                {history.slice(0, 8).reverse().map((h: any, i: number) => {
                  const pct  = h.overall_score;
                  const col  = pct >= 60 ? 'bg-green-500' : pct >= 30 ? 'bg-amber-400' : 'bg-red-400';
                  const date = new Date(h.checked_at).toLocaleDateString('en', { month: 'short', day: 'numeric' });
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                      <p className="text-xs text-gray-400 font-semibold">{pct}</p>
                      <div className="w-full rounded-t-sm " style={{ height: Math.max(4, pct * 0.8) + 'px' }}>
                        <div className={`w-full h-full rounded-t-sm ${col}`} />
                      </div>
                      <p className="text-xs text-gray-400 whitespace-nowrap">{date}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-xs text-gray-400 text-center">
            Checked weekly every Wednesday · Monitors {platforms.length} AI platform{platforms.length !== 1 ? 's' : ''} · Uses zero credits for automated checks
          </p>
        </>
      )}
    </div>
  );
}
