/**
 * CitationsTab — AI Citation Intelligence UI
 *
 * Shows for every AI prompt:
 *   - Which citation sources the AI used
 *   - Which ones YOU have coverage on
 *   - Which ones your COMPETITORS have but you don't
 *   - The exact gap with claim links
 *
 * Also shows aggregate: your overall citation coverage,
 * quick wins (fastest to claim), and competitor advantages.
 */
import { useQuery } from '@tanstack/react-query';
import { aiVisibilityApi } from '../lib/api';

const PRIORITY_STYLE = {
  critical: { bg: 'bg-red-50',    border: 'border-red-200',    badge: 'bg-red-100 text-red-700',    dot: 'bg-red-500'    },
  high:     { bg: 'bg-amber-50',  border: 'border-amber-200',  badge: 'bg-amber-100 text-amber-700',dot: 'bg-amber-500'  },
  medium:   { bg: 'bg-blue-50',   border: 'border-blue-200',   badge: 'bg-blue-100 text-blue-700',  dot: 'bg-blue-400'   },
  low:      { bg: 'bg-gray-50',   border: 'border-gray-200',   badge: 'bg-gray-100 text-gray-600',  dot: 'bg-gray-400'   },
};

const PLATFORM_ICONS: Record<string, string> = {
  chatgpt: '🤖', perplexity: '🔮', gemini: '✨',
};

const CONFIDENCE_BADGE: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-700',
  inferred:  'bg-blue-100 text-blue-700',
  likely:    'bg-gray-100 text-gray-500',
};

function CoverageIcon({ covered, confidence }: { covered: boolean; confidence: string }) {
  if (covered) return <span className="text-green-500 font-bold text-base">✓</span>;
  if (confidence === 'unknown') return <span className="text-gray-300 text-base">?</span>;
  return <span className="text-red-400 font-bold text-base">✗</span>;
}

interface CitationsTabProps {
  businessId: string;
  sector:     string;
}

export default function CitationsTab({ businessId, sector }: CitationsTabProps) {
  const { data: citData, isLoading } = useQuery({
    queryKey: ['ai-citations', businessId],
    queryFn:  () => aiVisibilityApi.citations(businessId).then(r => r.data),
    enabled:  !!businessId,
  });

  const report = citData?.report;

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1,2,3].map(i => <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />)}
      </div>
    );
  }

  if (!report) {
    return (
      <div className="card text-center py-12">
        <p className="text-3xl mb-3">📋</p>
        <p className="font-semibold text-gray-700">No citation data yet</p>
        <p className="text-sm text-gray-400 mt-1">
          Citation intelligence is collected during AI visibility checks.
          Run a check to see which sources AI platforms are using.
        </p>
      </div>
    );
  }

  const criticalGaps:       any[] = report.critical_gaps          ?? [];
  const quickWins:          any[] = report.quick_wins              ?? [];
  const promptCitations:    any[] = report.prompt_citations        ?? [];
  const yourCoverage:       any[] = report.your_coverage           ?? [];
  const compAdvantages:     any[] = report.competitor_advantages   ?? [];

  const coveredCount  = yourCoverage.filter((c: any) => c.covered).length;
  const totalSources  = yourCoverage.length;

  return (
    <div className="space-y-5">

      {/* Overview scores */}
      <div className="grid grid-cols-4 gap-3">
        <div className="card text-center">
          <p className="text-2xl font-black" style={{ color: report.overall_citation_score >= 60 ? '#1D9E75' : '#F59E0B' }}>
            {report.overall_citation_score}%
          </p>
          <p className="text-xs text-gray-500 mt-1">Overall Coverage</p>
          <p className="text-xs text-gray-400">{coveredCount}/{totalSources} sources</p>
        </div>
        {[
          { key: 'chatgpt_citation_score',    label: 'ChatGPT',    icon: '🤖' },
          { key: 'perplexity_citation_score', label: 'Perplexity', icon: '🔮' },
          { key: 'gemini_citation_score',     label: 'Gemini',     icon: '✨' },
        ].map(({ key, label, icon }) => (
          <div key={key} className="card text-center">
            <p className="text-xl mb-0.5">{icon}</p>
            <p className="text-xl font-black" style={{ color: (report[key] ?? 0) >= 60 ? '#1D9E75' : '#F59E0B' }}>
              {report[key] ?? 0}%
            </p>
            <p className="text-xs text-gray-400">{label}</p>
          </div>
        ))}
      </div>

      {/* Quick wins */}
      {quickWins.length > 0 && (
        <div className="card">
          <p className="font-semibold text-sm mb-3">⚡ Quick wins — claim these first</p>
          <div className="space-y-2">
            {quickWins.map((w: any, i: number) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                <div className="w-6 h-6 bg-amber-100 rounded-full flex items-center justify-center text-xs font-bold text-amber-700 shrink-0">{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800">{w.source?.name}</p>
                  <p className="text-xs text-gray-500 truncate">{w.source?.estimatedImpact}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-gray-400">{w.estimatedTime}</p>
                  <a href={w.claimUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-brand-600 font-semibold hover:underline">
                    Claim →
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Your full coverage */}
      <div className="card">
        <p className="font-semibold text-sm mb-3">📋 Your citation coverage</p>
        <div className="space-y-2">
          {yourCoverage.map((c: any, i: number) => (
            <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-50">
              <CoverageIcon covered={c.covered} confidence={c.confidence} />
              <p className="flex-1 text-sm text-gray-700">{c.sourceName}</p>
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${CONFIDENCE_BADGE[c.confidence] ?? 'bg-gray-100 text-gray-500'}`}>
                {c.confidence}
              </span>
              {!c.covered && (
                <a href={c.checkUrl} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-brand-600 font-medium hover:underline shrink-0">
                  Check →
                </a>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Critical gaps */}
      {criticalGaps.length > 0 && (
        <div className="card">
          <p className="font-semibold text-sm mb-3">🚨 Missing citations hurting your AI visibility</p>
          <div className="space-y-3">
            {criticalGaps.map((gap: any, i: number) => {
              const sev = PRIORITY_STYLE[gap.estimatedImpact as keyof typeof PRIORITY_STYLE] ?? PRIORITY_STYLE.medium;
              return (
                <div key={i} className={`p-4 rounded-xl border ${sev.bg} ${sev.border}`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${sev.dot} shrink-0 mt-1`} />
                      <div>
                        <p className="font-semibold text-sm text-gray-800">{gap.source?.name}</p>
                        <p className="text-xs text-gray-500">{gap.source?.domain}</p>
                      </div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${sev.badge}`}>{gap.estimatedImpact}</span>
                  </div>
                  <p className="text-xs text-gray-600 mb-2">{gap.source?.estimatedImpact}</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex gap-1">
                      {(gap.platforms ?? []).map((p: string) => (
                        <span key={p} className="text-sm">{PLATFORM_ICONS[p]}</span>
                      ))}
                    </div>
                    {gap.presentFor?.length > 0 && (
                      <p className="text-xs text-red-600">
                        Competitors with this: {gap.presentFor.join(', ')}
                      </p>
                    )}
                    <a href={gap.claimUrl} target="_blank" rel="noopener noreferrer"
                      className="ml-auto text-xs font-semibold text-brand-600 hover:underline">
                      Claim listing →
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-prompt breakdown */}
      {promptCitations.length > 0 && (
        <div className="card">
          <p className="font-semibold text-sm mb-3">🔍 Per-prompt citation breakdown</p>
          <p className="text-xs text-gray-400 mb-3">
            Shows which sources each AI used when answering a specific query,
            your coverage on those sources, and what competitors have that you don't.
          </p>
          <div className="space-y-4">
            {promptCitations.map((pc: any, i: number) => (
              <div key={i} className="border border-gray-200 rounded-xl overflow-hidden">
                {/* Prompt header */}
                <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <span className="text-base">{PLATFORM_ICONS[pc.platform]}</span>
                  <p className="text-sm font-medium text-gray-700 flex-1 truncate">"{pc.prompt}"</p>
                  <span className={'text-xs px-2 py-0.5 rounded-full ' +
                    (pc.citationScore >= 60 ? 'bg-green-100 text-green-700' :
                     pc.citationScore >= 30 ? 'bg-amber-100 text-amber-700' :
                     'bg-red-100 text-red-700')}>
                    {pc.citationScore}% covered
                  </span>
                </div>

                <div className="px-4 py-3 space-y-3">
                  {/* Citations used */}
                  {pc.citationsUsed?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 mb-1.5">Sources AI used:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {pc.citationsUsed.map((cit: any, j: number) => (
                          <span key={j} className={`text-xs px-2 py-0.5 rounded-full border ${CONFIDENCE_BADGE[cit.confidence] ?? 'bg-gray-100 text-gray-500'}`}>
                            {cit.sourceName ?? cit.domain}
                            {cit.confidence === 'confirmed' ? ' ✓' : cit.confidence === 'likely' ? ' ~' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Your coverage on these sources */}
                  {pc.yourCoverage?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 mb-1.5">Your coverage:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {pc.yourCoverage.map((c: any, j: number) => (
                          <span key={j} className={`text-xs px-2 py-0.5 rounded-full border ${c.covered ? 'bg-green-100 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                            {c.covered ? '✓' : '✗'} {c.sourceName}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Competitor coverage */}
                  {Object.keys(pc.competitorCoverage ?? {}).length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 mb-1.5">Competitor citations:</p>
                      <div className="space-y-1">
                        {Object.entries(pc.competitorCoverage).map(([name, data]: [string, any]) => (
                          <div key={name} className="flex items-center gap-2 text-xs">
                            <span className="text-gray-600 font-medium truncate max-w-24">{name}:</span>
                            <div className="flex flex-wrap gap-1">
                              {(data.sources ?? []).slice(0, 4).map((sid: string) => {
                                const src = { foursquare:'Foursquare', yelp:'Yelp', healthgrades:'Healthgrades',
                                              bbb:'BBB', angi:'Angi', zocdoc:'Zocdoc', google_business:'GBP' }[sid] ?? sid;
                                return (
                                  <span key={sid} className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded text-xs">{src}</span>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Missing for you */}
                  {pc.missingCitations?.length > 0 && (
                    <div className="bg-red-50 border border-red-100 rounded-lg p-2">
                      <p className="text-xs font-semibold text-red-700 mb-1">Missing from your business:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {pc.missingCitations.map((gap: any, j: number) => (
                          <a key={j} href={gap.claimUrl} target="_blank" rel="noopener noreferrer"
                            className="text-xs bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-full hover:bg-red-200 transition-colors">
                            + {gap.source?.name} →
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Competitor citation advantages */}
      {compAdvantages.length > 0 && (
        <div className="card">
          <p className="font-semibold text-sm mb-3">🏆 Competitor citation advantages</p>
          <div className="space-y-3">
            {compAdvantages.map((comp: any, i: number) => (
              <div key={i} className="p-3 bg-gray-50 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold text-sm">{comp.name}</p>
                  <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                    +{comp.advantage} more sources
                  </span>
                </div>
                {comp.keyAdvantages?.length > 0 && (
                  <p className="text-xs text-gray-500">
                    They have: {comp.keyAdvantages.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400 text-center">
        ✓ = confirmed listed · ~ = likely · ? = unknown ·
        Citations checked: {new Date(report.checked_at).toLocaleDateString()}
      </p>
    </div>
  );
}
