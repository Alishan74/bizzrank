import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../lib/api';
import { ScoreBar, StateBadge, Skeleton } from '../components/Shared';

export default function OverviewPage() {
  const nav = useNavigate();
  const [pollInterval, setPollInterval] = useState(30000);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => dashboardApi.get().then(r => r.data),
    refetchInterval: pollInterval,
  });

  // Adjust polling based on whether scans are running
  useEffect(() => {
    if (data?.hasActiveScans) {
      setPollInterval(3000);
    } else {
      setPollInterval(30000);
    }
  }, [data?.hasActiveScans]);

  if (isLoading) return <Skeleton />;

  const {
    profile,
    activeOrganicScans = [],
    activeAdSessions = [],
    latestScores = [],
    recentScans = [],
  } = data ?? {};

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-gray-400 text-sm">Your geo visibility intelligence hub</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div
          className="rounded-2xl p-5 bg-brand-50 text-brand-700 cursor-pointer hover:bg-brand-100 transition-colors"
          onClick={() => nav('/profile')}
        >
          <p className="text-xs font-medium opacity-70 mb-1">Credits</p>
          <p className="text-3xl font-bold">{profile?.credits_balance ?? 0}</p>
          <p className="text-xs opacity-60 mt-1">View history →</p>
        </div>
        <div className="rounded-2xl p-5 bg-amber-50 text-amber-700">
          <p className="text-xs font-medium opacity-70 mb-1">Active scans</p>
          <p className="text-3xl font-bold">{activeOrganicScans.length + activeAdSessions.length}</p>
        </div>
        <div
          className="rounded-2xl p-5 bg-green-50 text-green-700 cursor-pointer hover:bg-green-100 transition-colors"
          onClick={() => nav('/profile')}
        >
          <p className="text-xs font-medium opacity-70 mb-1">Plan</p>
          <p className="text-2xl font-bold capitalize">{profile?.plan ?? 'Starter'}</p>
          <p className="text-xs opacity-60 mt-1">View details →</p>
        </div>
      </div>

      {/* Scan type cards */}
      <div className="grid grid-cols-2 gap-5">
        <div
          className="card hover:shadow-md transition-all cursor-pointer border-2 hover:border-brand-200 group"
          onClick={() => nav('/organic/new')}
        >
          <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center text-2xl mb-3">🔍</div>
          <h2 className="text-lg font-bold mb-1">Organic Visibility</h2>
          <p className="text-sm text-gray-500 mb-3">
            Pure organic rankings across your territory. Competitor grids from same scan data.
          </p>
          <div className="text-sm font-semibold text-brand-600 flex items-center gap-2">
            Start scan →
          </div>
        </div>
        <div
          className="card hover:shadow-md transition-all cursor-pointer border-2 hover:border-orange-200 group"
          onClick={() => nav('/ad-insights/new')}
        >
          <div className="w-12 h-12 bg-orange-100 rounded-2xl flex items-center justify-center text-2xl mb-3">📢</div>
          <h2 className="text-lg font-bold mb-1">Ad Insights & Pressure</h2>
          <p className="text-sm text-gray-500 mb-3">
            100% accurate sponsored detection via SerpApi. Hourly tracking throughout business hours.
          </p>
          <div className="text-sm font-semibold text-orange-600 flex items-center gap-2">
            Start session →
          </div>
        </div>
      </div>

      {/* Active organic scans */}
      {activeOrganicScans.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3 flex items-center gap-2 text-sm text-gray-500 uppercase tracking-wide">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            Organic scans running
          </h2>
          {activeOrganicScans.map((s: any) => {
            const pct = s.total_points > 0 ? Math.round((s.points_completed / s.total_points) * 100) : 0;
            return (
              <div
                key={s.id}
                onClick={() => nav('/organic/' + s.id)}
                className="flex items-center justify-between cursor-pointer hover:bg-gray-50 rounded-xl px-2 py-3 transition-colors"
              >
                <div className="flex-1 min-w-0 mr-4">
                  <p className="text-sm font-semibold">{s.keyword}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden max-w-32">
                      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: pct + '%' }} />
                    </div>
                    <span className="text-xs text-gray-500">{pct}%</span>
                  </div>
                </div>
                <StateBadge state={s.state} />
              </div>
            );
          })}
        </div>
      )}

      {/* Active ad sessions */}
      {activeAdSessions.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3 flex items-center gap-2 text-sm text-gray-500 uppercase tracking-wide">
            <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
            Ad sessions running
          </h2>
          {activeAdSessions.map((s: any) => (
            <div
              key={s.id}
              onClick={() => nav('/ad-insights/' + s.id)}
              className="flex items-center justify-between cursor-pointer hover:bg-gray-50 rounded-xl px-2 py-3 transition-colors"
            >
              <div>
                <p className="text-sm font-semibold">{s.keyword}</p>
                <p className="text-xs text-gray-400">{s.scans_completed}/{s.scans_total} slots complete</p>
              </div>
              <StateBadge state={s.state} />
            </div>
          ))}
        </div>
      )}

      {/* Latest scores */}
      {latestScores.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-4">Latest visibility scores</h2>
          {latestScores.map((s: any) => (
            <div
              key={s.id}
              onClick={() => nav('/organic/' + s.scan_id)}
              className="flex items-center justify-between p-3 border border-gray-100 rounded-xl hover:bg-gray-50 cursor-pointer mb-2 transition-colors"
            >
              <div>
                <p className="text-sm font-semibold">{s.keyword}</p>
                <p className="text-xs text-gray-400">
                  avg rank #{Math.round(s.organic_avg_ranking ?? 0)} · {new Date(s.scan_date ?? s.scanned_at).toLocaleDateString()}
                </p>
              </div>
              <ScoreBar score={s.organic_visibility_score} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
