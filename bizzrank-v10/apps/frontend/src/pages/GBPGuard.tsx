import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gbpGuardApi, bizApi } from '../lib/api';

const SEVERITY_STYLE = {
  critical: { bg: 'bg-red-50',    border: 'border-red-200',    badge: 'bg-red-100 text-red-700',    icon: '🚨', label: 'Critical'  },
  warning:  { bg: 'bg-amber-50',  border: 'border-amber-200',  badge: 'bg-amber-100 text-amber-700',icon: '⚠️', label: 'Warning'   },
  info:     { bg: 'bg-blue-50',   border: 'border-blue-200',   badge: 'bg-blue-100 text-blue-700',  icon: 'ℹ️', label: 'Info'      },
};

export default function GBPGuardPage() {
  const qc = useQueryClient();
  const [selectedBizId, setSelectedBizId] = useState<string>('');
  const [showRead, setShowRead] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn:  () => bizApi.list().then(r => r.data.businesses),
  });
 
  // React Query v5 removed onSuccess from useQuery
  useEffect(() => {
    if (businesses?.length && !selectedBizId) setSelectedBizId(businesses[0].id);
  }, [businesses]);

  const bizId = selectedBizId || businesses?.[0]?.id || '';

  const { data: summary } = useQuery({
    queryKey: ['guard-summary', bizId],
    queryFn:  () => gbpGuardApi.summary(bizId).then(r => r.data),
    enabled:  !!bizId,
    refetchInterval: 60000,
  });

  const { data: alertData, isLoading } = useQuery({
    queryKey: ['guard-alerts', bizId, showRead],
    queryFn:  () => gbpGuardApi.alerts(bizId, showRead).then(r => r.data),
    enabled:  !!bizId,
    refetchInterval: 60000,
  });

  const markReadMutation = useMutation({
    mutationFn: (ids: string[]) => gbpGuardApi.markRead(ids),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['guard-alerts'] }),
  });

  const markAllMutation = useMutation({
    mutationFn: () => gbpGuardApi.markAllRead(bizId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['guard-alerts'] }),
  });

  const alerts: any[] = alertData?.alerts ?? [];
  const unread  = alerts.filter(a => !a.is_read).length;
  const selectedBiz = businesses?.find((b: any) => b.id === bizId);

  return (
    <div className="max-w-4xl space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-green-100 rounded-2xl flex items-center justify-center text-2xl">🛡️</div>
          <div>
            <h1 className="text-xl font-bold">GBP Guard</h1>
            <p className="text-sm text-gray-400">Monitors your Google Business Profile for unauthorized changes · Checks daily at 5am</p>
          </div>
        </div>
        {unread > 0 && (
          <button onClick={() => markAllMutation.mutate()}
            className="text-sm text-brand-600 font-semibold hover:text-brand-800"
            disabled={markAllMutation.isPending}>
            {markAllMutation.isPending ? 'Marking...' : `Mark all ${unread} as read`}
          </button>
        )}
      </div>

      {/* Business selector */}
      {businesses && businesses.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {businesses.map((b: any) => (
            <button key={b.id} onClick={() => setSelectedBizId(b.id)}
              className={'px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors ' +
                (b.id === bizId ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
              {b.name}
            </button>
          ))}
        </div>
      )}

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className={'card text-center ' + (summary.criticalUnread > 0 ? 'border-2 border-red-300 bg-red-50' : '')}>
            <p className={'text-3xl font-black ' + (summary.criticalUnread > 0 ? 'text-red-600' : 'text-gray-300')}>
              {summary.criticalUnread}
            </p>
            <p className="text-xs text-gray-500 mt-1">Critical alerts</p>
          </div>
          <div className="card text-center">
            <p className={'text-3xl font-black ' + (summary.totalUnread > 0 ? 'text-amber-500' : 'text-gray-300')}>
              {summary.totalUnread}
            </p>
            <p className="text-xs text-gray-500 mt-1">Unread alerts</p>
          </div>
          <div className="card text-center">
            <p className="text-3xl font-black text-brand-600">{summary.businessesMonitored}</p>
            <p className="text-xs text-gray-500 mt-1">Locations monitored</p>
          </div>
          <div className="card text-center">
            <p className="text-3xl font-black text-purple-600">{summary.competitorsMonitored}</p>
            <p className="text-xs text-gray-500 mt-1">Competitors monitored</p>
          </div>
        </div>
      )}

      {/* What is monitored */}
      <div className="card bg-green-50 border border-green-200">
        <div className="flex items-start gap-3">
          <span className="text-2xl shrink-0">🛡️</span>
          <div>
            <p className="font-semibold text-green-900 mb-1">20 fields monitored daily</p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {['Business Name','Address','Phone','Website','Description',
                'Map Pin','Opening Hours','Primary Category','Secondary Categories',
                'Rating','Review Count','Place ID','Permanently Closed',
                'Store Code','Google CID','Latitude','Longitude'].map(f => (
                <span key={f} className="bg-white border border-green-200 text-green-700 px-2 py-0.5 rounded-full">{f}</span>
              ))}
            </div>
            {summary?.lastChecked && (
              <p className="text-xs text-green-600 mt-2">
                Last checked: {new Date(summary.lastChecked).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Alerts */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            {showRead ? 'All alerts' : 'Unread alerts'}
            {alerts.length > 0 && <span className="ml-2 bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{alerts.length}</span>}
          </h2>
          <button onClick={() => setShowRead(s => !s)}
            className="text-xs text-brand-600 font-medium hover:underline">
            {showRead ? 'Hide read' : 'Show all'}
          </button>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />)}
          </div>
        ) : !alerts.length ? (
          <div className="card text-center py-12">
            <p className="text-4xl mb-3">✅</p>
            <p className="font-semibold text-gray-700">All clear — no changes detected</p>
            <p className="text-sm text-gray-400 mt-1">
              Your business profile is being monitored. We'll alert you immediately if anything changes.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert: any) => {
              const sev = SEVERITY_STYLE[alert.severity as keyof typeof SEVERITY_STYLE] ?? SEVERITY_STYLE.info;
              const isExpanded = expandedId === alert.id;
              return (
                <div key={alert.id}
                  className={`rounded-xl border-2 p-4 transition-all ${sev.bg} ${sev.border} ${alert.is_read ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-3">
                    <span className="text-xl shrink-0 mt-0.5">{sev.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${sev.badge}`}>{sev.label}</span>
                        {alert.is_competitor && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">Competitor</span>
                        )}
                        <span className="text-xs font-semibold text-gray-700">{alert.field_label}</span>
                        <span className="text-xs text-gray-400 ml-auto">
                          {new Date(alert.detected_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-gray-800 mb-1">
                        {alert.entity_name}
                      </p>
                      <p className="text-sm text-gray-600 mb-2">{alert.ai_explanation}</p>

                      {/* Before / After */}
                      <button onClick={() => setExpandedId(isExpanded ? null : alert.id)}
                        className="text-xs text-brand-600 font-medium hover:underline">
                        {isExpanded ? 'Hide details ↑' : 'Show before/after ↓'}
                      </button>

                      {isExpanded && (
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="bg-white rounded-lg p-3 border border-gray-200">
                            <p className="text-xs text-gray-400 mb-1 font-semibold">Before</p>
                            <p className="text-sm font-mono text-red-700 break-all">
                              {alert.old_value || <span className="text-gray-400 italic">empty</span>}
                            </p>
                          </div>
                          <div className="bg-white rounded-lg p-3 border border-gray-200">
                            <p className="text-xs text-gray-400 mb-1 font-semibold">After</p>
                            <p className="text-sm font-mono text-green-700 break-all">
                              {alert.new_value || <span className="text-gray-400 italic">empty</span>}
                            </p>
                          </div>
                        </div>
                      )}

                      {!alert.is_read && (
                        <button onClick={() => markReadMutation.mutate([alert.id])}
                          className="mt-2 text-xs text-gray-500 hover:text-gray-700 font-medium">
                          Mark as read ✓
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Info footer */}
      <div className="bg-gray-50 rounded-xl p-4 text-sm text-gray-500 space-y-1">
        <p className="font-semibold text-gray-700">How GBP Guard works</p>
        <p>Every day at 5am we take a snapshot of all monitored fields for your business and competitors. We compare it to the previous day's snapshot and alert you to any changes.</p>
        <p className="text-xs mt-2">Uses zero credits — GBP Guard runs entirely in the background as part of your plan.</p>
      </div>
    </div>
  );
}
