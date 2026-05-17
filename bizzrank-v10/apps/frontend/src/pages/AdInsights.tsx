import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { adApi } from '../lib/api';
import { StateBadge } from '../components/Shared';

export default function AdInsightsPage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['ad-scans'],
    queryFn: () => adApi.list().then(r => r.data.sessions),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Ad Insights & Pressure</h1>
          <p className="text-gray-400 text-sm">100% accurate sponsored detection via SerpApi. Hourly tracking.</p>
        </div>
        <button onClick={() => nav('/ad-insights/new')} className="btn-primary">+ New Session</button>
      </div>

      <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
        <p className="font-semibold text-orange-800 mb-1">How Ad Insights works</p>
        <p className="text-sm text-orange-700">
          SerpApi scrapes the actual Google Maps page and returns results with a clear sponsored flag.
          Organic and sponsored results are 100% accurately separated — no guessing.
          Scans run every 1.5 hours during your business hours and build a full-day pressure report.
        </p>
      </div>

      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : !data?.length ? (
          <div className="p-12 text-center">
            <div className="text-5xl mb-4">📢</div>
            <p className="text-gray-500 mb-4">No ad sessions yet</p>
            <button onClick={() => nav('/ad-insights/new')} className="btn-primary text-sm">Start first session</button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Keyword', 'Businesses', 'Progress', 'Date', 'Status'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.map((s: any) => (
                <tr key={s.id} onClick={() => nav('/ad-insights/' + s.id)} className="hover:bg-gray-50 cursor-pointer">
                  <td className="px-4 py-3 font-semibold">{s.keyword}</td>
                  <td className="px-4 py-3 text-gray-500">{s.business_ids?.length ?? 1}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-orange-500 rounded-full"
                          style={{ width: (s.scans_total > 0 ? (s.scans_completed / s.scans_total) * 100 : 0) + '%' }}
                        />
                      </div>
                      <span className="text-xs text-gray-500">{s.scans_completed}/{s.scans_total}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{new Date(s.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3"><StateBadge state={s.state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
