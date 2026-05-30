/**
 * Agency Dashboard — the real agency control center
 *
 * Built for Pro/Agency/Enterprise plans.
 *
 * WHAT THIS DOES THAT A NORMAL DASHBOARD DOESN'T:
 *
 * 1. CLIENT MANAGEMENT — not just your businesses, but clients you serve.
 *    Each client is a person/company. They have their own businesses,
 *    their own credit budget, their own shareable report URL.
 *    You add clients, assign businesses to them, track them separately.
 *
 * 2. WORK QUEUE — a prioritized list of actions your team needs to take.
 *    Auto-generated from: critical GBP alerts, unanswered reviews >3 days,
 *    low visibility scores. Click Generate to refresh. Click to resolve.
 *    Your team comes here every morning to see what needs doing.
 *
 * 3. CREDIT ALLOCATION — your plan has X credits.
 *    Each client gets a monthly budget. You see % used per client.
 *    No client can over-consume without you knowing.
 *
 * 4. CLIENT REPORTS — every client has a unique URL.
 *    You send it to them. They open it and see their data.
 *    No login required. Your brand on the report.
 *
 * 5. INTERNAL NOTES — leave notes on each client visible only to
 *    your team. Client sees nothing. Agency context preserved.
 *
 * 6. MONTHLY REVENUE TRACKING — record what you charge each client.
 *    See total monthly revenue across all clients at a glance.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { agencyApi, bizApi } from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────
const PRIORITY_STYLE = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  high:     'bg-amber-100 text-amber-700 border-amber-200',
  medium:   'bg-blue-50 text-blue-700 border-blue-200',
  low:      'bg-gray-50 text-gray-500 border-gray-200',
};
const PRIORITY_ICON = { critical:'🚨', high:'⚠️', medium:'📋', low:'ℹ️' };
const TASK_TYPE_LABEL: Record<string,string> = {
  gbp_alert:          'GBP Alert',
  unanswered_reviews: 'Reviews',
  low_visibility:     'Visibility',
};

function ScoreDot({ v }: { v: number | null }) {
  if (v === null) return <span className="text-gray-300 text-xs">—</span>;
  const c = v >= 60 ? 'text-green-600' : v >= 30 ? 'text-amber-600' : 'text-red-600';
  return <span className={`font-bold text-sm ${c}`}>{v}</span>;
}

// ── Main component ─────────────────────────────────────────────
export default function AgencyDashboard() {
  const nav = useNavigate();
  const qc  = useQueryClient();
  const [view, setView] = useState<'overview'|'clients'|'queue'|'credits'>('overview');
  const [showAddClient, setShowAddClient] = useState(false);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [newClient, setNewClient] = useState({ name:'', contactName:'', contactEmail:'', monthlyFee:0, monthlyBudget:0 });
  const [noteText, setNoteText] = useState('');
  const [generatingTasks, setGeneratingTasks] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['agency-dashboard'],
    queryFn:  () => agencyApi.dashboard().then(r => r.data),
    refetchInterval: 120000,
  });

  const { data: queueData } = useQuery({
    queryKey: ['agency-queue'],
    queryFn:  () => agencyApi.workQueue().then(r => r.data),
    enabled:  view === 'queue',
  });

  const { data: creditsData } = useQuery({
    queryKey: ['agency-credits'],
    queryFn:  () => agencyApi.credits().then(r => r.data),
    enabled:  view === 'credits',
  });

  const { data: clientDetail } = useQuery({
    queryKey: ['agency-client', selectedClient?.clientId],
    queryFn:  () => agencyApi.getClient(selectedClient.clientId).then(r => r.data),
    enabled:  !!selectedClient?.clientId,
  });

  const { data: bizList } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses),
    enabled:  !!selectedClient,
  });

  const createClient = useMutation({
    mutationFn: (d: any) => agencyApi.createClient(d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); setShowAddClient(false); setNewClient({ name:'', contactName:'', contactEmail:'', monthlyFee:0, monthlyBudget:0 }); },
  });

  const deleteClient = useMutation({
    mutationFn: (id: string) => agencyApi.deleteClient(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); setSelectedClient(null); },
  });

  const resolveTask = useMutation({
    mutationFn: (id: string) => agencyApi.resolveTask(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['agency-queue'] }),
  });

  const updateClient = useMutation({
    mutationFn: ({ id, data }: any) => agencyApi.updateClient(id, data),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }),
  });

  const addNote = useMutation({
    mutationFn: ({ clientId, note }: any) => agencyApi.addNote(clientId, note),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); setNoteText(''); },
  });

  const assignBiz = useMutation({
    mutationFn: ({ clientId, businessId }: any) => agencyApi.assignBusiness(clientId, businessId),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['agency-client', selectedClient?.clientId] }); qc.invalidateQueries({ queryKey: ['businesses'] }); },
  });

  const dashboard = data;
  const clients: any[] = dashboard?.clientHealth ?? [];
  const tasks: any[]   = dashboard?.workQueue ?? [];

  if (isLoading) return (
    <div className="space-y-3">
      {[1,2,3].map(i => <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />)}
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agency Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">{dashboard?.org?.name ?? 'Your Agency'}</p>
        </div>
        <button onClick={() => setShowAddClient(true)} className="btn-primary text-sm">+ Add Client</button>
      </div>

      {/* ── Tab bar ── */}
      <div className="flex border-b border-gray-200">
        {([
          { id: 'overview', label: '📊 Overview' },
          { id: 'clients',  label: `👥 Clients (${clients.length})` },
          { id: 'queue',    label: `📋 Work Queue${dashboard?.queueSummary?.critical > 0 ? ` 🚨${dashboard.queueSummary.critical}` : dashboard?.queueSummary?.total > 0 ? ` (${dashboard.queueSummary.total})` : ''}` },
          { id: 'credits',  label: '💳 Credits' },
        ] as const).map(t => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`px-4 py-3 text-sm font-medium transition-colors ${view === t.id ? 'border-b-2 border-brand-500 text-brand-700' : 'text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ══════════════════════ OVERVIEW ══════════════════════ */}
      {view === 'overview' && (
        <div className="space-y-5">

          {/* KPI bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            {[
              { l:'Active Clients',      v: dashboard?.activeClients ?? 0,        c:'text-gray-800' },
              { l:'Monthly Revenue',     v: dashboard?.monthlyRevenue ? '$' + (dashboard.monthlyRevenue/100).toLocaleString() : '—', c:'text-green-600' },
              { l:'Unresolved Tasks',    v: dashboard?.queueSummary?.total ?? 0,  c: (dashboard?.queueSummary?.total ?? 0) > 0 ? 'text-amber-600' : 'text-green-600' },
              { l:'Critical Alerts',     v: dashboard?.queueSummary?.critical ?? 0, c: (dashboard?.queueSummary?.critical ?? 0) > 0 ? 'text-red-600' : 'text-green-600' },
              { l:'Credits Available',   v: (dashboard?.credits?.available ?? 0).toLocaleString(), c:'text-blue-600' },
            ].map(k => (
              <div key={k.l} className="bg-white border border-gray-100 rounded-xl p-4 text-center">
                <p className={`text-xl font-black ${k.c}`}>{k.v}</p>
                <p className="text-xs text-gray-400 mt-0.5">{k.l}</p>
              </div>
            ))}
          </div>

          {/* Urgent tasks preview */}
          {tasks.filter((t:any) => t.priority === 'critical' || t.priority === 'high').length > 0 && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-red-800 text-sm">🚨 Needs immediate attention</h3>
                <button onClick={() => setView('queue')} className="text-xs text-red-600 font-semibold hover:underline">View all →</button>
              </div>
              <div className="space-y-2">
                {tasks.filter((t:any) => ['critical','high'].includes(t.priority)).slice(0, 3).map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 shadow-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base">{PRIORITY_ICON[t.priority as keyof typeof PRIORITY_ICON]}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">{t.title}</p>
                        {t.agency_clients?.name && <p className="text-xs text-gray-400">{t.agency_clients.name}</p>}
                      </div>
                    </div>
                    <button onClick={() => nav(t.action_url ?? '/overview')}
                      className="text-xs text-brand-600 font-semibold hover:underline shrink-0 ml-2">Fix →</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Client health table */}
          {clients.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-4xl mb-3">👥</p>
              <p className="font-semibold text-gray-700 mb-2">No clients yet</p>
              <p className="text-sm text-gray-400 mb-4">Add your first client, then assign your businesses to them</p>
              <button onClick={() => setShowAddClient(true)} className="btn-primary">Add first client</button>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    {['Client','Locations','Visibility','Reviews','GBP Alerts','AI Vis','Credits','Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {clients.map((c: any) => (
                    <tr key={c.clientId}
                      className={`hover:bg-gray-50 transition-colors cursor-pointer ${c.criticalAlerts > 0 ? 'bg-red-50/40' : ''}`}
                      onClick={() => setSelectedClient(c)}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-800">{c.name}</p>
                        {c.contactName && <p className="text-xs text-gray-400">{c.contactName}</p>}
                        {c.monthlyFee > 0 && <p className="text-xs text-green-600 font-medium">${(c.monthlyFee/100).toFixed(0)}/mo</p>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-center">{c.businessCount}</td>
                      <td className="px-4 py-3"><ScoreDot v={c.avgVisibility} /></td>
                      <td className="px-4 py-3">
                        {c.unansweredReviews > 0
                          ? <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">{c.unansweredReviews} unanswered</span>
                          : <span className="text-xs text-green-600">✓ Clear</span>}
                        {c.avgRating && <p className="text-xs text-gray-400 mt-0.5">★ {c.avgRating}</p>}
                      </td>
                      <td className="px-4 py-3">
                        {c.criticalAlerts > 0
                          ? <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">🚨 {c.criticalAlerts} critical</span>
                          : c.totalAlerts > 0
                            ? <span className="text-xs text-amber-600">{c.totalAlerts} alerts</span>
                            : <span className="text-xs text-green-600">✓ Clear</span>}
                      </td>
                      <td className="px-4 py-3"><ScoreDot v={c.aiVisibility} /></td>
                      <td className="px-4 py-3">
                        {c.creditBudget > 0 ? (
                          <div>
                            <div className="flex items-center gap-1.5">
                              <div className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${c.creditsUsed / c.creditBudget >= 0.9 ? 'bg-red-500' : 'bg-brand-500'}`}
                                  style={{ width: Math.min(100, Math.round((c.creditsUsed / c.creditBudget) * 100)) + '%' }} />
                              </div>
                              <span className="text-xs text-gray-500">{c.creditsUsed}/{c.creditBudget}</span>
                            </div>
                          </div>
                        ) : <span className="text-xs text-gray-300">No budget set</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          <button onClick={e => { e.stopPropagation(); window.open('/api/agency/report/' + c.reportToken, '_blank'); }}
                            title="Open client report" className="text-xs bg-green-50 text-green-600 px-2 py-1 rounded-lg hover:bg-green-100 font-medium">📄 Report</button>
                          <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(window.location.origin + '/api/agency/report/' + c.reportToken); alert('Report URL copied!'); }}
                            title="Copy report URL" className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-lg hover:bg-blue-100 font-medium">🔗 Copy</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ CLIENTS DETAIL ════════════════ */}
      {view === 'clients' && !selectedClient && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">Click a client to manage them, assign businesses, set budgets, and add notes.</p>
          {clients.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-400">No clients yet</p>
              <button onClick={() => setShowAddClient(true)} className="btn-primary mt-4">Add first client</button>
            </div>
          ) : clients.map((c: any) => (
            <div key={c.clientId} onClick={() => setSelectedClient(c)}
              className="card flex items-center justify-between cursor-pointer hover:border-brand-200 transition-colors">
              <div>
                <p className="font-semibold">{c.name}</p>
                <p className="text-sm text-gray-400">{c.businessCount} location{c.businessCount !== 1 ? 's' : ''} · {c.contactEmail ?? 'No email'}</p>
              </div>
              <div className="flex items-center gap-3">
                {c.criticalAlerts > 0 && <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full">🚨 {c.criticalAlerts}</span>}
                <span className="text-gray-400 text-sm">→</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Client detail panel ── */}
      {view === 'clients' && selectedClient && (
        <div className="space-y-4">
          <button onClick={() => setSelectedClient(null)} className="text-sm text-gray-500 hover:text-gray-700">← Back to clients</button>

          <div className="card">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">{selectedClient.name}</h2>
                {selectedClient.contactName && <p className="text-sm text-gray-500">{selectedClient.contactName} · {selectedClient.contactEmail}</p>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => window.open('/api/agency/report/' + selectedClient.reportToken, '_blank')}
                  className="text-sm bg-green-50 text-green-700 px-3 py-1.5 rounded-xl font-medium hover:bg-green-100">📄 Client Report</button>
                <button onClick={() => { navigator.clipboard.writeText(window.location.origin + '/api/agency/report/' + selectedClient.reportToken); alert('Report URL copied to clipboard'); }}
                  className="text-sm bg-blue-50 text-blue-700 px-3 py-1.5 rounded-xl font-medium hover:bg-blue-100">🔗 Copy URL</button>
                <button onClick={() => { if (confirm('Remove this client? Businesses will be unassigned.')) deleteClient.mutate(selectedClient.clientId); }}
                  className="text-sm bg-red-50 text-red-600 px-3 py-1.5 rounded-xl font-medium hover:bg-red-100">Delete</button>
              </div>
            </div>

            {/* Editable fields */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Monthly fee (cents)', field: 'monthly_fee', type: 'number', val: selectedClient.monthlyFee },
                { label: 'Credit budget/month', field: 'monthly_credit_budget', type: 'number', val: selectedClient.creditBudget },
                { label: 'Contact email', field: 'contact_email', type: 'email', val: selectedClient.contactEmail ?? '' },
                { label: 'Contact name', field: 'contact_name', type: 'text', val: selectedClient.contactName ?? '' },
              ].map(f => (
                <div key={f.field}>
                  <label className="label text-xs">{f.label}</label>
                  <input type={f.type} defaultValue={f.val} className="input text-sm"
                    onBlur={e => updateClient.mutate({ id: selectedClient.clientId, data: { [f.field]: f.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value } })} />
                </div>
              ))}
            </div>
          </div>

          {/* Assign businesses */}
          <div className="card">
            <h3 className="font-semibold mb-3">Businesses assigned to this client</h3>
            {clientDetail?.businesses?.length === 0 && <p className="text-sm text-gray-400 mb-3">No businesses assigned yet</p>}
            <div className="space-y-2 mb-3">
              {(clientDetail?.businesses ?? []).map((b: any) => (
                <div key={b.id} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-xl">
                  <span className="text-sm font-medium">{b.name}</span>
                  <button onClick={() => agencyApi.unassignBusiness(selectedClient.clientId, b.id).then(() => qc.invalidateQueries({ queryKey: ['agency-client', selectedClient.clientId] }))}
                    className="text-xs text-red-500 hover:underline">Remove</button>
                </div>
              ))}
            </div>
            {/* Assign unassigned business */}
            {(bizList ?? []).filter((b: any) => !b.agency_client_id).length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Assign a business:</p>
                <select className="input text-sm"
                  onChange={e => { if (e.target.value) assignBiz.mutate({ clientId: selectedClient.clientId, businessId: e.target.value }); e.target.value = ''; }}>
                  <option value="">Select business to assign...</option>
                  {(bizList ?? []).filter((b: any) => !b.agency_client_id).map((b: any) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Internal notes */}
          <div className="card">
            <h3 className="font-semibold mb-3">Internal notes <span className="text-xs text-gray-400 font-normal">(only your team sees this)</span></h3>
            <div className="space-y-2 mb-3 max-h-40 overflow-y-auto">
              {(clientDetail?.notes ?? []).map((n: any) => (
                <div key={n.id} className="p-2.5 bg-gray-50 rounded-xl">
                  <p className="text-sm text-gray-700">{n.note}</p>
                  <p className="text-xs text-gray-400 mt-1">{n.profiles?.full_name ?? 'Team'} · {new Date(n.created_at).toLocaleString()}</p>
                </div>
              ))}
              {clientDetail?.notes?.length === 0 && <p className="text-xs text-gray-400">No notes yet</p>}
            </div>
            <div className="flex gap-2">
              <input className="input text-sm flex-1" placeholder="Add internal note..." value={noteText}
                onChange={e => setNoteText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && noteText.trim() && addNote.mutate({ clientId: selectedClient.clientId, note: noteText })} />
              <button onClick={() => noteText.trim() && addNote.mutate({ clientId: selectedClient.clientId, note: noteText })}
                className="btn-primary text-sm px-4" disabled={!noteText.trim()}>Add</button>
            </div>
          </div>

          {/* Open tasks for this client */}
          {clientDetail?.tasks?.length > 0 && (
            <div className="card">
              <h3 className="font-semibold mb-3">Open tasks</h3>
              <div className="space-y-2">
                {clientDetail.tasks.map((t: any) => (
                  <div key={t.id} className={`flex items-start justify-between p-3 border rounded-xl ${PRIORITY_STYLE[t.priority as keyof typeof PRIORITY_STYLE]}`}>
                    <div>
                      <span className="text-xs font-semibold mr-1">{PRIORITY_ICON[t.priority as keyof typeof PRIORITY_ICON]}</span>
                      <span className="text-sm font-medium">{t.title}</span>
                      {t.description && <p className="text-xs opacity-75 mt-0.5">{t.description}</p>}
                    </div>
                    <button onClick={() => resolveTask.mutate(t.id)} className="text-xs font-semibold ml-2 shrink-0 hover:underline">Done ✓</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ WORK QUEUE ════════════════════ */}
      {view === 'queue' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">
              Your team's daily action list. Auto-generated from GBP alerts, unanswered reviews, and low visibility scores.
            </p>
            <button onClick={async () => {
              setGeneratingTasks(true);
              try { await agencyApi.generateTasks(); qc.invalidateQueries({ queryKey: ['agency-queue'] }); qc.invalidateQueries({ queryKey: ['agency-dashboard'] }); }
              finally { setGeneratingTasks(false); }
            }} disabled={generatingTasks} className="btn-primary text-sm">
              {generatingTasks ? 'Generating...' : '⚡ Refresh tasks'}
            </button>
          </div>

          {!queueData?.tasks?.length ? (
            <div className="card text-center py-12">
              <p className="text-3xl mb-3">✅</p>
              <p className="font-semibold text-gray-700">No open tasks</p>
              <p className="text-sm text-gray-400 mt-1">Click "Refresh tasks" to scan for new items</p>
            </div>
          ) : (
            <div className="space-y-2">
              {['critical','high','medium','low'].map(priority => {
                const group = queueData.tasks.filter((t: any) => t.priority === priority);
                if (!group.length) return null;
                return (
                  <div key={priority}>
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1.5 mt-3">{priority} priority</p>
                    {group.map((t: any) => (
                      <div key={t.id} className={`flex items-start justify-between p-4 border rounded-xl mb-2 ${PRIORITY_STYLE[priority as keyof typeof PRIORITY_STYLE]}`}>
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <span className="text-xl shrink-0">{PRIORITY_ICON[priority as keyof typeof PRIORITY_ICON]}</span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold text-sm">{t.title}</p>
                              <span className="text-xs bg-white/70 px-1.5 py-0.5 rounded font-medium">{TASK_TYPE_LABEL[t.task_type] ?? t.task_type}</span>
                              {t.agency_clients?.name && <span className="text-xs opacity-70">{t.agency_clients.name}</span>}
                            </div>
                            {t.description && <p className="text-xs opacity-75 mt-0.5">{t.description}</p>}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0 ml-2">
                          {t.action_url && (
                            <button onClick={() => nav(t.action_url)} className="text-xs font-semibold hover:underline px-2">Go →</button>
                          )}
                          <button onClick={() => resolveTask.mutate(t.id)}
                            className="text-xs bg-white/60 font-semibold px-3 py-1 rounded-lg hover:bg-white/90 transition-colors">
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

      {/* ══════════════════════ CREDITS ════════════════════════ */}
      {view === 'credits' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { l:'Credit Pool',   v: (creditsData?.pool ?? 0).toLocaleString(),      c:'text-brand-600' },
              { l:'Budgeted',      v: (creditsData?.clients ?? []).reduce((s: number, c: any) => s + c.budget, 0).toLocaleString(), c:'text-amber-600' },
              { l:'Used this month', v: (creditsData?.clients ?? []).reduce((s: number, c: any) => s + c.used, 0).toLocaleString(), c:'text-red-500' },
            ].map(k => (
              <div key={k.l} className="card text-center">
                <p className={`text-2xl font-black ${k.c}`}>{k.v}</p>
                <p className="text-xs text-gray-400 mt-1">{k.l}</p>
              </div>
            ))}
          </div>

          <div className="card">
            <h3 className="font-semibold mb-4">Credit allocation per client</h3>
            <div className="space-y-3">
              {(creditsData?.clients ?? []).map((c: any) => (
                <div key={c.id}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-gray-500">{c.used} / {c.budget > 0 ? c.budget : '∞'} credits</span>
                  </div>
                  {c.budget > 0 && (
                    <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${c.pct >= 90 ? 'bg-red-500' : c.pct >= 70 ? 'bg-amber-400' : 'bg-brand-500'}`}
                        style={{ width: Math.min(100, c.pct) + '%' }} />
                    </div>
                  )}
                </div>
              ))}
              {(creditsData?.clients ?? []).length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">Add clients and set budgets to track credit allocation</p>
              )}
            </div>
          </div>

          <div className="card bg-blue-50 border-blue-100">
            <p className="text-sm text-blue-700">
              <strong>How credit budgets work:</strong> Each client gets a monthly credit budget from your plan's pool.
              Setting a budget doesn't deduct credits — it just sets a limit so one client can't use all your credits.
              Set budgets in the client detail view.
            </p>
          </div>
        </div>
      )}

      {/* ══════════════════════ ADD CLIENT MODAL ══════════════ */}
      {showAddClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg">Add new client</h3>
            <div>
              <label className="label">Client / company name *</label>
              <input className="input" value={newClient.name} onChange={e => setNewClient(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Smith Dental Practice" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Contact name</label>
                <input className="input" value={newClient.contactName} onChange={e => setNewClient(p => ({ ...p, contactName: e.target.value }))} placeholder="John Smith" />
              </div>
              <div>
                <label className="label">Contact email</label>
                <input className="input" type="email" value={newClient.contactEmail} onChange={e => setNewClient(p => ({ ...p, contactEmail: e.target.value }))} placeholder="john@..." />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Monthly fee (in cents)</label>
                <input className="input" type="number" value={newClient.monthlyFee} onChange={e => setNewClient(p => ({ ...p, monthlyFee: parseInt(e.target.value)||0 }))} placeholder="e.g. 19900 = $199" />
                <p className="text-xs text-gray-400 mt-1">Display only — for your records</p>
              </div>
              <div>
                <label className="label">Credit budget/month</label>
                <input className="input" type="number" value={newClient.monthlyBudget} onChange={e => setNewClient(p => ({ ...p, monthlyBudget: parseInt(e.target.value)||0 }))} placeholder="e.g. 500" />
                <p className="text-xs text-gray-400 mt-1">Max credits this client can use</p>
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowAddClient(false)} className="flex-1 btn-secondary">Cancel</button>
              <button disabled={!newClient.name.trim() || createClient.isPending}
                onClick={() => createClient.mutate({ name: newClient.name, contactName: newClient.contactName, contactEmail: newClient.contactEmail, monthlyFee: newClient.monthlyFee, monthlyBudget: newClient.monthlyBudget })}
                className="flex-1 btn-primary">
                {createClient.isPending ? 'Creating...' : 'Create client'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
