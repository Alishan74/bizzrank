import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import { authApi } from '../lib/api';

import OverviewPage        from '../pages/Overview';
import OrganicPage         from '../pages/OrganicVisibility';
import NewOrganicScanPage  from '../pages/NewOrganicScan';
import OrganicScanDetailPage from '../pages/OrganicScanDetail';
import AdInsightsPage      from '../pages/AdInsights';
import NewAdScanPage       from '../pages/NewAdScan';
import AdSessionDetailPage from '../pages/AdSessionDetail';
import ReviewsPage         from '../pages/Reviews';
import LeaderboardPage     from '../pages/Leaderboard';
import CitationsPage       from '../pages/Citations';
import BusinessesPage      from '../pages/Businesses';
import TeamPage            from '../pages/Team';
import ProfilePage         from '../pages/Profile';
import AIVisibilityPage    from '../pages/AIVisibility';
import CustomScanPage      from '../pages/CustomScan';
import GBPGuardPage        from '../pages/GBPGuard';
import AgencyDashboard     from '../pages/AgencyDashboard';

const NAV = [
  { path: '/overview',   icon: '▦',  label: 'Overview' },
  { path: '/agency',     icon: '🏢', label: 'Agency Dashboard' },
  { path: '/ai-visibility',icon: '🤖', label: 'AI Visibility' },
  { path: '/organic',    icon: '🔍', label: 'Organic Visibility' },
  { path: '/ad-insights',icon: '📢', label: 'Ad Insights & Pressure' },
  { path: '/reviews',    icon: '⭐', label: 'Reviews' },
  { path: '/leaderboard',icon: '🏆', label: 'Leaderboard' },
  { path: '/citations',  icon: '📋', label: 'Citation Audit' },
  { path: '/gbp-guard',   icon: '🛡️', label: 'GBP Guard' },
  { path: '/businesses', icon: '🏢', label: 'Businesses' },
  { path: '/team',       icon: '👥', label: 'Team' },
  { path: '/profile',    icon: '👤', label: 'Profile' },
  { path: '/custom-scan', icon: '🗺️', label: 'Custom Scan' },
];

// ── Notification bell ─────────────────────────────────────────
function NotificationBell({ data }: { data: any }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref  = useRef<HTMLDivElement>(null);

  // Build notification list from live dashboard data
  const notes: { id: string; icon: string; msg: string; path: string; color: string }[] = [];

  (data?.activeOrganicScans ?? []).forEach((s: any) => {
    const pct = s.total_points > 0 ? Math.round((s.points_completed / s.total_points) * 100) : 0;
    notes.push({
      id: 'scan-' + s.id, icon: '🔍', color: 'text-blue-600',
      msg: `Scan "${s.keyword}" running — ${pct}%`,
      path: '/organic/' + s.id,
    });
  });

  (data?.activeAdSessions ?? []).forEach((s: any) => {
    notes.push({
      id: 'ad-' + s.id, icon: '📢', color: 'text-orange-600',
      msg: `Ad session "${s.keyword}" running`,
      path: '/ad-insights/' + s.id,
    });
  });

  const intel = data?.intelligence;
  if (intel?.confidence?.changesDetected) {
    notes.push({
      id: 'intel-change', icon: '⚡', color: 'text-amber-600',
      msg: 'Ranking changes detected — fresh analysis running',
      path: '/overview',
    });
  }

  if (intel?.opportunity?.score >= 80) {
    notes.push({
      id: 'opp-high', icon: '🎯', color: 'text-green-600',
      msg: `Opportunity Score ${intel.opportunity.score} — ${intel.opportunity.topAction}`,
      path: '/overview',
    });
  }

  const unread = notes.length;

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="relative w-9 h-9 flex items-center justify-center rounded-xl hover:bg-gray-100 transition-colors"
        title="Notifications"
      >
        <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-80 bg-white border border-gray-200 rounded-2xl shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Notifications</span>
            {unread > 0 && <span className="text-xs text-gray-400">{unread} active</span>}
          </div>
          {notes.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              <div className="text-3xl mb-2">🔔</div>
              All clear — no active events
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
              {notes.map(n => (
                <button
                  key={n.id}
                  onClick={() => { nav(n.path); setOpen(false); }}
                  className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left transition-colors"
                >
                  <span className="text-lg shrink-0 mt-0.5">{n.icon}</span>
                  <p className={'text-xs text-gray-700 leading-relaxed ' + n.color.replace('text','font')}>
                    {n.msg}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Profile dropdown ──────────────────────────────────────────
function ProfileDropdown({ me }: { me: any }) {
  const nav    = useNavigate();
  const logout = useAuth(s => s.logout);
  const [open, setOpen] = useState(false);
  const ref    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const initials = me?.full_name
    ? me.full_name.split(' ').map((w: string) => w[0]).join('').slice(0,2).toUpperCase()
    : (me?.email?.[0] ?? '?').toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-gray-100 transition-colors"
        title="Profile"
      >
        <div className="w-7 h-7 bg-brand-500 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">
          {initials}
        </div>
        <div className="text-left hidden sm:block">
          <p className="text-xs font-semibold text-gray-800 leading-tight max-w-[100px] truncate">
            {me?.full_name ?? 'Account'}
          </p>
          <p className="text-[10px] text-gray-400 capitalize leading-tight">{me?.plan ?? 'starter'}</p>
        </div>
        <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-56 bg-white border border-gray-200 rounded-2xl shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-800 truncate">{me?.full_name ?? 'Account'}</p>
            <p className="text-xs text-gray-400 truncate">{me?.email}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="badge badge-blue capitalize">{me?.plan ?? 'starter'}</span>
              <span className="text-xs text-gray-500">💳 {me?.credits_balance ?? 0} credits</span>
            </div>
          </div>
          <div className="py-1">
            {[
              { icon: '👤', label: 'Profile & Billing', path: '/profile' },
              { icon: '🏢', label: 'Businesses',        path: '/businesses' },
              { icon: '👥', label: 'Team',              path: '/team' },
            ].map(item => (
              <button
                key={item.path}
                onClick={() => { nav(item.path); setOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-gray-100 py-1">
            <button
              onClick={() => { logout(); setOpen(false); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors text-left"
            >
              <span>🚪</span>
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Monitoring status badge — customer-friendly ──────────────
function MonitoringBadge({ intel }: { intel: any }) {
  const nav = useNavigate();
  if (!intel?.level) return (
    <button onClick={() => nav('/overview')}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Monitoring active
    </button>
  );
  const lv = intel.level.level ?? 0;
  const conf = intel.confidence?.score ?? 100;
  const changesDetected = intel.confidence?.changesDetected ?? false;

  if (changesDetected) return (
    <button onClick={() => nav('/overview')}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700"
      title="Changes detected in your rankings">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      Changes detected
    </button>
  );
  if (lv >= 2) return (
    <button onClick={() => nav('/overview')}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700"
      title="Analysis running">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
      Analysing rankings
    </button>
  );
  return (
    <button onClick={() => nav('/overview')}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Monitoring active
    </button>
  );
}

// ── Main Layout ───────────────────────────────────────────────
export default function Layout() {
  const location = useLocation();
  const nav      = useNavigate();
  const qc       = useQueryClient();

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn:  () => authApi.me().then(r => r.data),
    retry: false,
  });

  const { data: dashData } = useQuery({
    queryKey: ['dashboard'],
    queryFn:  () => import('../lib/api').then(m => m.dashboardApi.get()).then(r => r.data),
    refetchInterval: 60000,
    retry: false,
    staleTime: 30000,
  });

  const PAGE_TITLE: Record<string, string> = {
    '/overview':    'Overview',
    '/organic':     'Organic Visibility',
    '/ad-insights': 'Ad Insights & Pressure',
    '/reviews':     'Reviews',
    '/leaderboard': 'Leaderboard',
    '/citations':   'Citation Audit',
    '/businesses':  'Businesses',
    '/team':        'Team',
    '/profile':     'Profile',
    '/custom-scan':  'Custom Scan',
    '/gbp-guard':    'GBP Guard',
  };

  const currentTitle = Object.entries(PAGE_TITLE)
    .find(([p]) => location.pathname.startsWith(p))?.[1] ?? 'BizzRank AI';

  return (
    <div className="flex h-screen bg-gray-50">
      {/* ── Sidebar ── */}
      <aside className="w-64 bg-white border-r border-gray-100 flex flex-col shrink-0">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2.5">
          <div className="w-8 h-8 bg-brand-500 rounded-xl flex items-center justify-center shadow-sm">
            <span className="text-white text-sm font-bold">B</span>
          </div>
          <span className="font-bold text-gray-900">BizzRank AI</span>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map(({ path, icon, label }) => {
            const isActive = location.pathname.startsWith(path);
            return (
              <button key={path} onClick={() => nav(path)} className={isActive ? 'nav-active' : 'nav-inactive'}>
                <span className="text-base shrink-0">{icon}</span>
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-100 space-y-2">
          <div className="flex items-center justify-between">
            <span className="badge badge-blue capitalize">{me?.plan ?? 'starter'}</span>
            <span className="text-xs font-bold text-gray-700">💳 {me?.credits_balance ?? 0}</span>
          </div>
          <p className="text-xs text-gray-400 truncate">{me?.email}</p>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ── Top bar ── */}
        <header className="h-14 bg-white border-b border-gray-100 flex items-center px-6 gap-4 shrink-0">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-gray-900 truncate">{currentTitle}</h1>
          </div>

          {/* Intel level indicator */}
          <MonitoringBadge intel={dashData?.intelligence} />

          {/* Notification bell */}
          <NotificationBell data={dashData} />

          {/* Profile dropdown */}
          <ProfileDropdown me={me} />
        </header>

        {/* ── Page content ── */}
        <main className="flex-1 overflow-auto">
          <div className="max-w-5xl mx-auto px-8 py-8">
            <Routes>
              <Route path="/overview"               element={<OverviewPage />} />
              <Route path="/organic"                element={<OrganicPage />} />
              <Route path="/organic/new"            element={<NewOrganicScanPage />} />
              <Route path="/organic/:scanId"        element={<OrganicScanDetailPage />} />
              <Route path="/ad-insights"            element={<AdInsightsPage />} />
              <Route path="/ad-insights/new"        element={<NewAdScanPage />} />
              <Route path="/ad-insights/:sessionId" element={<AdSessionDetailPage />} />
              <Route path="/reviews"                element={<ReviewsPage />} />
              <Route path="/leaderboard"            element={<LeaderboardPage />} />
              <Route path="/citations"              element={<CitationsPage />} />
              <Route path="/businesses"             element={<BusinessesPage />} />
              <Route path="/team"                   element={<TeamPage />} />
              <Route path="/profile"               element={<ProfilePage />} />
              <Route path="/ai-visibility"          element={<AIVisibilityPage />} />
              <Route path="/custom-scan"          element={<CustomScanPage />} />
              <Route path="/gbp-guard"            element={<GBPGuardPage />} />
              <Route path="/agency"              element={<AgencyDashboard />} />
              <Route path="*"                       element={<Navigate to="/overview" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}
