import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import { authApi } from '../lib/api';

import OverviewPage from '../pages/Overview';
import OrganicPage from '../pages/OrganicVisibility';
import NewOrganicScanPage from '../pages/NewOrganicScan';
import OrganicScanDetailPage from '../pages/OrganicScanDetail';
import AdInsightsPage from '../pages/AdInsights';
import NewAdScanPage from '../pages/NewAdScan';
import AdSessionDetailPage from '../pages/AdSessionDetail';
import ReviewsPage from '../pages/Reviews';
import LeaderboardPage from '../pages/Leaderboard';
import CitationsPage from '../pages/Citations';
import BusinessesPage from '../pages/Businesses';
import ProfilePage from '../pages/Profile';

const NAV = [
  { path: '/overview', icon: '▦', label: 'Overview' },
  { path: '/organic', icon: '🔍', label: 'Organic Visibility' },
  { path: '/ad-insights', icon: '📢', label: 'Ad Insights & Pressure' },
  { path: '/reviews', icon: '⭐', label: 'Reviews' },
  { path: '/leaderboard', icon: '🏆', label: 'Leaderboard' },
  { path: '/citations', icon: '📋', label: 'Citation Audit' },
  { path: '/businesses', icon: '🏢', label: 'Businesses' },
  { path: '/profile', icon: '👤', label: 'Profile' },
];

export default function Layout() {
  const logout = useAuth(s => s.logout);
  const location = useLocation();
  const nav = useNavigate();
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then(r => r.data),
    retry: false,
  });

  return (
    <div className="flex h-screen bg-gray-50">
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
              <button
                key={path}
                onClick={() => nav(path)}
                className={isActive ? 'nav-active' : 'nav-inactive'}
              >
                <span className="text-base shrink-0">{icon}</span>
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-100">
          <p className="text-xs text-gray-500 truncate mb-1">{me?.email}</p>
          <div className="flex items-center justify-between mb-2">
            <span className="badge-blue capitalize">{me?.plan ?? 'starter'}</span>
            <span className="text-xs font-bold text-gray-700">💳 {me?.credits_balance ?? 0}</span>
          </div>
          <button onClick={logout} className="text-xs text-gray-400 hover:text-gray-600">
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-8 py-8">
          <Routes>
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/organic" element={<OrganicPage />} />
            <Route path="/organic/new" element={<NewOrganicScanPage />} />
            <Route path="/organic/:scanId" element={<OrganicScanDetailPage />} />
            <Route path="/ad-insights" element={<AdInsightsPage />} />
            <Route path="/ad-insights/new" element={<NewAdScanPage />} />
            <Route path="/ad-insights/:sessionId" element={<AdSessionDetailPage />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/citations" element={<CitationsPage />} />
            <Route path="/businesses" element={<BusinessesPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
