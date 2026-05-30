import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/auth';
import { LoginPage, SignupPage } from './pages/Auth';
import Layout from './components/Layout';
import { lazy, Suspense } from 'react';

// Lazy-load pages that are not always needed
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPassword'));
const ResetPasswordPage  = lazy(() => import('./pages/ResetPassword'));
const OnboardingPage     = lazy(() => import('./pages/Onboarding'));

function Protected({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuth(s => s.isLoggedIn());
  return isLoggedIn ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  const isLoggedIn = useAuth(s => s.isLoggedIn());
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" /></div>}>
      <Routes>
        <Route path="/login"          element={isLoggedIn ? <Navigate to="/overview" replace /> : <LoginPage />} />
        <Route path="/signup"         element={isLoggedIn ? <Navigate to="/overview" replace /> : <SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password"  element={<ResetPasswordPage />} />
        <Route path="/onboarding"      element={<Protected><OnboardingPage /></Protected>} />
        <Route path="/*"               element={<Protected><Layout /></Protected>} />
      </Routes>
    </Suspense>
  );
}
