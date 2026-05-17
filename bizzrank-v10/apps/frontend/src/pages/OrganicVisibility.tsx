import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { organicApi } from '../lib/api';
import { StateBadge, ScoreBar } from '../components/Shared';

export default function OrganicPage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['organic-scans'],
    queryFn: () => organicApi.list().then(r => r.data.scans),
    refetchInterval: 8000,
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Organic Visibility</h1>
          <p className="text-gray-400 text-sm">Pure organic rankings — no sponsored contamination</p>
        </div>
        <button onClick={() => nav('/organic/new')} className="btn-primary">+ New Scan</button>
      </div>

      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : !data?.length ? (
          <div className="p-12 text-center">
            <div className="text-5xl mb-4">🔍</div>
            <p className="text-gray-500 mb-4">No organic scans yet</p>
            <button onClick={() => nav('/organic/new')} className="btn-primary text-sm">Run your first scan</button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Keyword', 'Method', 'Points', 'Score', 'Date', 'Status'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.map((s: any) => (
                <tr key={s.id} onClick={() => nav('/organic/' + s.id)} className="hover:bg-gray-50 cursor-pointer">
                  <td className="px-4 py-3 font-semibold">{s.keyword}</td>
                  <td className="px-4 py-3 text-gray-500 capitalize">{s.targeting_method?.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-gray-500">{s.total_points ?? '–'}</td>
                  <td className="px-4 py-3">
                    {s.organic_scores?.[0]
                      ? <ScoreBar score={s.organic_scores[0].organic_visibility_score} />
                      : <span className="text-gray-300">–</span>}
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
