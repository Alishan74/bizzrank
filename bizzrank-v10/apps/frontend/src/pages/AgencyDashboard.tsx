/**
 * Agency Dashboard — full multi-business control center
 *
 * Features:
 *   - All businesses in one view with health scores
 *   - Visibility score + trend per business
 *   - Review stats (unanswered, response rate, avg rating)
 *   - GBP Guard alert count with critical highlighting
 *   - AI Visibility score per business
 *   - Leaderboard rank
 *   - Quick actions: scan, reply reviews, view heatmap, download report
 *   - Sortable columns
 *   - Filter by: health status, alerts, unanswered reviews
 *   - Aggregate KPI bar at top
 *   - Signal feed (recent changes across all businesses)
 */
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';

// ── Types ────────────────────────────────────────────────────
interface BizSummary {
  id: string; name: string; address: string; category: string; keywords: string[];
  visibilityScore: number | null; scoreTrend: number | null;
  avgRanking: number | null; top3Zones: number | null; totalZones: number | null;
  lastScanned: string | null; lastScanKeyword: string | null;
  reviews: { total: number; unanswered: number; avgRating: number | null; responseRate: number | null };
  gbpAlerts: { total: number; critical: number };
  aiVisibility: { score: number; discovery: number; trend: string } | null;
  leaderboardRank: number | null;
  hasActiveScan: boolean;
  health: number;
}

// ── Helpers ───────────────────────────────────────────────────
function HealthBar({ score }: { score: number }) {
  const color = score >= 70 ? 'bg-green-500' : score >= 40 ? 'bg-amber-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: score + '%' }} />
      </div>
      <span className={`text-xs font-bold ${score >= 70 ? 'text-green-600' : score >= 40 ? 'text-amber-600' : 'text-red-600'}`}>{score}</span>
    </div>
  );
}

function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-gray-300 text-sm">—</span>;
  const color = score >= 60 ? 'text-green-600 bg-green-50' : score >= 30 ? 'text-amber-600 bg-amber-50' : 'text-red-600 bg-red-50';
  return <span className={`text-sm font-bold px-2 py-0.5 rounded-lg ${color}`}>{score}</span>;
}

function TrendArrow({ v }: { v: number | null }) {
  if (v === null) return null;
  if (v > 2)  return <span className="text-xs text-green-500 font-bold">↑{Math.round(v)}</span>;
  if (v < -2) return <span className="text-xs text-red-500 font-bold">↓{Math.abs(Math.round(v))}</span>;
  return <span className="text-xs text-gray-400">→</span>;
}

type SortKey = 'health' | 'visibilityScore' | 'reviews.unanswered' | 'gbpAlerts.critical' | 'name';
type FilterKey = 'all' | 'needs_attention' | 'has_alerts' | 'unanswered_reviews';

export default function AgencyDashboard() {
  const nav = useNavigate();
  const [sort, setSort]   = useState<SortKey>('health');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter]   = useState<FilterKey>('all');
  const [search, setSearch]   = useState('');
  const [showSignals, setShowSignals] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['agency-overview'],
    queryFn:  () => api.get('/agency/overview').then(r => r.data),
    refetchInterval: 60000,
  });

  const { data: signalData } = useQuery({
    queryKey: ['agency-signals'],
    queryFn:  () => api.get('/agency/signals').then(r => r.data),
    enabled:  showSignals,
  });

  const businesses: BizSummary[] = data?.businesses ?? [];
  const agg = data?.aggregate ?? {};

  // Filter
  const filtered = businesses
    .filter(b => {
      if (search && !b.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (filter === 'needs_attention') return b.health < 50 || b.gbpAlerts.critical > 0;
      if (filter === 'has_alerts')      return b.gbpAlerts.critical > 0;
      if (filter === 'unanswered_reviews') return b.reviews.unanswered > 0;
      return true;
    })
    .sort((a, b) => {
      const getVal = (x: BizSummary, k: SortKey): number => {
        if (k === 'health')                   return x.health;
        if (k === 'visibilityScore')          return x.visibilityScore ?? -1;
        if (k === 'reviews.unanswered')       return x.reviews.unanswered;
        if (k === 'gbpAlerts.critical')       return x.gbpAlerts.critical;
        return 0;
      };
      if (sort === 'name') return sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      const diff = getVal(a, sort) - getVal(b, sort);
      return sortDir === 'desc' ? -diff : diff;
    });

  function toggleSort(key: SortKey) {
    if (sort === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSort(key); setSortDir('desc'); }
  }

  const SortTh = ({ label, k }: { label: string; k: SortKey }) => (
    <th onClick={() => toggleSort(k)} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase cursor-pointer hover:text-gray-700 select-none whitespace-nowrap">
      {label} {sort === k ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  );

  if (isLoading) return (
    <div className="space-y-4">
      {[1,2,3].map(i => <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />)}
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── Page header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agency Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">All {businesses.length} location{businesses.length !== 1 ? 's' : ''} at a glance</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowSignals(s => !s)}
            className={`text-sm px-3 py-2 rounded-xl border font-medium transition-colors ${showSignals ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
            ⚡ Signal Feed
          </button>
          <button onClick={() => nav('/organic/new')} className="btn-primary text-sm">+ New Scan</button>
        </div>
      </div>

      {/* ── KPI aggregate bar ── */}
      {businesses.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Locations',         val: agg.totalBusinesses,                color: 'text-gray-800'  },
            { label: 'Avg Visibility',    val: agg.avgVisibility !== null ? agg.avgVisibility + '/100' : '—', color: agg.avgVisibility >= 60 ? 'text-green-600' : agg.avgVisibility >= 30 ? 'text-amber-600' : 'text-red-600' },
            { label: 'Unanswered Reviews',val: agg.totalUnanswered,                color: agg.totalUnanswered > 0 ? 'text-amber-600' : 'text-green-600' },
            { label: 'Critical GBP Alerts',val: agg.totalCritAlerts,               color: agg.totalCritAlerts > 0 ? 'text-red-600' : 'text-green-600' },
            { label: 'Avg Health',        val: agg.avgHealth + '%',               color: agg.avgHealth >= 70 ? 'text-green-600' : agg.avgHealth >= 40 ? 'text-amber-600' : 'text-red-600' },
            { label: 'Need Attention',    val: agg.businessesNeedingAttention,     color: agg.businessesNeedingAttention > 0 ? 'text-red-600' : 'text-green-600' },
          ].map(k => (
            <div key={k.label} className="bg-white rounded-xl border border-gray-100 p-3 text-center">
              <p className={`text-xl font-black ${k.color}`}>{k.val}</p>
              <p className="text-xs text-gray-400 mt-0.5">{k.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Signal feed sidebar ── */}
      {showSignals && (
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <h3 className="font-semibold text-sm mb-3">⚡ Recent signals across all locations</h3>
          {!signalData?.signals?.length ? (
            <p className="text-sm text-gray-400 text-center py-4">No signals yet — run scans to detect ranking changes</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {signalData.signals.slice(0, 20).map((s: any) => (
                <div key={s.id} className="flex items-start gap-3 p-2.5 bg-gray-50 rounded-lg">
                  <span className="text-base">{s.signal_type === 'RankingDelta' && s.direction === 'up' ? '📈' : s.signal_type === 'RankingDelta' ? '📉' : s.signal_type === 'ReviewDelta' ? '⭐' : '⚡'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-gray-700">{s.businesses?.name ?? 'Business'}</p>
                    <p className="text-xs text-gray-500">
                      {s.signal_type === 'RankingDelta' ? `Ranking ${s.direction === 'up' ? 'improved' : 'dropped'} ${Math.round(s.value)} positions` :
                       s.signal_type === 'ReviewDelta' ? `${Math.round(s.value)} new reviews` :
                       s.signal_type}
                    </p>
                  </div>
                  <p className="text-xs text-gray-400 shrink-0">{new Date(s.detected_at).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Filter + Search bar ── */}
      <div className="flex flex-wrap gap-3 items-center">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search location..." className="input max-w-xs text-sm" />
        <div className="flex gap-1.5">
          {([
            { key: 'all', label: 'All' },
            { key: 'needs_attention', label: '⚠️ Needs attention' },
            { key: 'has_alerts', label: '🚨 Has alerts' },
            { key: 'unanswered_reviews', label: '⭐ Unanswered' },
          ] as const).map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${filter === f.key ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400 ml-auto">{filtered.length} of {businesses.length} locations</span>
      </div>

      {/* ── Main table ── */}
      {businesses.length === 0 ? (
        <div className="card text-center py-16">
          <p className="text-4xl mb-4">🏢</p>
          <p className="font-semibold text-gray-700 mb-2">No businesses yet</p>
          <p className="text-sm text-gray-400 mb-4">Add your first business to see the agency dashboard</p>
          <button onClick={() => nav('/businesses')} className="btn-primary">Add business</button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <SortTh label="Business" k="name" />
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">Keywords</th>
                  <SortTh label="Health" k="health" />
                  <SortTh label="Visibility" k="visibilityScore" />
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">Top 3 Zones</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">AI Vis</th>
                  <SortTh label="Reviews" k="reviews.unanswered" />
                  <SortTh label="GBP Alerts" k="gbpAlerts.critical" />
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">Rank</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(biz => (
                  <tr key={biz.id} className={`hover:bg-gray-50 transition-colors ${biz.gbpAlerts.critical > 0 ? 'bg-red-50/30' : biz.health < 40 ? 'bg-amber-50/30' : ''}`}>
                    {/* Business name */}
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-semibold text-gray-800 leading-tight">{biz.name}</p>
                        <p className="text-xs text-gray-400 truncate max-w-[160px]">{biz.address}</p>
                        {biz.hasActiveScan && (
                          <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-medium">Scanning…</span>
                        )}
                      </div>
                    </td>

                    {/* Keywords */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {biz.keywords.slice(0, 2).map(k => (
                          <span key={k} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{k}</span>
                        ))}
                        {biz.keywords.length > 2 && <span className="text-xs text-gray-400">+{biz.keywords.length - 2}</span>}
                        {biz.keywords.length === 0 && <span className="text-xs text-amber-500">No keywords</span>}
                      </div>
                    </td>

                    {/* Health */}
                    <td className="px-4 py-3"><HealthBar score={biz.health} /></td>

                    {/* Visibility score + trend */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <ScorePill score={biz.visibilityScore} />
                        <TrendArrow v={biz.scoreTrend} />
                      </div>
                      {biz.lastScanned && (
                        <p className="text-xs text-gray-400 mt-0.5">{new Date(biz.lastScanned).toLocaleDateString()}</p>
                      )}
                    </td>

                    {/* Top 3 zones */}
                    <td className="px-4 py-3">
                      {biz.top3Zones !== null ? (
                        <span className="text-sm font-semibold text-gray-700">
                          {biz.top3Zones}/{biz.totalZones ?? 25}
                        </span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    {/* AI Visibility */}
                    <td className="px-4 py-3">
                      {biz.aiVisibility ? (
                        <div className="flex items-center gap-1.5">
                          <span className={`text-sm font-bold ${biz.aiVisibility.score >= 50 ? 'text-green-600' : biz.aiVisibility.score >= 25 ? 'text-amber-600' : 'text-red-500'}`}>
                            {biz.aiVisibility.score}
                          </span>
                          <span className="text-xs">{biz.aiVisibility.trend === 'improving' ? '📈' : biz.aiVisibility.trend === 'declining' ? '📉' : ''}</span>
                        </div>
                      ) : <span className="text-gray-300 text-sm">—</span>}
                    </td>

                    {/* Reviews */}
                    <td className="px-4 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          {biz.reviews.avgRating && (
                            <span className="text-xs font-semibold text-amber-600">★ {biz.reviews.avgRating}</span>
                          )}
                          {biz.reviews.unanswered > 0 && (
                            <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">
                              {biz.reviews.unanswered} unanswered
                            </span>
                          )}
                        </div>
                        {biz.reviews.responseRate !== null && (
                          <p className="text-xs text-gray-400 mt-0.5">{biz.reviews.responseRate}% response rate</p>
                        )}
                      </div>
                    </td>

                    {/* GBP Alerts */}
                    <td className="px-4 py-3">
                      {biz.gbpAlerts.total === 0 ? (
                        <span className="text-xs text-green-600 font-medium">✓ Clear</span>
                      ) : (
                        <div>
                          {biz.gbpAlerts.critical > 0 && (
                            <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold block mb-0.5">
                              🚨 {biz.gbpAlerts.critical} critical
                            </span>
                          )}
                          {biz.gbpAlerts.total > biz.gbpAlerts.critical && (
                            <span className="text-xs text-gray-500">{biz.gbpAlerts.total - biz.gbpAlerts.critical} other</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Leaderboard rank */}
                    <td className="px-4 py-3">
                      {biz.leaderboardRank ? (
                        <span className={`text-sm font-bold ${biz.leaderboardRank === 1 ? 'text-yellow-500' : biz.leaderboardRank <= 3 ? 'text-green-600' : 'text-gray-500'}`}>
                          {biz.leaderboardRank === 1 ? '🥇' : biz.leaderboardRank === 2 ? '🥈' : biz.leaderboardRank === 3 ? '🥉' : '#' + biz.leaderboardRank}
                        </span>
                      ) : <span className="text-gray-300 text-sm">—</span>}
                    </td>

                    {/* Quick actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => nav('/organic/new')} title="New scan"
                          className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 flex items-center justify-center text-xs font-bold transition-colors">
                          🔍
                        </button>
                        <button onClick={() => nav('/reviews')} title="View reviews"
                          className="w-7 h-7 rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-100 flex items-center justify-center text-xs transition-colors">
                          ⭐
                        </button>
                        <button onClick={() => nav('/gbp-guard')} title="GBP Guard"
                          className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors ${biz.gbpAlerts.critical > 0 ? 'bg-red-100 text-red-600 hover:bg-red-200 animate-pulse' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>
                          🛡️
                        </button>
                        <button onClick={() => nav('/ai-visibility')} title="AI Visibility"
                          className="w-7 h-7 rounded-lg bg-purple-50 text-purple-600 hover:bg-purple-100 flex items-center justify-center text-xs transition-colors">
                          🤖
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              const r = await api.get(`/reports/business/${biz.id}?agencyName=BizzRank`, { responseType: 'text' });
                              const w = window.open('', '_blank');
                              w?.document.write(r.data); w?.document.close();
                            } catch { alert('Report generation failed'); }
                          }}
                          title="Download report"
                          className="w-7 h-7 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 flex items-center justify-center text-xs transition-colors">
                          📄
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Legend ── */}
      <div className="flex flex-wrap gap-4 text-xs text-gray-400">
        <span>🔍 New scan</span>
        <span>⭐ Reviews</span>
        <span>🛡️ GBP Guard</span>
        <span>🤖 AI Visibility</span>
        <span>📄 PDF Report</span>
        <span className="ml-auto">Health = Visibility (50%) + Response rate (30%) + No critical alerts (20%)</span>
      </div>
    </div>
  );
}
