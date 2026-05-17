import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { organicApi, subscribeScanProgress } from '../lib/api';
import { useAuth } from '../store/auth';
import { StateBadge, Skeleton, SmallGrid, GridPointModal } from '../components/Shared';

export default function OrganicScanDetailPage() {
  const { scanId } = useParams();
  const nav = useNavigate();
  const token = useAuth(s => s.token);
  const [tab, setTab] = useState('organic');
  const [selectedPoint, setSelectedPoint] = useState(null as any);
  const [sseProgress, setSseProgress] = useState(null as any);
  const cleanupRef = useRef(null as any);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['organic-scan', scanId],
    queryFn: () => organicApi.get(scanId!).then(r => r.data),
    refetchInterval: false,
  });

  const { scan, score } = (data as any) ?? {};

  useEffect(() => {
    if (!scanId || !scan) return;
    if (scan.state !== 'pending' && scan.state !== 'running') return;
    if (cleanupRef.current) cleanupRef.current();
    const cleanup = subscribeScanProgress(
      scanId, token ?? '',
      (d: any) => setSseProgress(d),
      () => { setSseProgress(null); refetch(); }
    );
    cleanupRef.current = cleanup;
    return cleanup;
  }, [scanId, scan?.state]);

  const progress = sseProgress ?? {
    pointsCompleted: scan?.points_completed ?? 0,
    totalPoints: scan?.total_points ?? 0,
    percentComplete: scan?.total_points > 0 ? Math.round((scan.points_completed / scan.total_points) * 100) : 0,
  };

  if (isLoading) return <Skeleton />;
  if (!scan) return <p className="text-gray-500">Scan not found</p>;

  const clientHeatmap = score?.organic_heatmap_points ?? [];
  const competitorScores = score?.competitor_scores ?? [];

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <button onClick={() => nav(-1)} className="text-sm text-gray-400 hover:text-gray-600 mb-2">Back</button>
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold">{scan.keyword}</h1>
            </div>
            <p className="text-gray-400 text-sm capitalize">
              {scan.targeting_method?.replace('_', ' ')} · {scan.total_points} points · {new Date(scan.scan_date ?? scan.created_at).toLocaleDateString()}
            </p>
          </div>
          <StateBadge state={scan.state} large />
        </div>
      </div>

      {(scan.state === 'pending' || scan.state === 'running') && (
        <div className="card bg-blue-50 border-blue-200">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 bg-blue-500 rounded-full animate-pulse shrink-0" />
              <p className="text-sm text-blue-700 font-semibold">
                Scanning {progress.pointsCompleted} / {progress.totalPoints || '?'} points
              </p>
            </div>
            <span className="text-sm font-bold text-blue-700">{progress.percentComplete}%</span>
          </div>
          <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: progress.percentComplete + '%' }} />
          </div>
          <p className="text-xs text-blue-500 mt-1">Live updates — results appear automatically when complete</p>
        </div>
      )}

      {scan.state === 'failed' && (
        <div className="card bg-red-50 border-red-200">
          <p className="text-sm text-red-700">Scan failed: {scan.error_message ?? 'Unknown error'}</p>
        </div>
      )}

      {score && (
        <div className="card p-0 overflow-hidden">
          <div className="flex border-b border-gray-100 px-6">
            <button onClick={() => setTab('organic')} className={'px-4 py-4 text-sm mr-2 ' + (tab === 'organic' ? 'tab-active' : 'tab-inactive')}>Organic Visibility</button>
            <button onClick={() => setTab('sponsored')} className={'px-4 py-4 text-sm ' + (tab === 'sponsored' ? 'tab-active' : 'tab-inactive')}>Ad Insights</button>
          </div>
          <div className="p-6 space-y-8">
            {tab === 'organic' && (
              <>
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <h3 className="font-bold text-gray-700">Your Business</h3>
                    <span className="badge-blue">Client</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 mb-5">
                    {[['Visibility Score', Math.round(score.organic_visibility_score) + '/100', 'text-brand-600'],['Avg Ranking','#' + Math.round(score.organic_avg_ranking ?? 0),'text-amber-600'],['Dominance',Math.round(score.organic_territory_dominance) + '%','text-green-600'],['Total Points',score.organic_total_cells,'text-gray-700'],['Top 3',score.organic_top3_cells,'text-green-600'],['Top 10',score.organic_top10_cells,'text-blue-600']].map(([l,v,c]) => (
                      <div key={l as string} className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-400 mb-1">{l}</p><p className={'text-lg font-bold ' + c}>{v}</p></div>
                    ))}
                  </div>
                  <SmallGrid heatmapPoints={clientHeatmap} onCellClick={setSelectedPoint} />
                </div>
                {competitorScores.map((comp: any) => (
                  <div key={comp.placeId} className="border-t border-gray-100 pt-6">
                    <div className="flex items-center gap-2 mb-4">
                      <h3 className="font-bold text-gray-700">{comp.name}</h3>
                      <span className="badge-red">Competitor</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 mb-5">
                      {[['Score',Math.round(comp.visibilityScore)+'/100','text-red-600'],['Avg Rank',comp.avgRanking?'#'+Math.round(comp.avgRanking):'Not found','text-amber-600'],['Dominance',Math.round(comp.territoryDominance)+'%','text-orange-600']].map(([l,v,c]) => (
                        <div key={l as string} className="bg-red-50 rounded-xl p-3"><p className="text-xs text-red-300 mb-1">{l}</p><p className={'text-lg font-bold ' + c}>{v}</p></div>
                      ))}
                    </div>
                    <SmallGrid heatmapPoints={comp.heatmapPoints ?? []} onCellClick={setSelectedPoint} />
                  </div>
                ))}
              </>
            )}
            {tab === 'sponsored' && (
              <div>
                <p className="text-sm text-gray-600 mb-4">Sponsored results tracked in Ad Insights sessions via SerpApi for 100% accurate detection.</p>
                <button onClick={() => nav('/ad-insights/new')} className="btn-primary">Start Ad Insights Session</button>
              </div>
            )}
          </div>
        </div>
      )}

      {selectedPoint && <GridPointModal point={selectedPoint} onClose={() => setSelectedPoint(null)} />}
    </div>
  );
}
