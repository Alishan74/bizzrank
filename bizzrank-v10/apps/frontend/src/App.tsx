import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/auth';
import { LoginPage, SignupPage } from './pages/Auth';
import Layout from './components/Layout';

function Protected({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuth(s => s.isLoggedIn());
  return isLoggedIn ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  const isLoggedIn = useAuth(s => s.isLoggedIn());
  return (
    <Routes>
      <Route path="/login" element={isLoggedIn ? <Navigate to="/overview" replace /> : <LoginPage />} />
      <Route path="/signup" element={isLoggedIn ? <Navigate to="/overview" replace /> : <SignupPage />} />
      <Route path="/*" element={<Protected><Layout /></Protected>} />
    </Routes>
  );
}
