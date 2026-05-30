import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../lib/api';
import { ScoreBar, StateBadge, Skeleton } from '../components/Shared';
import api from '../lib/api';

// ── Build insights with full context ─────────────────────────
interface Insight {
  id: string;
  icon: string;
  type: 'win' | 'alert' | 'tip' | 'info';
  businessName: string;
  keyword: string;
  headline: string;
  detail: string;     // plain English — what happened
  reason: string;     // why it happened
  action?: string;
  actionPath?: string;
}

function buildInsights(
  data:        any,
  businesses:  any[],
  latestScores: any[],
  signals:     any[],
): Insight[] {
  // Also reads data.gbpGuard and data.aiVisibility directly
  // These are included in the dashboard response and power
  // the GBP Guard and AI Visibility insight cards
  const insights: Insight[] = [];
  const opp = data?.intelligence?.opportunity;

  // Score-based insights per keyword
  const _seen = new Set();
  const deduped = latestScores.filter((s: any) => {
    const k = (s.business_id ?? '') + '|' + (s.keyword ?? '');
    if (_seen.has(k)) return false;
    _seen.add(k); return true;
  });
  for (const s of deduped.slice(0, 6)) {
    const score = s.organic_visibility_score ?? 0;
    const rank  = Math.round(s.organic_avg_ranking ?? 0);
    const biz   = businesses.find((b: any) => b.id === s.business_id) ?? { name: 'Your Business' };
    const kw    = s.keyword ?? 'your keyword';

    const top3 = s.organic_top3_cells ?? 0;
    const top10 = s.organic_top10_cells ?? 0;
    const total = s.organic_total_cells ?? 25;

    // Honest thresholds based on ACTUAL rank and top-3 coverage
    // rank <= 3 AND top3 > 40% of zones = genuinely strong
    // rank <= 5 AND top3 > 0 = decent
    // rank 6-10 = page 1 but weak
    // rank > 10 = poor

    if (rank <= 3 && top3 >= Math.round(total * 0.4)) {
      insights.push({
        id: 'score-high-' + s.id, icon: '✅', type: 'win',
        businessName: biz.name, keyword: kw,
        headline: `Strong — ranking top 3 in ${top3} of ${total} zones`,
        detail: `${biz.name} averages rank #${rank} for "${kw}" and appears in the top 3 in ${top3} zones. Customers across most of your area can easily find you.`,
        reason: 'Strong rankings usually mean you have more reviews than competitors in those zones, a well-completed Google profile, and consistent customer engagement.',
        action: 'See heatmap →', actionPath: '/organic/' + s.scan_id,
      });
    } else if (rank <= 5 && top3 > 0) {
      insights.push({
        id: 'score-decent-' + s.id, icon: '🟡', type: 'tip',
        businessName: biz.name, keyword: kw,
        headline: `Decent — rank #${rank} average, top 3 in ${top3} zone${top3 !== 1 ? 's' : ''}`,
        detail: `${biz.name} averages rank #${rank} for "${kw}". You appear on page 1 in ${top10} zones but only top 3 in ${top3}. There's clear room to grow.`,
        reason: 'To reach top 3 in more zones you typically need more recent reviews than competitors and a fully-filled Google Business Profile with photos and updated hours.',
        action: 'See where you rank →', actionPath: '/organic/' + s.scan_id,
      });
    } else if (rank <= 10) {
      insights.push({
        id: 'score-weak-' + s.id, icon: '⚠️', type: 'alert',
        businessName: biz.name, keyword: kw,
        headline: `Weak — rank #${rank} average, top 3 in 0 zones`,
        detail: `${biz.name} averages rank #${rank} for "${kw}". You appear on page 1 in ${top10} zones but never in the top 3. Most customers searching nearby will see competitors first.`,
        reason: 'Ranking on page 1 but not top 3 means competitors have more reviews, higher ratings, or better-optimised profiles. Check the heatmap to see exactly who is outranking you and where.',
        action: 'See full heatmap →', actionPath: '/organic/' + s.scan_id,
      });
    } else if (score > 0) {
      insights.push({
        id: 'score-low-' + s.id, icon: '🔴', type: 'alert',
        businessName: biz.name, keyword: kw,
        headline: `Poor visibility — rank #${rank} average, page 2+ in most zones`,
        detail: `${biz.name} averages rank #${rank} for "${kw}". You appear in the top 10 in only ${top10} of ${total} zones. The majority of nearby customers won't find you on Google Maps.`,
        reason: 'Page 2+ rankings mean competitors significantly outrank you in reviews, ratings, or profile completeness. This needs immediate attention — most users never scroll past the top 3.',
        action: 'See full heatmap →', actionPath: '/organic/' + s.scan_id,
      });
    }
  }

  // Signal-based insights
  for (const s of signals.slice(0, 5)) {
    const biz = businesses.find((b: any) => b.id === s.business_id) ?? { name: 'Your Business' };
    const kw  = s.keyword ?? '';
    const loc = s.location_name ?? '';
    const locText = loc ? ` in ${loc}` : '';

    if (s.signal_type === 'RankingDelta' && s.direction === 'down' && s.value >= 2) {
      insights.push({
        id: 'sig-down-' + s.id, icon: '📉', type: 'alert',
        businessName: biz.name, keyword: kw,
        headline: `Ranking dropped ${Math.round(s.value)} positions${locText}`,
        detail: `${biz.name}'s position for "${kw}" fell by ${Math.round(s.value)} spots${locText}. Your previous rank was compared against the current scan data.`,
        reason: 'Ranking drops usually happen when: (1) a competitor recently got several new reviews, (2) they updated their business profile, or (3) Google re-evaluated the area. Check competitor activity.',
        action: 'See what changed →', actionPath: '/organic',
      });
    }
    if (s.signal_type === 'RankingDelta' && s.direction === 'up' && s.value >= 2) {
      insights.push({
        id: 'sig-up-' + s.id, icon: '🚀', type: 'win',
        businessName: biz.name, keyword: kw,
        headline: `Ranking improved ${Math.round(s.value)} positions${locText}`,
        detail: `${biz.name} jumped ${Math.round(s.value)} spots for "${kw}"${locText}. Your visibility in this area increased.`,
        reason: 'Ranking improvements usually follow recent reviews, profile updates, or a competitor going inactive.',
      });
    }
    if (s.signal_type === 'CompetitorDelta') {
      insights.push({
        id: 'sig-comp-' + s.id, icon: '👀', type: 'alert',
        businessName: biz.name, keyword: kw,
        headline: 'New competitor appeared in your search results',
        detail: `A business not in your tracked competitors is now ranking above ${biz.name} for "${kw}"${locText}. This is worth investigating.`,
        reason: 'New competitors appear when a business launches, gets a surge of reviews, or Google expands its local index. Adding them as a tracked competitor will help you monitor this.',
        action: 'Manage competitors →', actionPath: '/businesses',
      });
    }
    if (s.signal_type === 'ReviewDelta') {
      insights.push({
        id: 'sig-review-' + s.id, icon: '⭐', type: 'alert',
        businessName: biz.name, keyword: kw,
        headline: `${Math.round(s.value)} new reviews need responses`,
        detail: `${biz.name} has ${Math.round(s.value)} unanswered reviews. Google uses response rate as a ranking signal.`,
        reason: 'Businesses that respond to reviews within 24 hours rank higher. Even a brief reply counts.',
        action: 'Respond now →', actionPath: '/reviews',
      });
    }
  }

  // ── AdPressureDelta signal — ad spend spike in your area ──────
  // Previously: this signal was saved to intel_signals but never
  // displayed anywhere. Customers had no idea when competitor ad
  // spend spiked in their service area.
  for (const s of signals.filter((x: any) => x.signal_type === 'AdPressureDelta').slice(0, 2)) {
    const biz = businesses.find((b: any) => b.id === s.business_id) ?? { name: 'Your Business' };
    insights.push({
      id:           'sig-ad-' + s.id,
      icon:         '📢',
      type:         'alert',
      businessName: biz.name,
      keyword:      s.keyword ?? '',
      headline:     `Competitor ad spend spiked ${Math.round(s.value)}% this week`,
      detail:       `${biz.name}'s service area saw a ${Math.round(s.value)}% increase in Google Ads activity. Competitors are investing more in paid placements — your organic position matters more now.`,
      reason:       'Ad pressure spikes mean competitors are paying to appear above organic results. Strong organic rankings are your defence — customers who scroll past ads trust organic results more.',
      action:       'View ad pressure →',
      actionPath:   '/ad-insights',
    });
  }

  // ── GBP Guard alerts — critical profile changes ─────────────
  // Previously: GBP Guard ran daily and detected changes, but
  // customers only saw alerts if they navigated to /gbp-guard.
  // Critical alerts (address changed, permanently closed) now
  // surface directly in the Overview feed.
  const gbp = data?.gbpGuard;
  if (gbp?.criticalUnread > 0) {
    const firstBiz = businesses[0] ?? { name: 'Your Business' };
    insights.push({
      id:           'gbp-critical',
      icon:         '🚨',
      type:         'alert',
      businessName: firstBiz.name,
      keyword:      '',
      headline:     `${gbp.criticalUnread} critical GBP change${gbp.criticalUnread > 1 ? 's' : ''} detected`,
      detail:       `Your Google Business Profile has ${gbp.criticalUnread} critical change${gbp.criticalUnread > 1 ? 's' : ''} that need immediate attention. This could be an unauthorized edit to your address, phone number, or category.`,
      reason:       'Anyone can suggest edits to a Google Business Profile. Unauthorized changes to your address or category directly harm your local search rankings and can send customers to the wrong location.',
      action:       'Review changes →',
      actionPath:   '/gbp-guard',
    });
  } else if (gbp?.totalUnread > 0) {
    const firstBiz = businesses[0] ?? { name: 'Your Business' };
    insights.push({
      id:           'gbp-unread',
      icon:         '🛡️',
      type:         'info',
      businessName: firstBiz.name,
      keyword:      '',
      headline:     `${gbp.totalUnread} GBP update${gbp.totalUnread > 1 ? 's' : ''} detected`,
      detail:       `${gbp.totalUnread} change${gbp.totalUnread > 1 ? 's were' : ' was'} detected on your Google Business Profile in the last 7 days. Review them to confirm they're authorised.`,
      reason:       'Regular profile changes like hours updates are normal, but any change to your address, phone, or category should be verified.',
      action:       'Review changes →',
      actionPath:   '/gbp-guard',
    });
  }

  // ── AI Visibility score — how you appear in AI searches ─────
  // Previously: AI Visibility was tracked weekly but the score
  // was completely invisible unless the customer visited /ai-visibility.
  // Now surfaces as an insight when the score is low, declining,
  // or when it's the first time a score exists (first check done).
  const aiv = data?.aiVisibility;
  if (aiv) {
    const firstBiz = businesses[0] ?? { name: 'Your Business' };
    const score    = aiv.overallScore ?? 0;
    const disc     = aiv.discoveryScore ?? 0;

    if (aiv.trend === 'improving' && (aiv.trendDelta ?? 0) >= 10) {
      insights.push({
        id:           'aiv-improving',
        icon:         '🤖',
        type:         'win',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `AI visibility improving — up ${aiv.trendDelta} points`,
        detail:       `${firstBiz.name}'s AI visibility score rose by ${aiv.trendDelta} points to ${score}/100. More customers asking ChatGPT, Gemini, or Perplexity for recommendations in your area are now finding you.`,
        reason:       'AI visibility improves when your Foursquare/Yelp listings are complete, your GBP description contains location keywords, and your reviews mention your specific services.',
        action:       'View AI visibility →',
        actionPath:   '/ai-visibility',
      });
    } else if (score < 20) {
      insights.push({
        id:           'aiv-low',
        icon:         '🤖',
        type:         'alert',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `Low AI visibility — appearing in ${score}% of AI searches`,
        detail:       `When someone asks ChatGPT or Google AI "best ${firstBiz.name?.split(' ')[0] ?? 'business'} near me", ${firstBiz.name} appears in only ${score}% of AI recommendations. ${disc < 20 ? 'Your discovery score is ' + disc + '% — new customers rarely find you through AI.' : ''}`,
        reason:       aiv.topInsight ?? 'AI platforms like ChatGPT use Foursquare as their primary local data source. Claiming your Foursquare listing is the highest-impact single action.',
        action:       'Improve AI visibility →',
        actionPath:   '/ai-visibility',
      });
    } else if (score < 50) {
      insights.push({
        id:           'aiv-medium',
        icon:         '🤖',
        type:         'tip',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `AI visibility at ${score}% — room to grow`,
        detail:       `${firstBiz.name} appears in ${score}% of AI recommendation queries. Discovery score: ${disc}% — this is the score that drives new customers who don't already know you.`,
        reason:       aiv.topInsight ?? 'Strengthen your Foursquare, Yelp, and Healthgrades listings to improve AI recommendation rates across all platforms.',
        action:       'View AI visibility →',
        actionPath:   '/ai-visibility',
      });
    } else if (aiv.trend === 'declining') {
      insights.push({
        id:           'aiv-declining',
        icon:         '🤖',
        type:         'alert',
        businessName: firstBiz.name,
        keyword:      '',
        headline:     `AI visibility declining — down ${Math.abs(aiv.trendDelta ?? 0)} points`,
        detail:       `${firstBiz.name}'s AI visibility dropped from ${score + Math.abs(aiv.trendDelta ?? 0)} to ${score}/100. You're appearing in fewer AI searches than last week.`,
        reason:       'AI visibility can decline when competitors improve their listings, when your review response rate drops, or when your GBP information becomes inconsistent.',
        action:       'View AI visibility →',
        actionPath:   '/ai-visibility',
      });
    }
  }

  // No data fallback
  if (insights.length === 0) {
    insights.push({
      id: 'start', icon: '🏁', type: 'tip',
      businessName: '', keyword: '',
      headline: 'Monitoring is ready — waiting for first scan',
      detail: 'Add a keyword to your business and the system will begin tracking your Google Maps ranking automatically.',
      reason: 'The Intelligence Engine needs at least one keyword to know what to monitor.',
      action: 'Set up keywords →', actionPath: '/businesses',
    });
  }

  return insights;
}

// ── Insight card ──────────────────────────────────────────────
function InsightCard({ insight, onNav }: { insight: Insight; onNav: (p: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const bg: Record<string, string> = {
    win: 'bg-green-50 border-green-200', alert: 'bg-amber-50 border-amber-200',
    tip: 'bg-blue-50 border-blue-200', info: 'bg-white border-gray-200',
  };
  const dot: Record<string, string> = {
    win: 'bg-green-500', alert: 'bg-amber-500', tip: 'bg-blue-500', info: 'bg-gray-300',
  };

  return (
    <div className={'rounded-2xl border p-4 ' + (bg[insight.type] ?? bg.info)}>
      {/* Context tag */}
      {(insight.businessName || insight.keyword) && (
        <div className="flex items-center gap-1.5 mb-2">
          {insight.businessName && (
            <span className="text-[10px] font-semibold text-gray-500 bg-white/80 border border-gray-200 px-2 py-0.5 rounded-full">
              📍 {insight.businessName}
            </span>
          )}
          {insight.keyword && (
            <span className="text-[10px] font-semibold text-gray-500 bg-white/80 border border-gray-200 px-2 py-0.5 rounded-full">
              🔍 "{insight.keyword}"
            </span>
          )}
        </div>
      )}

      <div className="flex items-start gap-3">
        <span className="text-xl shrink-0 mt-0.5">{insight.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={'w-2 h-2 rounded-full shrink-0 ' + (dot[insight.type] ?? dot.info)} />
            <p className="text-sm font-bold text-gray-900">{insight.headline}</p>
          </div>
          <p className="text-sm text-gray-600 leading-relaxed">{insight.detail}</p>

          {/* Why it happened — expandable */}
          <button onClick={() => setExpanded(e => !e)}
            className="mt-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1">
            <span>{expanded ? '▾' : '▸'}</span>
            Why did this happen?
          </button>
          {expanded && (
            <p className="mt-1.5 text-xs text-gray-500 bg-white/60 rounded-xl px-3 py-2 leading-relaxed border border-gray-100">
              {insight.reason}
            </p>
          )}

          {insight.action && insight.actionPath && (
            <button onClick={() => onNav(insight.actionPath!)}
              className="mt-2 text-xs font-semibold text-brand-600 hover:text-brand-800 transition-colors">
              {insight.action}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Business group header ─────────────────────────────────────
function BizGroupHeader({ biz }: { biz: any }) {
  return (
    <div className="flex items-center gap-3 mb-3 mt-6 first:mt-0">
      <div className="w-8 h-8 bg-brand-100 rounded-xl flex items-center justify-center shrink-0">
        <span className="text-brand-700 font-bold text-sm">{biz.name?.[0]?.toUpperCase() ?? '?'}</span>
      </div>
      <div>
        <p className="font-bold text-gray-800 text-sm">{biz.name}</p>
        {biz.address && <p className="text-xs text-gray-400">{biz.address}</p>}
      </div>
    </div>
  );
}

// ── useState import fix ───────────────────────────────────────
import { useState } from 'react';

// ── Main page ─────────────────────────────────────────────────
export default function OverviewPage() {
  const nav = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => dashboardApi.get().then(r => r.data),
    refetchInterval: 60000,
  });

  const { data: signalData } = useQuery({
    queryKey: ['intel-signals'],
    queryFn: async () => {
      const biz = data?.businesses?.[0];
      if (!biz) return { signals: [] };
      return api.get('/intelligence/signals?businessId=' + biz.id + '&limit=20').then(r => r.data);
    },
    enabled: !!data?.businesses?.length,
    staleTime: 30000,
  });

  if (isLoading) return <Skeleton />;

  const {
    profile, activeOrganicScans = [], activeAdSessions = [],
    latestScores = [], businesses = [], intelligence,
  } = data ?? {};

  const signals = signalData?.signals ?? data?.intelligence?.recentSignals ?? [];
  const opp = intelligence?.opportunity;

  const allInsights = buildInsights(data, businesses, latestScores, signals);

  // Group insights by business
  const bizGroups: Record<string, { biz: any; insights: Insight[] }> = {};
  const noBizInsights: Insight[] = [];

  for (const insight of allInsights) {
    if (!insight.businessName) {
      noBizInsights.push(insight);
    } else {
      const biz = businesses.find((b: any) => b.name === insight.businessName)
        ?? { id: insight.businessName, name: insight.businessName };
      const key = biz.id ?? insight.businessName;
      if (!bizGroups[key]) bizGroups[key] = { biz, insights: [] };
      bizGroups[key].insights.push(insight);
    }
  }

  const grouped = Object.values(bizGroups);

  return (
    <div className="space-y-6">

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl p-5 bg-brand-50 text-brand-700 cursor-pointer hover:bg-brand-100 transition-colors"
          onClick={() => nav('/profile')}>
          <p className="text-xs font-medium opacity-70 mb-1">Credits remaining</p>
          <p className="text-3xl font-bold">{profile?.credits_balance ?? 0}</p>
          <p className="text-xs opacity-60 mt-1">View history →</p>
        </div>
        <div className="rounded-2xl p-5 bg-amber-50 text-amber-700">
          <p className="text-xs font-medium opacity-70 mb-1">Locations tracked</p>
          <p className="text-3xl font-bold">{businesses.length}</p>
          <p className="text-xs opacity-60 mt-1">
            {activeOrganicScans.length + activeAdSessions.length > 0
              ? (activeOrganicScans.length + activeAdSessions.length) + ' scans running'
              : 'All up to date'}
          </p>
        </div>
        <div className="rounded-2xl p-5 bg-green-50 text-green-700 cursor-pointer hover:bg-green-100 transition-colors"
          onClick={() => nav('/profile')}>
          <p className="text-xs font-medium opacity-70 mb-1">Plan</p>
          <p className="text-2xl font-bold capitalize">{profile?.plan ?? 'Starter'}</p>
          <p className="text-xs opacity-60 mt-1">View details →</p>
        </div>
      </div>

      {/* Opportunity score */}
      {opp?.score > 0 && (
        <div className="card flex items-center gap-5">
          <div className="relative w-16 h-16 shrink-0">
            <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" fill="none" stroke="#e5e7eb" strokeWidth="6" />
              <circle cx="32" cy="32" r="26" fill="none"
                stroke={opp.score >= 70 ? '#22c55e' : opp.score >= 40 ? '#f59e0b' : '#ef4444'}
                strokeWidth="6" strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 26}`}
                strokeDashoffset={`${2 * Math.PI * 26 * (1 - opp.score / 100)}`} />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-base font-black text-gray-800">{opp.score}</span>
            </div>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="font-bold text-gray-900">Overall Visibility Score</p>
              <span className={'text-xs font-medium ' + (opp.trend === 'improving' ? 'text-green-600' : opp.trend === 'declining' ? 'text-red-500' : 'text-gray-400')}>
                {opp.trend === 'improving' ? '↗ Improving' : opp.trend === 'declining' ? '↘ Declining' : '→ Stable'}
              </span>
            </div>
            <p className="text-sm text-gray-500">{opp.topAction}</p>
          </div>
        </div>
      )}

      {/* Insights grouped by business */}
      {(grouped.length > 0 || noBizInsights.length > 0) && (
        <div>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">
            What's happening
          </h2>

          {/* Single business or no-biz insights — no group header needed */}
          {grouped.length <= 1 && noBizInsights.length === 0 && grouped[0] && (
            <div className="space-y-3">
              {grouped[0].insights.map(i => (
                <InsightCard key={i.id} insight={i} onNav={nav} />
              ))}
            </div>
          )}

          {/* Multiple businesses — show group headers */}
          {grouped.length > 1 && grouped.map(({ biz, insights }) => (
            <div key={biz.id}>
              <BizGroupHeader biz={biz} />
              <div className="space-y-3 ml-11">
                {insights.map(i => <InsightCard key={i.id} insight={i} onNav={nav} />)}
              </div>
            </div>
          ))}

          {/* No-business insights */}
          {noBizInsights.length > 0 && (
            <div className="space-y-3 mt-3">
              {noBizInsights.map(i => <InsightCard key={i.id} insight={i} onNav={nav} />)}
            </div>
          )}
        </div>
      )}

      {/* Active scans */}
      {(activeOrganicScans.length > 0 || activeAdSessions.length > 0) && (
        <div className="card">
          <h2 className="font-bold mb-3 text-xs text-gray-400 uppercase tracking-wide flex items-center gap-2">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            Scans in progress
          </h2>
          <div className="space-y-3">
            {activeOrganicScans.map((s: any) => {
              const pct = s.total_points > 0 ? Math.round((s.points_completed / s.total_points) * 100) : 0;
              const biz = businesses.find((b: any) => b.id === s.business_id);
              return (
                <div key={s.id} onClick={() => nav('/organic/' + s.id)}
                  className="cursor-pointer hover:bg-gray-50 rounded-xl p-2 transition-colors">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <p className="text-sm font-medium text-gray-800">Analysing "{s.keyword}"</p>
                      {biz && <p className="text-xs text-gray-400">{biz.name}</p>}
                    </div>
                    <span className="text-xs text-gray-400">{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: pct + '%' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* No businesses */}
      {businesses.length === 0 && (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">🏢</div>
          <p className="font-bold mb-2">No businesses added yet</p>
          <p className="text-sm text-gray-400 mb-5">Add your business to start automatic ranking monitoring</p>
          <button onClick={() => nav('/businesses')} className="btn-primary">Get started →</button>
        </div>
      )}

      {/* Quick actions */}
      {businesses.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <div className="card hover:shadow-md transition-all cursor-pointer border-2 hover:border-brand-200"
            onClick={() => nav('/organic/new')}>
            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center text-xl mb-3">🔍</div>
            <h3 className="font-bold mb-1">Ranking Heatmap</h3>
            <p className="text-xs text-gray-500">See exactly where you rank on a real map across your service area</p>
          </div>
          <div className="card hover:shadow-md transition-all cursor-pointer border-2 hover:border-orange-200"
            onClick={() => nav('/ad-insights/new')}>
            <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center text-xl mb-3">📢</div>
            <h3 className="font-bold mb-1">Ad Intelligence</h3>
            <p className="text-xs text-gray-500">Track competitor ad spend on Google Maps throughout the day</p>
          </div>
        </div>
      )}

      {/* Monitoring status */}
      {businesses.length > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-400 px-1">
          <div className="flex items-center gap-2">
            <span className={'w-2 h-2 rounded-full ' + (intelligence?.level?.level > 0 ? 'bg-blue-400 animate-pulse' : 'bg-green-400')} />
            <span>
              {intelligence?.level?.level > 0 ? 'Analysis running in background' : 'Monitoring active — daily checks running'}
            </span>
          </div>
          <span>Next full scan: Monday · Data freshness: {intelligence?.confidence?.score ?? 100}%</span>
        </div>
      )}

    </div>
  );
}
