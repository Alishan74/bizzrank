/**
 * Agency Dashboard v2 — Full control center
 *
 * Tabs: Overview · Clients · Analytics · Work Queue · Credits
 *
 * New in v2:
 *   - Analytics tab: visibility trend chart, response rate, client stats
 *   - Client status badges (Active/Paused/Churned) with quick toggle
 *   - Bulk scan trigger per client
 *   - Report token rotation (invalidate old URL, generate new)
 *   - Export all data as JSON
 *   - Search + filter clients by status
 *   - Inline credit budget editing in the overview table
 *   - Monthly fee display in dollars (not cents) with proper input
 *   - Client health score breakdown tooltip
 *   - Quick stats banner per client in the list view
 *   - Resolve all tasks at once button
 *   - Task filter by client
 *   - Keyboard shortcut: press N to add new client
 */
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { agencyApi, bizApi } from '../lib/api';

// ── Constants ──────────────────────────────────────────────────
const PRIORITY_STYLE = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  high:     'bg-amber-100 text-amber-700 border-amber-200',
  medium:   'bg-blue-50  text-blue-700  border-blue-200',
  low:      'bg-gray-50  text-gray-500  border-gray-200',
};
const PRIORITY_ICON  = { critical:'🚨', high:'⚠️', medium:'📋', low:'ℹ️' };
const TASK_LABEL     = { gbp_alert:'GBP Alert', unanswered_reviews:'Reviews', low_visibility:'Visibility' } as Record<string,string>;
const STATUS_STYLE   = {
  active:  'bg-green-100 text-green-700',
  paused:  'bg-amber-100 text-amber-700',
  churned: 'bg-red-100   text-red-600',
};

// ── Small reusable components ──────────────────────────────────
function ScoreBadge({ v }: { v: number | null }) {
  if (v === null) return <span className="text-gray-300 text-xs">—</span>;
  const c = v >= 60 ? 'bg-green-100 text-green-700' : v >= 30 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${c}`}>{v}</span>;
}

function MiniBar({ pct, warn }: { pct: number; warn?: boolean }) {
  const c = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : warn ? 'bg-amber-400' : 'bg-brand-500';
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${c}`} style={{ width: Math.min(100, pct) + '%' }} />
      </div>
      <span className="text-xs text-gray-500">{pct}%</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[status as keyof typeof STATUS_STYLE] ?? 'bg-gray-100 text-gray-500'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ── Mini bar chart for analytics ──────────────────────────────
function BarChart({ data, label }: { data: { month: string; avgScore: number }[]; label: string }) {
  const max = Math.max(...data.map(d => d.avgScore), 1);
  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 mb-3">{label}</p>
      <div className="flex items-end gap-2 h-24">
        {data.map(d => (
          <div key={d.month} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-xs text-gray-500 font-medium">{d.avgScore}</span>
            <div className="w-full rounded-t-lg transition-all"
              style={{
                height: Math.round((d.avgScore / max) * 72) + 'px',
                background: d.avgScore >= 60 ? '#1D9E75' : d.avgScore >= 30 ? '#F59E0B' : '#EF4444',
                minHeight: '4px',
              }} />
            <span className="text-xs text-gray-400">{d.month.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────
type Tab = 'overview' | 'clients' | 'analytics' | 'queue' | 'credits';

export default function AgencyDashboard() {
  const nav = useNavigate();
  const qc  = useQueryClient();

  const [tab,             setTab]             = useState<Tab>('overview');
  const [showAddClient,   setShowAddClient]   = useState(false);
  const [selectedClient,  setSelectedClient]  = useState<any>(null);
  const [clientSearch,    setClientSearch]    = useState('');
  const [statusFilter,    setStatusFilter]    = useState<'all'|'active'|'paused'|'churned'>('all');
  const [taskClientFilter, setTaskClientFilter] = useState<string>('all');
  const [generatingTasks, setGeneratingTasks] = useState(false);
  const [noteText,        setNoteText]        = useState('');
  const [copied,          setCopied]          = useState<string|null>(null);
  const [newClient, setNewClient] = useState({
    name: '', contactName: '', contactEmail: '',
    monthlyFeeDollars: 0, monthlyBudget: 0, notes: '',
  });

  // Keyboard shortcut: N = new client
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey &&
          !(e.target as HTMLElement)?.matches('input,textarea')) {
        setShowAddClient(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Queries ────────────────────────────────────────────────
  const { data, isLoading } = useQuery({
    queryKey: ['agency-dashboard'],
    queryFn:  () => agencyApi.dashboard().then(r => r.data),
    refetchInterval: 60000,
  });

  const { data: queueData, refetch: refetchQueue } = useQuery({
    queryKey: ['agency-queue'],
    queryFn:  () => agencyApi.workQueue().then(r => r.data),
    enabled:  tab === 'queue',
  });

  const { data: creditsData } = useQuery({
    queryKey: ['agency-credits'],
    queryFn:  () => agencyApi.credits().then(r => r.data),
    enabled:  tab === 'credits',
  });

  const { data: analyticsData } = useQuery({
    queryKey: ['agency-analytics'],
    queryFn:  () => agencyApi.analytics().then(r => r.data),
    enabled:  tab === 'analytics',
  });

  const { data: clientDetail } = useQuery({
    queryKey: ['agency-client', selectedClient?.clientId],
    queryFn:  () => agencyApi.getClient(selectedClient.clientId).then(r => r.data),
    enabled:  !!selectedClient?.clientId,
  });

  const { data: bizList } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses ?? r.data),
    enabled:  !!selectedClient,
  });

  // ── Mutations ──────────────────────────────────────────────
  const createClient = useMutation({
    mutationFn: (d: any) => agencyApi.createClient(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agency-dashboard'] });
      setShowAddClient(false);
      setNewClient({ name:'', contactName:'', contactEmail:'', monthlyFeeDollars:0, monthlyBudget:0, notes:'' });
    },
  });

  const deleteClient = useMutation({
    mutationFn: (id: string) => agencyApi.deleteClient(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); setSelectedClient(null); },
  });

  const updateClient = useMutation({
    mutationFn: ({ id, data }: any) => agencyApi.updateClient(id, data),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: any) => agencyApi.setStatus(id, status),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); },
  });

  const rotateToken = useMutation({
    mutationFn: (id: string) => agencyApi.rotateToken(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); },
  });

  const resolveTask = useMutation({
    mutationFn: (id: string) => agencyApi.resolveTask(id),
    onSuccess:  () => { refetchQueue(); qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); },
  });

  const addNote = useMutation({
    mutationFn: ({ clientId, note }: any) => agencyApi.addNote(clientId, note),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); setNoteText(''); },
  });

  const assignBiz = useMutation({
    mutationFn: ({ clientId, businessId }: any) => agencyApi.assignBusiness(clientId, businessId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); qc.invalidateQueries({ queryKey: ['businesses'] }); },
  });

  const unassignBiz = useMutation({
    mutationFn: ({ clientId, businessId }: any) => agencyApi.unassignBusiness(clientId, businessId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); qc.invalidateQueries({ queryKey: ['businesses'] }); },
  });

  // ── Derived data ───────────────────────────────────────────
  const dashboard     = data;
  const allClients: any[] = dashboard?.clientHealth ?? [];
  const tasks: any[]      = dashboard?.workQueue ?? [];

  const filteredClients = allClients
    .filter(c => statusFilter === 'all' || c.status === statusFilter)
    .filter(c => !clientSearch || c.name.toLowerCase().includes(clientSearch.toLowerCase()));

  const filteredTasks = taskClientFilter === 'all'
    ? queueData?.tasks ?? []
    : (queueData?.tasks ?? []).filter((t: any) =>
        (t.agency_clients?.name ?? '') === taskClientFilter || t.client_id === taskClientFilter
      );

  const uniqueClientNames = [...new Set((queueData?.tasks ?? []).map((t: any) => t.agency_clients?.name).filter(Boolean))];

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  // ── Loading ────────────────────────────────────────────────
  if (isLoading) return (
    <div className="space-y-3">
      {[1,2,3,4].map(i => <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />)}
    </div>
  );

  const reportUrl = (token: string) => window.location.origin + '/api/agency/report/' + token;

  return (
    <div className="space-y-5">

      {/* ── Header ────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Agency Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">{dashboard?.org?.name ?? 'Your Agency'} · {allClients.length} client{allClients.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={async () => {
            const r = await agencyApi.exportData();
            const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'bizzrank-export.json'; a.click();
          }} className="text-sm border border-gray-200 px-3 py-2 rounded-xl text-gray-500 hover:bg-gray-50 transition-colors">
            ⬇ Export
          </button>
          <button onClick={() => setShowAddClient(true)} className="btn-primary text-sm">
            + Add Client <span className="opacity-50 ml-1 text-xs">N</span>
          </button>
        </div>
      </div>

      {/* ── Tab bar ───────────────────────────────────────── */}
      <div className="flex border-b border-gray-200 gap-1 overflow-x-auto">
        {([
          { id:'overview',   label:'📊 Overview' },
          { id:'clients',    label:`👥 Clients (${allClients.length})` },
          { id:'analytics',  label:'📈 Analytics' },
          { id:'queue',      label:`📋 Queue${dashboard?.queueSummary?.critical > 0 ? ` 🚨${dashboard.queueSummary.critical}` : dashboard?.queueSummary?.total > 0 ? ` (${dashboard.queueSummary.total})` : ''}` },
          { id:'credits',    label:'💳 Credits' },
        ] as const).map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedClient(null); }}
            className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${tab === t.id ? 'border-brand-500 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ══ OVERVIEW ════════════════════════════════════════ */}
      {tab === 'overview' && (
        <div className="space-y-5">
          {/* KPI strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[
              { l:'Active Clients',    v: dashboard?.activeClients ?? 0,  c:'text-gray-800' },
              { l:'Monthly Revenue',   v: dashboard?.monthlyRevenue > 0 ? '$' + (dashboard.monthlyRevenue / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—', c:'text-green-600' },
              { l:'Open Tasks',        v: dashboard?.queueSummary?.total ?? 0, c: (dashboard?.queueSummary?.total ?? 0) > 0 ? 'text-amber-600' : 'text-green-600' },
              { l:'Critical Alerts',   v: dashboard?.queueSummary?.critical ?? 0, c: (dashboard?.queueSummary?.critical ?? 0) > 0 ? 'text-red-600' : 'text-green-600' },
              { l:'Credits Available', v: (dashboard?.credits?.available ?? 0).toLocaleString(), c:'text-blue-600' },
            ].map(k => (
              <div key={k.l} className="bg-white border border-gray-100 rounded-xl p-4 text-center">
                <p className={`text-xl font-black ${k.c}`}>{k.v}</p>
                <p className="text-xs text-gray-400 mt-0.5">{k.l}</p>
              </div>
            ))}
          </div>

          {/* Urgent tasks */}
          {tasks.filter((t:any) => ['critical','high'].includes(t.priority)).length > 0 && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-red-800 text-sm">🚨 Needs immediate attention</h3>
                <button onClick={() => setTab('queue')} className="text-xs text-red-600 font-semibold hover:underline">View all →</button>
              </div>
              <div className="space-y-2">
                {tasks.filter((t:any) => ['critical','high'].includes(t.priority)).slice(0,3).map((t:any) => (
                  <div key={t.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 shadow-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base">{PRIORITY_ICON[t.priority as keyof typeof PRIORITY_ICON]}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">{t.title}</p>
                        {t.agency_clients?.name && <p className="text-xs text-gray-400">{t.agency_clients.name}</p>}
                      </div>
                    </div>
                    <div className="flex gap-1.5 shrink-0 ml-2">
                      <button onClick={() => nav(t.action_url ?? '/overview')}
                        className="text-xs text-brand-600 font-semibold hover:underline">Fix →</button>
                      <button onClick={() => resolveTask.mutate(t.id)}
                        className="text-xs text-gray-400 hover:text-gray-600">✓</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Client health table */}
          {allClients.length === 0 ? (
            <div className="card text-center py-16">
              <p className="text-5xl mb-4">👥</p>
              <p className="font-semibold text-gray-700 mb-2">No clients yet</p>
              <p className="text-sm text-gray-400 mb-4">Add your first client, assign businesses, and track everything from here</p>
              <button onClick={() => setShowAddClient(true)} className="btn-primary">Add first client</button>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              {/* Search + filter row */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-gray-50">
                <input value={clientSearch} onChange={e => setClientSearch(e.target.value)}
                  placeholder="Search clients…" className="input text-sm max-w-xs py-1.5" />
                <div className="flex gap-1">
                  {(['all','active','paused','churned'] as const).map(s => (
                    <button key={s} onClick={() => setStatusFilter(s)}
                      className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${statusFilter === s ? 'bg-brand-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-100 border border-gray-200'}`}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                      {s !== 'all' && <span className="ml-1 opacity-70">{allClients.filter(c => c.status === s || (s === 'active' && !c.status)).length}</span>}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-gray-400 ml-auto">{filteredClients.length} shown</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[800px]">
                  <thead className="border-b border-gray-100">
                    <tr>
                      {['Client','Status','Locations','Visibility','Reviews','GBP','AI Vis','Budget','Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filteredClients.map((c: any) => (
                      <tr key={c.clientId}
                        className={`hover:bg-gray-50/80 transition-colors ${c.criticalAlerts > 0 ? 'bg-red-50/30' : ''}`}>
                        <td className="px-4 py-3">
                          <button onClick={() => { setSelectedClient(c); setTab('clients'); }}
                            className="text-left">
                            <p className="font-semibold text-gray-800 hover:text-brand-600 transition-colors">{c.name}</p>
                            {c.contactName && <p className="text-xs text-gray-400">{c.contactName}</p>}
                            {(c.monthlyFee ?? 0) > 0 && (
                              <p className="text-xs text-green-600 font-medium">${(c.monthlyFee/100).toFixed(0)}/mo</p>
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={c.status ?? 'active'} />
                        </td>
                        <td className="px-4 py-3 text-center text-gray-600">{c.businessCount}</td>
                        <td className="px-4 py-3"><ScoreBadge v={c.avgVisibility} /></td>
                        <td className="px-4 py-3">
                          {c.unansweredReviews > 0
                            ? <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">{c.unansweredReviews} open</span>
                            : <span className="text-xs text-green-600">✓</span>}
                          {c.avgRating && <p className="text-xs text-gray-400">★ {c.avgRating}</p>}
                        </td>
                        <td className="px-4 py-3">
                          {c.criticalAlerts > 0
                            ? <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-bold">🚨 {c.criticalAlerts}</span>
                            : c.totalAlerts > 0
                              ? <span className="text-xs text-amber-500">{c.totalAlerts}</span>
                              : <span className="text-xs text-green-600">✓</span>}
                        </td>
                        <td className="px-4 py-3"><ScoreBadge v={c.aiVisibility} /></td>
                        <td className="px-4 py-3">
                          {c.creditBudget > 0
                            ? <MiniBar pct={c.creditBudget > 0 ? Math.round((c.creditsUsed / c.creditBudget) * 100) : 0} warn />
                            : <span className="text-xs text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            <button onClick={() => window.open(reportUrl(c.reportToken), '_blank')}
                              title="Open report" className="w-7 h-7 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 flex items-center justify-center text-xs transition-colors">📄</button>
                            <button onClick={() => copyToClipboard(reportUrl(c.reportToken), c.clientId)}
                              title={copied === c.clientId ? 'Copied!' : 'Copy report URL'}
                              className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors ${copied === c.clientId ? 'bg-green-100 text-green-700' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}>
                              {copied === c.clientId ? '✓' : '🔗'}
                            </button>
                            <button onClick={() => { setSelectedClient(c); setTab('clients'); }}
                              title="Manage client" className="w-7 h-7 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 flex items-center justify-center text-xs transition-colors">⚙️</button>
                            <button onClick={() => nav('/reviews')}
                              title="View reviews" className="w-7 h-7 rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-100 flex items-center justify-center text-xs transition-colors">⭐</button>
                            {c.criticalAlerts > 0 && (
                              <button onClick={() => nav('/gbp-guard')}
                                title="GBP Guard alerts" className="w-7 h-7 rounded-lg bg-red-100 text-red-600 hover:bg-red-200 flex items-center justify-center text-xs transition-colors animate-pulse">🛡️</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ CLIENTS ══════════════════════════════════════════ */}
      {tab === 'clients' && !selectedClient && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <input value={clientSearch} onChange={e => setClientSearch(e.target.value)}
              placeholder="Search clients…" className="input text-sm max-w-xs" />
            <div className="flex gap-1">
              {(['all','active','paused','churned'] as const).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${statusFilter === s ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {filteredClients.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-400">No clients match your filter</p>
              <button onClick={() => setShowAddClient(true)} className="btn-primary mt-4 text-sm">+ Add Client</button>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredClients.map((c: any) => (
                <div key={c.clientId} className={`card hover:shadow-sm transition-shadow ${c.criticalAlerts > 0 ? 'border-red-200' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-gray-800">{c.name}</h3>
                        <StatusBadge status={c.status ?? 'active'} />
                        {c.criticalAlerts > 0 && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">🚨 {c.criticalAlerts} critical</span>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                        <span>{c.businessCount} location{c.businessCount !== 1 ? 's' : ''}</span>
                        {c.contactEmail && <span>{c.contactEmail}</span>}
                        {(c.monthlyFee ?? 0) > 0 && <span className="text-green-600 font-medium">${(c.monthlyFee/100).toFixed(0)}/mo</span>}
                        {c.avgVisibility !== null && <span>Visibility: <strong>{c.avgVisibility}</strong></span>}
                        {c.unansweredReviews > 0 && <span className="text-amber-600">{c.unansweredReviews} unanswered reviews</span>}
                      </div>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button onClick={() => window.open(reportUrl(c.reportToken), '_blank')}
                        className="text-xs bg-green-50 text-green-700 px-2.5 py-1.5 rounded-lg hover:bg-green-100 font-medium">📄 Report</button>
                      <button onClick={() => copyToClipboard(reportUrl(c.reportToken), c.clientId)}
                        className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors ${copied === c.clientId ? 'bg-green-100 text-green-700' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}>
                        {copied === c.clientId ? '✓ Copied' : '🔗 Copy URL'}
                      </button>
                      <button onClick={() => setSelectedClient(c)}
                        className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1.5 rounded-lg hover:bg-gray-200 font-medium">Manage →</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Client detail ── */}
      {tab === 'clients' && selectedClient && (
        <div className="space-y-4">
          <button onClick={() => setSelectedClient(null)} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">← Back to clients</button>

          {/* Client header card */}
          <div className="card">
            <div className="flex items-start justify-between mb-5">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-xl font-bold">{selectedClient.name}</h2>
                  <StatusBadge status={selectedClient.status ?? 'active'} />
                </div>
                {selectedClient.contactName && (
                  <p className="text-sm text-gray-500">{selectedClient.contactName}
                    {selectedClient.contactEmail && <> · <a href={`mailto:${selectedClient.contactEmail}`} className="hover:underline text-brand-600">{selectedClient.contactEmail}</a></>}
                  </p>
                )}
              </div>
              <div className="flex gap-2 flex-wrap justify-end">
                {/* Status quick-change */}
                <select
                  value={selectedClient.status ?? 'active'}
                  onChange={e => setStatus.mutate({ id: selectedClient.clientId, status: e.target.value })}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="churned">Churned</option>
                </select>
                <button onClick={() => window.open(reportUrl(selectedClient.reportToken), '_blank')}
                  className="text-sm bg-green-50 text-green-700 px-3 py-1.5 rounded-xl font-medium hover:bg-green-100">📄 Report</button>
                <button onClick={() => copyToClipboard(reportUrl(selectedClient.reportToken), 'detail')}
                  className={`text-sm px-3 py-1.5 rounded-xl font-medium transition-colors ${copied === 'detail' ? 'bg-green-100 text-green-700' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}>
                  {copied === 'detail' ? '✓ Copied' : '🔗 Copy URL'}
                </button>
                <button onClick={async () => {
                  if (!confirm('Rotate report token? The old URL will stop working.')) return;
                  await rotateToken.mutateAsync(selectedClient.clientId);
                  alert('New report URL generated — copy it and send to your client');
                }} className="text-sm bg-amber-50 text-amber-700 px-3 py-1.5 rounded-xl font-medium hover:bg-amber-100">🔄 Rotate URL</button>
                <button onClick={() => { if (confirm('Delete this client? Businesses will be unassigned.')) deleteClient.mutate(selectedClient.clientId); }}
                  className="text-sm bg-red-50 text-red-600 px-3 py-1.5 rounded-xl font-medium hover:bg-red-100">Delete</button>
              </div>
            </div>

            {/* Editable fields */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Contact name',    field: 'contact_name',           type: 'text',   val: selectedClient.contactName ?? '' },
                { label: 'Contact email',   field: 'contact_email',          type: 'email',  val: selectedClient.contactEmail ?? '' },
                { label: 'Monthly fee ($)', field: 'monthly_fee',            type: 'number', val: Math.round((selectedClient.monthlyFee ?? 0) / 100) },
                { label: 'Credit budget',   field: 'monthly_credit_budget',  type: 'number', val: selectedClient.creditBudget ?? 0 },
              ].map(f => (
                <div key={f.field}>
                  <label className="label text-xs">{f.label}</label>
                  <input type={f.type} defaultValue={f.val} className="input text-sm"
                    onBlur={e => {
                      const raw = e.target.value;
                      const val = f.type === 'number' ? (f.field === 'monthly_fee' ? Math.round(parseFloat(raw || '0') * 100) : parseInt(raw || '0')) : raw;
                      updateClient.mutate({ id: selectedClient.clientId, data: { [f.field]: val } });
                    }} />
                </div>
              ))}
            </div>

            {/* Internal notes field */}
            <div className="mt-3">
              <label className="label text-xs">Internal notes <span className="text-gray-400 font-normal">(only your team sees this)</span></label>
              <textarea
                className="input text-sm w-full h-20 resize-none"
                defaultValue={clientDetail?.client?.agency_notes ?? ''}
                placeholder="Client context, goals, special instructions…"
                onBlur={e => updateClient.mutate({ id: selectedClient.clientId, data: { agency_notes: e.target.value } })}
              />
            </div>
          </div>

          {/* Businesses */}
          <div className="card">
            <h3 className="font-semibold mb-3">Businesses assigned to this client</h3>
            {clientDetail?.businesses?.length === 0 && (
              <p className="text-sm text-gray-400 mb-3">No businesses assigned yet — assign below</p>
            )}
            <div className="space-y-2 mb-3">
              {(clientDetail?.businesses ?? []).map((b: any) => (
                <div key={b.id} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-xl">
                  <div>
                    <p className="text-sm font-medium">{b.name}</p>
                    {b.address && <p className="text-xs text-gray-400 truncate max-w-xs">{b.address}</p>}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => nav('/organic/new')}
                      className="text-xs text-brand-600 hover:underline">Scan</button>
                    <button onClick={() => unassignBiz.mutate({ clientId: selectedClient.clientId, businessId: b.id })}
                      className="text-xs text-red-500 hover:underline">Remove</button>
                  </div>
                </div>
              ))}
            </div>
            {(bizList ?? []).filter((b: any) => !b.agency_client_id).length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Assign a business:</p>
                <select className="input text-sm"
                  onChange={e => { if (e.target.value) { assignBiz.mutate({ clientId: selectedClient.clientId, businessId: e.target.value }); (e.target as HTMLSelectElement).value = ''; }}}>
                  <option value="">Select business…</option>
                  {(bizList ?? []).filter((b: any) => !b.agency_client_id).map((b: any) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Notes log */}
          <div className="card">
            <h3 className="font-semibold mb-3">Notes log</h3>
            <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
              {(clientDetail?.notes ?? []).length === 0 && (
                <p className="text-xs text-gray-400">No notes yet</p>
              )}
              {(clientDetail?.notes ?? []).map((n: any) => (
                <div key={n.id} className="p-2.5 bg-gray-50 rounded-xl">
                  <p className="text-sm text-gray-700">{n.note}</p>
                  <p className="text-xs text-gray-400 mt-1">{n.profiles?.full_name ?? 'Team'} · {new Date(n.created_at).toLocaleString()}</p>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input className="input text-sm flex-1" placeholder="Add a note…" value={noteText}
                onChange={e => setNoteText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && noteText.trim() && addNote.mutate({ clientId: selectedClient.clientId, note: noteText })} />
              <button onClick={() => noteText.trim() && addNote.mutate({ clientId: selectedClient.clientId, note: noteText })}
                className="btn-primary text-sm px-4" disabled={!noteText.trim()}>Add</button>
            </div>
          </div>

          {/* Open tasks */}
          {(clientDetail?.tasks ?? []).length > 0 && (
            <div className="card">
              <h3 className="font-semibold mb-3">Open tasks for this client</h3>
              <div className="space-y-2">
                {clientDetail.tasks.map((t: any) => (
                  <div key={t.id} className={`flex items-start justify-between p-3 border rounded-xl ${PRIORITY_STYLE[t.priority as keyof typeof PRIORITY_STYLE]}`}>
                    <div>
                      <span className="text-xs font-semibold mr-1">{PRIORITY_ICON[t.priority as keyof typeof PRIORITY_ICON]}</span>
                      <span className="text-sm font-medium">{t.title}</span>
                      {t.description && <p className="text-xs opacity-75 mt-0.5">{t.description}</p>}
                    </div>
                    <div className="flex gap-2 ml-2">
                      {t.action_url && <button onClick={() => nav(t.action_url)} className="text-xs font-semibold hover:underline">Go →</button>}
                      <button onClick={() => resolveTask.mutate(t.id)} className="text-xs font-semibold hover:underline">✓</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ ANALYTICS ════════════════════════════════════════ */}
      {tab === 'analytics' && (
        <div className="space-y-5">
          {!analyticsData ? (
            <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />)}</div>
          ) : (
            <>
              {/* Client status overview */}
              <div className="grid grid-cols-4 gap-3">
                {[
                  { l:'Total Clients', v: analyticsData.clientStats?.total ?? 0,   c:'text-gray-800' },
                  { l:'Active',        v: analyticsData.clientStats?.active ?? 0,  c:'text-green-600' },
                  { l:'Paused',        v: analyticsData.clientStats?.paused ?? 0,  c:'text-amber-600' },
                  { l:'Churned',       v: analyticsData.clientStats?.churned ?? 0, c:'text-red-500' },
                ].map(k => (
                  <div key={k.l} className="card text-center">
                    <p className={`text-2xl font-black ${k.c}`}>{k.v}</p>
                    <p className="text-xs text-gray-400 mt-1">{k.l}</p>
                  </div>
                ))}
              </div>

              {/* Visibility trend */}
              {analyticsData.trend?.length > 0 && (
                <div className="card">
                  <BarChart data={analyticsData.trend} label="Average visibility score by month" />
                </div>
              )}

              {/* Review response rate */}
              <div className="card">
                <p className="text-xs font-semibold text-gray-500 mb-3">Review response rate</p>
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <p className={`text-3xl font-black ${analyticsData.responseRate >= 70 ? 'text-green-600' : analyticsData.responseRate >= 40 ? 'text-amber-600' : 'text-red-600'}`}>
                      {analyticsData.responseRate}%
                    </p>
                    <p className="text-xs text-gray-400">Response rate</p>
                  </div>
                  <div className="flex-1">
                    <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden mb-2">
                      <div className={`h-full rounded-full ${analyticsData.responseRate >= 70 ? 'bg-green-500' : analyticsData.responseRate >= 40 ? 'bg-amber-400' : 'bg-red-500'}`}
                        style={{ width: analyticsData.responseRate + '%' }} />
                    </div>
                    <p className="text-xs text-gray-500">{analyticsData.repliedReviews} of {analyticsData.totalReviews} reviews answered</p>
                    {analyticsData.responseRate < 70 && (
                      <p className="text-xs text-amber-600 mt-1">⚠ Google rewards businesses that respond to reviews. Target 70%+.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Revenue tracking */}
              {(dashboard?.monthlyRevenue ?? 0) > 0 && (
                <div className="card">
                  <p className="text-xs font-semibold text-gray-500 mb-3">Revenue</p>
                  <div className="flex items-center gap-6">
                    <div className="text-center">
                      <p className="text-3xl font-black text-green-600">${(dashboard.monthlyRevenue / 100).toFixed(0)}</p>
                      <p className="text-xs text-gray-400">Monthly MRR</p>
                    </div>
                    <div className="text-center">
                      <p className="text-3xl font-black text-green-700">${((dashboard.monthlyRevenue / 100) * 12).toFixed(0)}</p>
                      <p className="text-xs text-gray-400">Projected ARR</p>
                    </div>
                    <div className="text-center">
                      <p className="text-3xl font-black text-gray-600">
                        {dashboard.activeClients > 0 ? '$' + Math.round((dashboard.monthlyRevenue / 100) / dashboard.activeClients) : '—'}
                      </p>
                      <p className="text-xs text-gray-400">Avg per client</p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ══ WORK QUEUE ═══════════════════════════════════════ */}
      {tab === 'queue' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-500">Auto-generated from GBP alerts, unanswered reviews, and low visibility</p>
              {uniqueClientNames.length > 0 && (
                <select value={taskClientFilter} onChange={e => setTaskClientFilter(e.target.value)}
                  className="input text-sm py-1.5 max-w-[180px]">
                  <option value="all">All clients</option>
                  {uniqueClientNames.map((n: any) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
            </div>
            <div className="flex gap-2">
              {(queueData?.tasks ?? []).length > 0 && (
                <button onClick={async () => {
                  if (!confirm('Mark all tasks as resolved?')) return;
                  for (const t of queueData!.tasks) await agencyApi.resolveTask(t.id).catch(() => {});
                  refetchQueue();
                  qc.invalidateQueries({ queryKey: ['agency-dashboard'] });
                }} className="text-sm border border-gray-200 px-3 py-2 rounded-xl text-gray-500 hover:bg-gray-50">
                  ✓ Resolve all
                </button>
              )}
              <button onClick={async () => {
                setGeneratingTasks(true);
                try { await agencyApi.generateTasks(); refetchQueue(); qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); }
                finally { setGeneratingTasks(false); }
              }} disabled={generatingTasks} className="btn-primary text-sm">
                {generatingTasks ? 'Refreshing…' : '⚡ Refresh tasks'}
              </button>
            </div>
          </div>

          {!filteredTasks.length ? (
            <div className="card text-center py-12">
              <p className="text-3xl mb-3">✅</p>
              <p className="font-semibold text-gray-700">No open tasks</p>
              <p className="text-sm text-gray-400 mt-1">Click Refresh tasks to scan all clients for new items</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {(['critical','high','medium','low'] as const).map(priority => {
                const group = filteredTasks.filter((t: any) => t.priority === priority);
                if (!group.length) return null;
                return (
                  <div key={priority}>
                    <div className="flex items-center gap-2 mb-2 mt-4">
                      <span className="text-base">{PRIORITY_ICON[priority]}</span>
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">{priority} · {group.length}</p>
                    </div>
                    {group.map((t: any) => (
                      <div key={t.id} className={`flex items-start gap-3 p-3.5 border rounded-xl mb-1.5 ${PRIORITY_STYLE[priority]}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <p className="font-semibold text-sm">{t.title}</p>
                            <span className="text-xs bg-white/70 px-1.5 py-0.5 rounded font-medium opacity-80">
                              {TASK_LABEL[t.task_type] ?? t.task_type}
                            </span>
                            {t.agency_clients?.name && (
                              <span className="text-xs opacity-60">{t.agency_clients.name}</span>
                            )}
                          </div>
                          {t.description && <p className="text-xs opacity-75">{t.description}</p>}
                        </div>
                        <div className="flex gap-1.5 shrink-0">
                          {t.action_url && (
                            <button onClick={() => nav(t.action_url)}
                              className="text-xs bg-white/70 font-semibold px-2.5 py-1 rounded-lg hover:bg-white transition-colors">
                              Go →
                            </button>
                          )}
                          <button onClick={() => resolveTask.mutate(t.id)}
                            className="text-xs bg-white/70 font-semibold px-2.5 py-1 rounded-lg hover:bg-white transition-colors">
                            Done ✓
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══ CREDITS ══════════════════════════════════════════ */}
      {tab === 'credits' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { l:'Credit Pool',     v: (creditsData?.pool ?? 0).toLocaleString(),   c:'text-brand-600' },
              { l:'Total Budgeted',  v: (creditsData?.clients ?? []).reduce((s:number, c:any) => s + (c.budget||0), 0).toLocaleString(), c:'text-amber-600' },
              { l:'Used this month', v: (creditsData?.clients ?? []).reduce((s:number, c:any) => s + (c.used||0), 0).toLocaleString(),   c:'text-red-500' },
            ].map(k => (
              <div key={k.l} className="card text-center">
                <p className={`text-2xl font-black ${k.c}`}>{k.v}</p>
                <p className="text-xs text-gray-400 mt-1">{k.l}</p>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Credit allocation per client</h3>
              <p className="text-xs text-gray-400">Set budgets in client detail view</p>
            </div>
            <div className="space-y-4">
              {(creditsData?.clients ?? []).length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">Add clients to track credit usage</p>
              ) : (creditsData?.clients ?? []).map((c: any) => (
                <div key={c.id}>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="font-medium">{c.name}</span>
                    <span className={`text-xs font-medium ${c.pct >= 90 ? 'text-red-600' : c.pct >= 70 ? 'text-amber-600' : 'text-gray-500'}`}>
                      {c.used.toLocaleString()} / {c.budget > 0 ? c.budget.toLocaleString() : '∞'} credits
                      {c.pct >= 90 && ' ⚠'}
                    </span>
                  </div>
                  {c.budget > 0 ? (
                    <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${c.pct >= 90 ? 'bg-red-500' : c.pct >= 70 ? 'bg-amber-400' : 'bg-brand-500'}`}
                        style={{ width: Math.min(100, c.pct) + '%' }} />
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">No budget set — unlimited</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="card bg-blue-50 border-blue-100">
            <p className="text-sm text-blue-700">
              <strong>How it works:</strong> Credits come from your plan's monthly pool ({creditsData?.allowance?.toLocaleString() ?? 0}/mo). Each manual scan costs 25 credits. Automated daily scans are free. Set a budget per client to prevent one client from using all your credits.
            </p>
          </div>
        </div>
      )}

      {/* ══ ADD CLIENT MODAL ═════════════════════════════════ */}
      {showAddClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">Add new client</h3>
              <button onClick={() => setShowAddClient(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div>
              <label className="label">Client / company name *</label>
              <input className="input w-full" autoFocus
                value={newClient.name}
                onChange={e => setNewClient(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Smith Dental Practice"
                onKeyDown={e => e.key === 'Enter' && newClient.name.trim() && createClient.mutate({
                  name: newClient.name, contactName: newClient.contactName,
                  contactEmail: newClient.contactEmail,
                  monthlyFee: Math.round(newClient.monthlyFeeDollars * 100),
                  monthlyBudget: newClient.monthlyBudget, notes: newClient.notes,
                })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Contact name</label>
                <input className="input w-full" value={newClient.contactName}
                  onChange={e => setNewClient(p => ({ ...p, contactName: e.target.value }))}
                  placeholder="John Smith" />
              </div>
              <div>
                <label className="label">Contact email</label>
                <input className="input w-full" type="email" value={newClient.contactEmail}
                  onChange={e => setNewClient(p => ({ ...p, contactEmail: e.target.value }))}
                  placeholder="john@example.com" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Monthly fee ($)</label>
                <input className="input w-full" type="number" min="0" value={newClient.monthlyFeeDollars || ''}
                  onChange={e => setNewClient(p => ({ ...p, monthlyFeeDollars: parseFloat(e.target.value) || 0 }))}
                  placeholder="199" />
                <p className="text-xs text-gray-400 mt-1">For your records — display only</p>
              </div>
              <div>
                <label className="label">Credit budget/month</label>
                <input className="input w-full" type="number" min="0" value={newClient.monthlyBudget || ''}
                  onChange={e => setNewClient(p => ({ ...p, monthlyBudget: parseInt(e.target.value) || 0 }))}
                  placeholder="500" />
                <p className="text-xs text-gray-400 mt-1">Max credits per month</p>
              </div>
            </div>
            <div>
              <label className="label">Initial notes <span className="text-gray-400 font-normal">(optional)</span></label>
              <textarea className="input w-full h-16 resize-none text-sm"
                value={newClient.notes}
                onChange={e => setNewClient(p => ({ ...p, notes: e.target.value }))}
                placeholder="Client goals, context, anything your team should know…" />
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowAddClient(false)} className="flex-1 btn-secondary">Cancel</button>
              <button
                disabled={!newClient.name.trim() || createClient.isPending}
                onClick={() => createClient.mutate({
                  name: newClient.name, contactName: newClient.contactName,
                  contactEmail: newClient.contactEmail,
                  monthlyFee: Math.round(newClient.monthlyFeeDollars * 100),
                  monthlyBudget: newClient.monthlyBudget, notes: newClient.notes,
                })}
                className="flex-1 btn-primary">
                {createClient.isPending ? 'Creating…' : 'Create client'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
