import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../store/auth';

interface Theme {
  topic: string;
  mentionCount: number;
  examples: string[];
  sentiment?: 'positive' | 'negative' | 'mixed';
}

interface Intelligence {
  businessId: string;
  reviewsAnalyzed: number;
  positiveThemes: Theme[];
  negativeThemes: Theme[];
  emergingThemes: Theme[];
  overallSentiment: 'positive' | 'neutral' | 'negative' | 'no_data';
  trendingDirection: 'improving' | 'stable' | 'declining' | 'no_data';
  summary: string;
  analyzedAt: string;
  expiresAt: string;
}

async function api(path: string, token: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const SENTIMENT_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  positive:  { bg: 'bg-green-50',  text: 'text-green-700',  label: 'Overall positive' },
  neutral:   { bg: 'bg-gray-50',   text: 'text-gray-700',   label: 'Mixed feelings' },
  negative:  { bg: 'bg-red-50',    text: 'text-red-700',    label: 'Concerning trend' },
  no_data:   { bg: 'bg-gray-50',   text: 'text-gray-400',   label: 'Awaiting reviews' },
};

const TREND_ICONS: Record<string, string> = {
  improving: '↗', stable: '→', declining: '↘', no_data: '–',
};

export default function ReviewIntelligencePanel({ businessId }: { businessId: string }) {
  const token = useAuth(s => s.token) ?? '';
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['review-intelligence', businessId],
    queryFn: () => api(`/api/review-intelligence?businessId=${businessId}`, token).then(d => d.intelligence as Intelligence | null),
    enabled: !!businessId,
  });

  const refreshMut = useMutation({
    mutationFn: () => api('/api/review-intelligence/refresh', token, {
      method: 'POST', body: JSON.stringify({ businessId }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review-intelligence', businessId] }),
  });

  if (isLoading) {
    return <div className="card text-center text-gray-400 py-10">Analyzing reviews…</div>;
  }
  if (error) {
    return (
      <div className="card bg-red-50 border-red-200">
        <p className="text-sm text-red-700">Review intelligence failed: {(error as Error).message}</p>
      </div>
    );
  }
  if (!data || data.overallSentiment === 'no_data' || (data.positiveThemes.length === 0 && data.negativeThemes.length === 0)) {
    return (
      <div className="card text-center py-10">
        <div className="text-4xl mb-3">🪶</div>
        <p className="text-gray-500 mb-3">{data?.summary ?? 'No reviews analyzed yet.'}</p>
        <button onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending} className="btn-primary">
          {refreshMut.isPending ? 'Analyzing…' : 'Analyze reviews now'}
        </button>
      </div>
    );
  }

  const sent = SENTIMENT_COLORS[data.overallSentiment] ?? SENTIMENT_COLORS.no_data;

  return (
    <div className="card p-0 overflow-hidden">
      {/* Headline band */}
      <div className={`${sent.bg} px-6 py-5 border-b border-gray-100`}>
        <div className="flex items-start justify-between gap-4 mb-2">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs font-bold tracking-wider uppercase ${sent.text}`}>{sent.label}</span>
              <span className="text-xs text-gray-400">{TREND_ICONS[data.trendingDirection]} {data.trendingDirection}</span>
            </div>
            <p className="text-base text-gray-800 font-medium leading-snug">{data.summary}</p>
          </div>
          <button
            onClick={() => refreshMut.mutate()}
            disabled={refreshMut.isPending}
            className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap"
            title="Re-analyze reviews"
          >
            {refreshMut.isPending ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
        <p className="text-xs text-gray-400">
          Based on {data.reviewsAnalyzed} reviews · analyzed {new Date(data.analyzedAt).toLocaleDateString()}
        </p>
      </div>

      {/* Themes side by side */}
      <div className="grid grid-cols-2 gap-0">
        <ThemeColumn
          title="What customers love"
          icon="✓"
          accentClass="text-green-700"
          themes={data.positiveThemes}
          bgClass="bg-green-50/30"
        />
        <ThemeColumn
          title="What they complain about"
          icon="!"
          accentClass="text-red-700"
          themes={data.negativeThemes}
          bgClass="bg-red-50/30"
        />
      </div>

      {/* Emerging themes */}
      {data.emergingThemes.length > 0 && (
        <div className="border-t border-gray-100 px-6 py-5 bg-blue-50/30">
          <p className="text-xs font-bold tracking-wider uppercase text-blue-700 mb-3">
            Emerging in last 30 days
          </p>
          <div className="flex flex-wrap gap-2">
            {data.emergingThemes.map((t, i) => (
              <span key={i}
                    className={`px-3 py-1 rounded-full text-xs font-medium border ${
                      t.sentiment === 'positive' ? 'bg-green-50 border-green-200 text-green-700' :
                      t.sentiment === 'negative' ? 'bg-red-50 border-red-200 text-red-700' :
                      'bg-blue-50 border-blue-200 text-blue-700'}`}>
                {t.topic} ({t.mentionCount})
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeColumn({
  title, icon, accentClass, themes, bgClass,
}: { title: string; icon: string; accentClass: string; themes: Theme[]; bgClass: string }) {
  return (
    <div className={`px-6 py-5 ${bgClass}`}>
      <div className="flex items-center gap-2 mb-4">
        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white ${accentClass.replace('text-', 'bg-')}`}>
          {icon}
        </span>
        <h3 className={`font-bold text-sm ${accentClass}`}>{title}</h3>
      </div>
      {themes.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No consistent themes detected.</p>
      ) : (
        <ul className="space-y-3">
          {themes.map((t, i) => (
            <li key={i}>
              <div className="flex items-baseline justify-between mb-1">
                <span className="font-semibold text-gray-800 text-sm capitalize">{t.topic}</span>
                <span className="text-xs text-gray-400">{t.mentionCount} mentions</span>
              </div>
              {t.examples?.length > 0 && (
                <p className="text-xs text-gray-500 italic line-clamp-2">"{t.examples[0]}"</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
