/**
 * ReviewIntelligencePanel
 * Displays Gemini-extracted themes above the review list.
 * Shows: headline sentiment, positive themes, negative themes, emerging themes.
 * Auto-fetches on mount, shows graceful empty state.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

interface ReviewTheme {
  theme: string;
  count: number;
  example: string;
}

interface Intel {
  positiveThemes: ReviewTheme[];
  negativeThemes: ReviewTheme[];
  emergingThemes: ReviewTheme[];
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  trend: 'improving' | 'stable' | 'declining';
  reviewsAnalyzed: number;
  generatedAt: string;
}

const TREND_ICON: Record<string, string> = {
  improving: '↗',
  stable:    '→',
  declining: '↘',
};

const TREND_COLOR: Record<string, string> = {
  improving: 'text-green-600',
  stable:    'text-gray-500',
  declining: 'text-red-500',
};

const SENTIMENT_COLOR: Record<string, string> = {
  positive: 'text-green-700',
  neutral:  'text-gray-600',
  negative: 'text-red-700',
};

export default function ReviewIntelligencePanel({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['review-intel', businessId],
    queryFn: async () => {
      const r = await api.get('/review-intelligence?businessId=' + businessId);
      return r.data;
    },
    enabled: !!businessId,
    retry: false,
    // Don't show error to user — handled via onError below
  });

  const refresh = useMutation({
    mutationFn: () => api.post('/review-intelligence/refresh', { businessId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review-intel', businessId] });
      setError('');
    },
    onError: (err: any) => {
      setError(err.response?.data?.error ?? 'Refresh failed');
    },
  });

  if (isLoading) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 animate-pulse">
        <div className="h-4 w-48 bg-gray-200 rounded mb-3" />
        <div className="h-3 w-full bg-gray-100 rounded mb-2" />
        <div className="h-3 w-3/4 bg-gray-100 rounded" />
      </div>
    );
  }

  const intel: Intel | null = data?.intel ?? null;
  const message: string = data?.message ?? '';

  // Not enough reviews / key missing
  if (!intel) {
    const isKeyMissing = (data as any)?.geminiMissing;
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4">
        {isKeyMissing ? (
          <div className="text-center">
            <p className="text-sm font-semibold text-amber-700 mb-1">Gemini API key not configured</p>
            <p className="text-xs text-gray-500 mb-2">
              Add <code className="bg-gray-100 px-1 rounded">GEMINI_API_KEY</code> to your <code className="bg-gray-100 px-1 rounded">.env</code> file to enable AI review theme analysis.
            </p>
            <a href="https://aistudio.google.com" target="_blank" rel="noreferrer"
              className="text-xs text-brand-600 underline font-medium">
              Get free Gemini API key →
            </a>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-sm text-gray-500">
              {message || 'Review intelligence not available yet.'}
            </p>
            <p className="text-xs text-gray-400 mt-1">At least 3 reviews needed to generate themes.</p>
          </div>
        )}
      </div>
    );
  }

  const trendIcon  = TREND_ICON[intel.trend]  ?? '→';
  const trendColor = TREND_COLOR[intel.trend]  ?? 'text-gray-500';
  const sentColor  = SENTIMENT_COLOR[intel.sentiment] ?? 'text-gray-600';
  const age        = Math.round((Date.now() - new Date(intel.generatedAt).getTime()) / 86400000);

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      {/* Headline row */}
      <div className="px-5 py-4 bg-gray-50 border-b border-gray-100 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Review Intelligence
            </span>
            <span className={`text-xs font-bold ${sentColor} capitalize`}>
              · {intel.sentiment}
            </span>
            <span className={`text-xs font-semibold ${trendColor}`}>
              {trendIcon} {intel.trend}
            </span>
          </div>
          {intel.summary && (
            <p className="text-sm text-gray-700 leading-snug">{intel.summary}</p>
          )}
          <p className="text-xs text-gray-400 mt-1">
            Based on {intel.reviewsAnalyzed} reviews ·{' '}
            {age === 0 ? 'Updated today' : `Updated ${age}d ago`}
          </p>
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          title="Refresh (1 credit)"
          className="text-xs text-gray-400 hover:text-brand-600 flex items-center gap-1 shrink-0 mt-1"
        >
          <span className={refresh.isPending ? 'animate-spin inline-block' : ''}>↻</span>
          {refresh.isPending ? '' : '1cr'}
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 bg-red-50 border-b border-red-100">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {/* Themes grid */}
      <div className="grid grid-cols-2 divide-x divide-gray-100">
        {/* Positive */}
        <div className="p-4">
          <p className="text-xs font-semibold text-green-700 mb-3 flex items-center gap-1">
            <span>✓</span> What customers love
          </p>
          {intel.positiveThemes.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No strong positive themes detected</p>
          ) : (
            <div className="space-y-2.5">
              {intel.positiveThemes.map((t, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-sm font-medium text-gray-800">{t.theme}</span>
                    <span className="text-xs text-gray-400 bg-green-50 px-1.5 py-0.5 rounded-full">
                      {t.count}×
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 italic truncate">"{t.example}"</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Negative */}
        <div className="p-4">
          <p className="text-xs font-semibold text-red-600 mb-3 flex items-center gap-1">
            <span>!</span> What they complain about
          </p>
          {intel.negativeThemes.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No significant complaints detected</p>
          ) : (
            <div className="space-y-2.5">
              {intel.negativeThemes.map((t, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-sm font-medium text-gray-800">{t.theme}</span>
                    <span className="text-xs text-gray-400 bg-red-50 px-1.5 py-0.5 rounded-full">
                      {t.count}×
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 italic truncate">"{t.example}"</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Emerging themes */}
      {intel.emergingThemes.length > 0 && (
        <div className="px-5 py-3 bg-blue-50 border-t border-blue-100">
          <p className="text-xs font-semibold text-blue-700 mb-2">
            📈 Emerging in last 30 days
          </p>
          <div className="flex flex-wrap gap-2">
            {intel.emergingThemes.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-white border border-blue-200 rounded-full px-2.5 py-1">
                <span className="text-xs font-medium text-blue-800">{t.theme}</span>
                <span className="text-xs text-blue-400">{t.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
