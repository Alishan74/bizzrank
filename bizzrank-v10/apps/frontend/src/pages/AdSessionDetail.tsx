import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adApi } from '../lib/api';
import { StateBadge, Skeleton } from '../components/Shared';

export default function AdSessionDetailPage() {
  const { sessionId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['ad-session', sessionId],
    queryFn: () => adApi.get(sessionId!).then(r => r.data),
    refetchInterval: (queryData: any) => {
      const state = queryData?.session?.state;
      return (state === 'scheduled' || state === 'running') ? 5000 : false;
    },
  });

  const stop = useMutation({
    mutationFn: () => adApi.stop(sessionId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ad-session', sessionId] }),
  });

  const { session, slots = [] } = (data as any) ?? {};

  if (isLoading) return <Skeleton />;
  if (!session) return <p className="text-gray-500">Session not found</p>;

  const completed = slots.filter((s: any) => s.state === 'completed');
  const avgPressure = completed.length > 0
    ? completed.reduce((s: number, sl: any) => s + (sl.pressure_score ?? 0), 0) / completed.length
    : 0;
  const peak = completed.reduce((p: any, s: any) => (s.pressure_score ?? 0) > (p?.pressure_score ?? 0) ? s : p, null);
  const maxAdvertisers = completed.reduce((max: number, s: any) => Math.max(max, s.advertiser_count ?? 0), 0);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <button onClick={() => nav(-1)} className="text-sm text-gray-400 hover:text-gray-600 mb-2">← Back</button>
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">📢</span>
              <h1 className="text-2xl font-bold">{session.keyword}</h1>
            </div>
            <p className="text-gray-400 text-sm">
              {session.scans_completed}/{session.scans_total} slots · {new Date(session.scan_date).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <StateBadge state={session.state} large />
            {(session.state === 'scheduled' || session.state === 'running') && (
              <button onClick={() => stop.mutate()} className="btn-danger text-sm" disabled={stop.isPending}>
                Stop session
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Progress */}
      <div className="card">
        <div className="flex justify-between mb-2">
          <p className="text-sm font-semibold">Session progress</p>
          <p className="text-sm text-gray-500">{session.scans_completed} / {session.scans_total} slots</p>
        </div>
        <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-orange-500 rounded-full transition-all"
            style={{ width: (session.scans_total > 0 ? (session.scans_completed / session.scans_total) * 100 : 0) + '%' }}
          />
        </div>
        {(session.state === 'scheduled' || session.state === 'running') && (
          <p className="text-xs text-gray-400 mt-2">
            Scans run automatically every 1.5 hours. This page refreshes automatically.
          </p>
        )}
      </div>

      {/* Stats */}
      {completed.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-orange-50 rounded-2xl p-4">
            <p className="text-xs text-orange-400 mb-1">Avg Ad Pressure</p>
            <p className="text-2xl font-bold text-orange-600">{Math.round(avgPressure)}/100</p>
          </div>
          <div className="bg-red-50 rounded-2xl p-4">
            <p className="text-xs text-red-400 mb-1">Peak Pressure</p>
            <p className="text-2xl font-bold text-red-600">{peak ? Math.round(peak.pressure_score) + '/100' : '–'}</p>
            {peak && <p className="text-xs text-red-400">{peak.slot_time}</p>}
          </div>
          <div className="bg-purple-50 rounded-2xl p-4">
            <p className="text-xs text-purple-400 mb-1">Max Advertisers</p>
            <p className="text-2xl font-bold text-purple-600">{maxAdvertisers}</p>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="card">
        <h2 className="font-bold mb-4">Hourly Timeline</h2>
        <div className="space-y-2">
          {slots.map((slot: any) => (
            <div
              key={slot.id}
              className={'flex items-center justify-between p-3 rounded-xl border ' + (slot.state === 'completed' ? 'bg-orange-50 border-orange-100' : slot.state === 'running' ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-100')}
            >
              <div className="flex items-center gap-3">
                <div className={'w-2 h-2 rounded-full ' + (slot.state === 'completed' ? 'bg-orange-500' : slot.state === 'running' ? 'bg-blue-500 animate-pulse' : 'bg-gray-300')} />
                <span className="text-sm font-semibold">{slot.slot_time}</span>
                <span className="text-xs text-gray-400 capitalize">{slot.state}</span>
              </div>
              {slot.state === 'completed' && (
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-orange-600 font-semibold">{Math.round(slot.pressure_score ?? 0)}/100</span>
                  <span className="text-gray-500">{slot.advertiser_count ?? 0} advertisers</span>
                  <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-orange-500 rounded-full" style={{ width: (slot.pressure_score ?? 0) + '%' }} />
                  </div>
                </div>
              )}
              {slot.state === 'running' && <span className="text-xs text-blue-600 animate-pulse">Scanning...</span>}
              {slot.state === 'pending' && <span className="text-xs text-gray-400">Scheduled</span>}
              {slot.state === 'skipped' && <span className="text-xs text-gray-400">Skipped</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
