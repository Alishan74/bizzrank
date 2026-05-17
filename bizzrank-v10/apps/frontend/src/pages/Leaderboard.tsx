import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { bizApi, leaderboardApi } from '../lib/api';
import { Skeleton } from '../components/Shared';

export default function LeaderboardPage() {
  const nav = useNavigate();
  const [selectedBizId, setSelectedBizId] = useState('');

  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  useEffect(() => {
    if (businesses?.length && !selectedBizId) {
      setSelectedBizId(businesses[0].id);
    }
  }, [businesses]);

  const { data, isLoading } = useQuery({
    queryKey: ['leaderboard', selectedBizId],
    queryFn: () => leaderboardApi.get(selectedBizId).then(r => r.data),
    enabled: !!selectedBizId,
  });

  const leaderboard: any[] = data?.leaderboard ?? [];
  const myEntry = leaderboard.find(e => e.is_client_business);
  const myRank = myEntry?.leaderboard_rank ?? null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">🏆 Neighborhood Leaderboard</h1>
          <p className="text-gray-400 text-sm">Top businesses in your territory — updated after every scan</p>
        </div>
        <select
          className="input max-w-xs"
          value={selectedBizId}
          onChange={e => setSelectedBizId(e.target.value)}
        >
          {businesses?.map((b: any) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      {/* My rank hero */}
      {myRank && (
        <div className={'rounded-2xl p-6 text-white ' + (myRank === 1 ? 'bg-gradient-to-r from-yellow-400 to-amber-500' : myRank <= 3 ? 'bg-gradient-to-r from-brand-500 to-indigo-600' : 'bg-gradient-to-r from-gray-500 to-gray-600')}>
          <p className="text-sm opacity-80 mb-1">Your neighborhood ranking</p>
          <div className="flex items-baseline gap-3">
            <span className="text-6xl font-black">#{myRank}</span>
            <span className="opacity-80">of {leaderboard.length} businesses in territory</span>
          </div>
          {myRank > 1 && myEntry && leaderboard[myRank - 2] && (
            <p className="text-sm opacity-80 mt-2">
              {leaderboard[myRank - 2].green_dots - myEntry.green_dots} more top-3 appearances needed to reach #{myRank - 1}
            </p>
          )}
          {myRank === 1 && (
            <p className="text-sm opacity-90 mt-2">👑 You own this territory. Keep scanning to maintain #1.</p>
          )}
        </div>
      )}

      {/* No data state */}
      {!selectedBizId && (
        <div className="card text-center py-12">
          <p className="text-gray-400">Select a business to see the leaderboard</p>
        </div>
      )}

      {selectedBizId && isLoading && <Skeleton />}

      {selectedBizId && !isLoading && leaderboard.length === 0 && (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">🏆</div>
          <p className="text-gray-500 mb-3">No leaderboard data yet</p>
          <p className="text-sm text-gray-400 mb-4">Run an organic scan to see how you rank against competitors in your territory</p>
          <button onClick={() => nav('/organic/new')} className="btn-primary">Run a scan</button>
        </div>
      )}

      {data?.keyword && leaderboard.length > 0 && (
        <p className="text-sm text-gray-500">
          Keyword: <strong>{data.keyword}</strong> · Scan date: {data.scanDate ? new Date(data.scanDate).toLocaleDateString() : ''}
        </p>
      )}

      {leaderboard.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 grid grid-cols-12 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <span className="col-span-1">#</span>
            <span className="col-span-5">Business</span>
            <span className="col-span-2 text-center">Top 3</span>
            <span className="col-span-2 text-center">4–10</span>
            <span className="col-span-2 text-center">Avg rank</span>
          </div>

          {leaderboard.map((entry: any, idx: number) => (
            <div
              key={entry.id}
              className={'px-5 py-4 grid grid-cols-12 items-center border-b border-gray-50 last:border-0 ' + (entry.is_client_business ? 'bg-brand-50' : '')}
            >
              <span className={'col-span-1 font-black text-lg ' + (idx === 0 ? 'text-yellow-500' : idx === 1 ? 'text-gray-400' : idx === 2 ? 'text-amber-600' : 'text-gray-400')}>
                {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx + 1)}
              </span>

              <div className="col-span-5">
                <p className={'text-sm font-semibold ' + (entry.is_client_business ? 'text-brand-700' : 'text-gray-800')}>
                  {entry.place_name}
                  {entry.is_client_business && <span className="ml-2 badge-blue text-xs">You</span>}
                </p>
                {entry.place_address && (
                  <p className="text-xs text-gray-400 truncate">{entry.place_address}</p>
                )}
              </div>

              <div className="col-span-2 text-center">
                <div className="flex items-center justify-center gap-1">
                  <span className="text-green-500 font-bold">{entry.green_dots}</span>
                  <div className="flex gap-0.5">
                    {Array.from({ length: Math.min(entry.green_dots, 5) }, (_, i) => (
                      <div key={i} className="w-1.5 h-1.5 bg-green-500 rounded-sm" />
                    ))}
                  </div>
                </div>
              </div>

              <div className="col-span-2 text-center">
                <span className="text-amber-500 font-bold">{entry.yellow_dots}</span>
              </div>

              <div className="col-span-2 text-center">
                <span className="text-sm text-gray-600">{entry.avg_rank ? '#' + entry.avg_rank : '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
