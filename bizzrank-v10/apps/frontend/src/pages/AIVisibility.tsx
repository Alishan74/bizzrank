import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bizApi, aiVisibilityApi } from '../lib/api';
import CitationsTab from '../components/CitationsTab';

const PLATFORM_META: Record<string, { label: string; icon: string; color: string; bg: string; border: string }> = {
  chatgpt:    { label:'ChatGPT',    icon:'🤖', color:'text-green-700',  bg:'bg-green-50',  border:'border-green-200'  },
  perplexity: { label:'Perplexity', icon:'🔮', color:'text-purple-700', bg:'bg-purple-50', border:'border-purple-200' },
  gemini:     { label:'Gemini',     icon:'✨', color:'text-blue-700',   bg:'bg-blue-50',   border:'border-blue-200'   },
};

const SEVERITY_STYLE = {
  critical: { bg:'bg-red-50',   border:'border-red-200',   badge:'bg-red-100 text-red-700',   icon:'🚨' },
  high:     { bg:'bg-amber-50', border:'border-amber-200', badge:'bg-amber-100 text-amber-700',icon:'⚠️' },
  medium:   { bg:'bg-blue-50',  border:'border-blue-200',  badge:'bg-blue-100 text-blue-700',  icon:'ℹ️' },
};

function ScoreRing({ score, size = 80, label = '' }: { score: number; size?: number; label?: string }) {
  const r      = (size / 2) - 8;
  const circ   = 2 * Math.PI * r;
  const offset = circ - (Math.max(0, Math.min(100, score)) / 100) * circ;
  const color  = score >= 60 ? '#1D9E75' : score >= 30 ? '#F59E0B' : '#EF4444';
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#E5E7EB" strokeWidth="8"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`}/>
        <text x={size/2} y={size/2+1} textAnchor="middle" dominantBaseline="middle"
          fontSize={size*0.22} fontWeight="bold" fill={color}>{score}</text>
      </svg>
      {label && <p className="text-xs text-gray-400 text-center">{label}</p>}
    </div>
  );
}

function SentimentBadge({ score }: { score: number }) {
  if (score >= 30)  return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">😊 Positive ({score})</span>;
  if (score <= -30) return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">😟 Negative ({score})</span>;
  return <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">😐 Neutral ({score})</span>;
}

export default function AIVisibilityPage() {
  const qc = useQueryClient();
  const [selectedBizId, setSelectedBizId] = useState('');
  const [activeTab, setActiveTab] = useState<'overview'|'insights'|'history'|'prompts'>('overview');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses),
    onSuccess: (d: any[]) => { if (d?.length && !selectedBizId) setSelectedBizId(d[0].id); },
  });

  const bizId = selectedBizId || businesses?.[0]?.id || '';

  const { data: statusData, isLoading } = useQuery({
    queryKey:        ['ai-visibility', bizId],
    queryFn:         () => aiVisibilityApi.status(bizId).then(r => r.data),
    enabled:         !!bizId,
    refetchInterval: 60000,
  });

  const checkMutation = useMutation({
    mutationFn: () => aiVisibilityApi.check(bizId),
    onSuccess:  () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-visibility', bizId] }), 12000);
    },
  });

  const latest        = statusData?.latest;
  const history       = statusData?.history ?? [];
  const platforms     = statusData?.configuredPlatforms ?? [];
  const isConfigured  = statusData?.isConfigured ?? false;

  const platformGaps:   any[] = latest?.platform_gaps   ?? [];
  const rootCauses:     any[] = latest?.root_causes      ?? [];
  const competitorGaps: any[] = latest?.competitor_gaps  ?? [];
  const actions:        any[] = latest?.actions           ?? [];
  const promptResults:  any[] = latest?.prompt_results    ?? [];

  const TABS = [
    { id:'overview',  label:'Overview'  },
    { id:'insights',  label:'Insights'  },
    { id:'history',   label:'History'   },
    { id:'prompts',   label:'Prompts'   },
    { id:'citations', label:'Citations ✨' },
  ] as const;

  return (
    <div className="max-w-4xl space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-purple-100 rounded-2xl flex items-center justify-center text-2xl">🤖</div>
          <div>
            <h1 className="text-xl font-bold">AI Visibility</h1>
            <p className="text-sm text-gray-400">
              Tracks ChatGPT, Gemini & Perplexity · 3 runs per prompt · Intent-weighted scoring · Checked weekly
            </p>
          </div>
        </div>
        {isConfigured && (
          <button onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending || !bizId}
            className="btn-primary text-sm px-4 py-2">
            {checkMutation.isPending ? '⟳ Running...' : '▶ Run Check — 25cr'}
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

      {/* Not configured */}
      {!isLoading && !isConfigured && (
        <div className="card bg-amber-50 border-2 border-amber-200 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚠️</span>
            <p className="font-semibold text-amber-900">API keys not configured</p>
          </div>
          <div className="font-mono text-xs bg-white rounded-xl p-3 border border-amber-200 space-y-1 text-gray-700">
            <p>OPENAI_API_KEY=sk-...         <span className="text-gray-400"># ChatGPT</span></p>
            <p>PERPLEXITY_API_KEY=pplx-...   <span className="text-gray-400"># Perplexity</span></p>
            <p>GEMINI_API_KEY=...            <span className="text-gray-400"># Already set if you use AI replies</span></p>
          </div>
          <p className="text-xs text-amber-600">If GEMINI_API_KEY is already set, Gemini tracking starts automatically.</p>
        </div>
      )}

      {/* No data yet */}
      {isConfigured && !isLoading && !latest && (
        <div className="card text-center py-12">
          <p className="text-4xl mb-3">🤖</p>
          <p className="font-semibold">No AI visibility data yet</p>
          <p className="text-sm text-gray-400 mt-1 mb-5">
            Automated checks run every Wednesday 3am UTC. Or run manually below.
          </p>
          <button onClick={() => checkMutation.mutate()} disabled={checkMutation.isPending} className="btn-primary">
            {checkMutation.isPending ? 'Running...' : 'Run First Check — 25 credits'}
          </button>
        </div>
      )}

      {latest && (
        <>
          {/* Tabs */}
          <div className="flex border-b border-gray-200">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className={'px-4 py-2.5 text-sm font-medium transition-colors ' +
                  (activeTab === t.id ? 'border-b-2 border-purple-500 text-purple-700' : 'text-gray-500 hover:text-gray-700')}>
                {t.label}
                {t.id === 'insights' && (rootCauses.length + platformGaps.length) > 0 && (
                  <span className="ml-1.5 bg-red-100 text-red-700 text-xs px-1.5 py-0.5 rounded-full font-bold">
                    {rootCauses.length + platformGaps.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ── OVERVIEW TAB ── */}
          {activeTab === 'overview' && (
            <div className="space-y-4">

              {/* Top insight */}
              {latest.top_insight && (
                <div className="card bg-purple-50 border border-purple-200">
                  <div className="flex gap-3">
                    <span className="text-xl shrink-0">💡</span>
                    <p className="text-sm text-purple-800">{latest.top_insight}</p>
                  </div>
                </div>
              )}

              {/* 6 metric cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="card text-center">
                  <ScoreRing score={latest.overall_score} size={70} />
                  <p className="text-xs text-gray-500 mt-2">Overall Score</p>
                </div>
                <div className="card text-center">
                  <ScoreRing score={latest.discovery_score ?? 0} size={70} />
                  <p className="text-xs text-gray-500 mt-2">Discovery Score</p>
                  <p className="text-xs text-gray-400">New customers</p>
                </div>
                <div className="card text-center flex flex-col items-center justify-center gap-2">
                  <p className="text-2xl font-black" style={{ color: latest.share_of_voice >= 30 ? '#1D9E75' : '#F59E0B' }}>
                    {latest.share_of_voice ?? 0}%
                  </p>
                  <p className="text-xs text-gray-500">Share of Voice</p>
                  <p className="text-xs text-gray-400">First recommendations</p>
                </div>
                <div className="card text-center flex flex-col items-center justify-center gap-2">
                  <p className="text-2xl font-black" style={{ color: latest.reliability >= 50 ? '#1D9E75' : '#F59E0B' }}>
                    {latest.reliability ?? 0}%
                  </p>
                  <p className="text-xs text-gray-500">Reliability</p>
                  <p className="text-xs text-gray-400">Consistent appearances</p>
                </div>
                <div className="card text-center flex flex-col items-center justify-center gap-2">
                  <SentimentBadge score={latest.sentiment_score ?? 0} />
                  <p className="text-xs text-gray-500 mt-1">Sentiment</p>
                  <p className="text-xs text-gray-400">How AI describes you</p>
                </div>
                <div className="card text-center flex flex-col items-center justify-center gap-2">
                  <p className={'text-2xl font-black ' + (latest.trend === 'improving' ? 'text-green-600' : latest.trend === 'declining' ? 'text-red-500' : 'text-gray-600')}>
                    {latest.trend === 'improving' ? '↑' : latest.trend === 'declining' ? '↓' : '→'}
                    {Math.abs(latest.trend_delta ?? 0)}
                  </p>
                  <p className="text-xs text-gray-500">Trend</p>
                  <p className="text-xs text-gray-400">vs last check</p>
                </div>
              </div>

              {/* Platform scores */}
              <div className="card">
                <p className="font-semibold text-sm mb-4">Score by AI platform</p>
                <div className="space-y-3">
                  {Object.entries(PLATFORM_META).map(([key, meta]) => {
                    const score  = latest[`${key}_score`] ?? 0;
                    const active = platforms.includes(key);
                    return (
                      <div key={key} className={'flex items-center gap-3 p-3 rounded-xl border ' + meta.bg + ' ' + meta.border + (!active ? ' opacity-40' : '')}>
                        <span className="text-xl">{meta.icon}</span>
                        <div className="flex-1">
                          <div className="flex justify-between mb-1.5">
                            <p className={'text-xs font-semibold ' + meta.color}>{meta.label}</p>
                            <p className={'text-sm font-bold ' + meta.color}>{active ? score + '%' : 'Not configured'}</p>
                          </div>
                          <div className="h-2 bg-white rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all"
                              style={{ width: active ? score + '%' : '0%', background: score >= 60 ? '#1D9E75' : score >= 30 ? '#F59E0B' : '#EF4444' }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Quotes */}
              {(latest.best_quote || latest.worst_quote) && (
                <div className="grid grid-cols-2 gap-3">
                  {latest.best_quote && (
                    <div className="card bg-green-50 border border-green-200">
                      <p className="text-xs font-semibold text-green-700 mb-2">✅ Best AI quote about you</p>
                      <p className="text-sm text-green-800 italic">"{latest.best_quote}"</p>
                    </div>
                  )}
                  {latest.worst_quote && (
                    <div className="card bg-red-50 border border-red-200">
                      <p className="text-xs font-semibold text-red-700 mb-2">⚠️ Most negative AI quote</p>
                      <p className="text-sm text-red-800 italic">"{latest.worst_quote}"</p>
                    </div>
                  )}
                </div>
              )}

              {/* Competitor comparison */}
              {competitorGaps.length > 0 && (
                <div className="card">
                  <p className="font-semibold text-sm mb-4">🏆 Competitor AI visibility gap</p>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 p-3 bg-brand-50 border border-brand-200 rounded-xl">
                      <div className="w-8 h-8 bg-brand-100 rounded-lg flex items-center justify-center text-xs font-bold text-brand-700">You</div>
                      <div className="flex-1">
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-brand-500 rounded-full" style={{ width: latest.overall_score + '%' }} />
                        </div>
                      </div>
                      <p className="text-sm font-bold text-brand-600">{latest.overall_score}%</p>
                    </div>
                    {competitorGaps.map((gap: any) => (
                      <div key={gap.competitorName}>
                        <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                          <div className="w-8 h-8 bg-gray-200 rounded-lg flex items-center justify-center text-xs font-bold text-gray-600">C</div>
                          <div className="flex-1">
                            <p className="text-xs font-semibold text-gray-700 mb-1 truncate">{gap.competitorName} <span className="text-red-500">(+{gap.gap} ahead)</span></p>
                            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-red-400 rounded-full" style={{ width: gap.competitorScore + '%' }} />
                            </div>
                          </div>
                          <p className="text-sm font-bold text-gray-600">{gap.competitorScore}%</p>
                        </div>
                        {gap.likelyReasons?.slice(0, 1).map((r: string, i: number) => (
                          <p key={i} className="text-xs text-gray-400 mt-1 ml-11">{r}</p>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs text-gray-400 text-center">
                {latest.prompts_tested} prompts × 3 runs each = {latest.total_runs} total AI queries ·
                {platforms.length} platform{platforms.length !== 1 ? 's' : ''} ·
                {new Date(latest.checked_at).toLocaleDateString()}
              </p>
            </div>
          )}

          {/* ── INSIGHTS TAB ── */}
          {activeTab === 'insights' && (
            <div className="space-y-4">

              {/* Prioritized actions */}
              {actions.length > 0 && (
                <div className="card">
                  <p className="font-semibold text-sm mb-4">🎯 Prioritized actions</p>
                  <div className="space-y-3">
                    {actions.map((a: any, i: number) => (
                      <div key={i} className="flex gap-3 p-3 bg-gray-50 rounded-xl">
                        <div className={'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ' +
                          (a.priority === 1 ? 'bg-red-100 text-red-700' : a.priority === 2 ? 'bg-amber-100 text-amber-700' : 'bg-gray-200 text-gray-600')}>
                          {a.priority}
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-sm font-semibold text-gray-800">{a.action}</p>
                            {a.platform !== 'all' && (
                              <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">{a.platform}</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500">{a.reasoning}</p>
                          {a.impact && <p className="text-xs text-green-600 font-medium mt-1">📈 {a.impact}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Root causes */}
              {rootCauses.length > 0 && (
                <div className="card">
                  <p className="font-semibold text-sm mb-4">🔍 Root cause analysis — using your BizzRank data</p>
                  <div className="space-y-3">
                    {rootCauses.map((cause: any, i: number) => {
                      const sev = SEVERITY_STYLE[cause.severity as keyof typeof SEVERITY_STYLE] ?? SEVERITY_STYLE.medium;
                      return (
                        <div key={i} className={`p-4 rounded-xl border ${sev.bg} ${sev.border}`}>
                          <div className="flex items-center gap-2 mb-2">
                            <span>{sev.icon}</span>
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${sev.badge}`}>{cause.severity}</span>
                            <p className="text-sm font-semibold text-gray-800">{cause.issue}</p>
                          </div>
                          <p className="text-xs text-gray-600">{cause.evidence}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Platform gaps */}
              {platformGaps.length > 0 && (
                <div className="card">
                  <p className="font-semibold text-sm mb-4">📱 Platform-specific gaps</p>
                  <div className="space-y-4">
                    {platformGaps.map((gap: any, i: number) => {
                      const meta = PLATFORM_META[gap.platform];
                      return (
                        <div key={i} className={`p-4 rounded-xl border ${meta?.bg} ${meta?.border}`}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-lg">{meta?.icon}</span>
                            <p className={`font-semibold text-sm ${meta?.color}`}>{meta?.label} — {gap.score}%</p>
                          </div>
                          <p className="text-xs text-gray-600 mb-2">{gap.primaryReason}</p>
                          <div className="bg-white rounded-lg p-3 border border-gray-100">
                            <p className="text-xs font-semibold text-gray-700 mb-1">How to fix:</p>
                            <p className="text-xs text-gray-600">{gap.specificFix}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── HISTORY TAB ── */}
          {activeTab === 'history' && (
            <div className="space-y-4">
              {history.length > 1 ? (
                <>
                  {/* Chart */}
                  <div className="card">
                    <p className="font-semibold text-sm mb-4">Score trend</p>
                    <div className="flex items-end gap-2 h-32">
                      {history.slice(0, 8).reverse().map((h: any, i: number) => {
                        const pct  = h.overall_score;
                        const col  = pct >= 60 ? 'bg-green-500' : pct >= 30 ? 'bg-amber-400' : 'bg-red-400';
                        const date = new Date(h.checked_at).toLocaleDateString('en', { month:'short', day:'numeric' });
                        return (
                          <div key={i} className="flex-1 flex flex-col items-center gap-1">
                            <p className="text-xs font-semibold text-gray-500">{pct}</p>
                            <div className="w-full flex items-end" style={{ height:'80px' }}>
                              <div className={`w-full rounded-t-sm ${col}`} style={{ height: Math.max(4, pct * 0.8) + 'px' }} />
                            </div>
                            <p className="text-xs text-gray-400 whitespace-nowrap">{date}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* History list */}
                  <div className="space-y-2">
                    {history.map((h: any, i: number) => (
                      <div key={i} className="card flex items-center gap-4">
                        <div className="w-12 h-12 shrink-0">
                          <ScoreRing score={h.overall_score} size={48} />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold">{h.overall_score}/100</p>
                            <span className={'text-xs px-1.5 py-0.5 rounded-full ' + (h.trend === 'improving' ? 'bg-green-100 text-green-700' : h.trend === 'declining' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600')}>
                              {h.trend === 'improving' ? '↑' : h.trend === 'declining' ? '↓' : '→'}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400">{h.prompts_tested} prompts · {h.total_runs} runs</p>
                        </div>
                        <p className="text-xs text-gray-400 shrink-0">{new Date(h.checked_at).toLocaleDateString()}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="card text-center py-8">
                  <p className="text-gray-400 text-sm">Run at least 2 checks to see trend history.</p>
                </div>
              )}
            </div>
          )}

          {/* ── PROMPTS TAB ── */}
          {activeTab === 'prompts' && (
            <div className="space-y-3">
              <div className="card bg-blue-50 border border-blue-200">
                <p className="text-xs text-blue-700">
                  Each prompt is run <strong>3 times</strong> across platforms at varying temperatures.
                  Appearance rate shows how consistently you appeared (3/3 = 100%, 2/3 = 67%, 1/3 = 33%).
                  Intent: <span className="font-semibold">Discovery</span> (3× weight) · <span className="font-semibold">Urgent</span> (2.5×) ·
                  <span className="font-semibold"> Comparison/Specific</span> (2×) · <span className="font-semibold">Brand</span> (0.5×)
                </p>
              </div>
              {promptResults.slice(0, 30).map((r: any, i: number) => {
                const rate    = Math.round((r.appearanceRate ?? 0) * 100);
                const col     = rate >= 67 ? 'bg-green-500' : rate >= 33 ? 'bg-amber-400' : 'bg-red-400';
                const intCol  = r.intent === 'discovery' ? 'bg-purple-100 text-purple-700' :
                                r.intent === 'urgent' ? 'bg-red-100 text-red-700' :
                                r.intent === 'comparison' ? 'bg-blue-100 text-blue-700' :
                                r.intent === 'specific' ? 'bg-green-100 text-green-700' :
                                'bg-gray-100 text-gray-600';
                const plMeta  = PLATFORM_META[r.platform];
                return (
                  <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl text-sm">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${col}`} />
                    <p className="flex-1 text-gray-700 text-xs">{r.prompt}</p>
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${intCol}`}>{r.intent}</span>
                    <span className="text-xs text-gray-400 shrink-0">{plMeta?.icon}</span>
                    <span className="text-xs font-bold text-gray-700 shrink-0 w-10 text-right">{rate}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
