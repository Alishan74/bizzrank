import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../store/auth';

/**
 * Public page invitees land on. URL: /invite/accept?token=...
 *
 * Flow:
 *   - If not signed in → show "Already have an account? Sign in / Create account"
 *   - If signed in → POST /api/orgs/invitations/accept and redirect to dashboard
 */
export default function InviteAcceptPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const authToken = useAuth(s => s.token);
  const setAuth = useAuth(s => s.setAuth);

  const [mode, setMode] = useState<'choose' | 'signin' | 'signup'>('choose');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // If already signed in, accept the invitation immediately
  useEffect(() => {
    if (!authToken || !token) return;
    accept();
  }, [authToken, token]);

  async function accept() {
    if (!authToken) return;
    setWorking(true); setError(null);
    try {
      const res = await fetch('/api/orgs/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatus('Invitation accepted! Redirecting…');
      setTimeout(() => nav('/overview'), 1200);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }

  async function signupAndAccept() {
    setWorking(true); setError(null);
    try {
      const res = await fetch('/api/auth/accept-invite-signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, fullName, token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Signup failed');
      setAuth({ token: data.token, user: data.user });
      setStatus('Welcome! Redirecting to your dashboard…');
      setTimeout(() => nav('/overview'), 1200);
    } catch (e: any) { setError(e.message); } finally { setWorking(false); }
  }

  async function signInAndAccept() {
    setWorking(true); setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sign in failed');
      setAuth({ token: data.token, user: data.user });
      // useEffect above will trigger accept() once authToken updates
    } catch (e: any) { setError(e.message); setWorking(false); }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-md w-full text-center">
          <h1 className="text-xl font-bold mb-2">Invalid invitation link</h1>
          <p className="text-gray-400 text-sm">The link is missing a token.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="card max-w-md w-full">
        <h1 className="text-2xl font-bold mb-1">You've been invited</h1>
        <p className="text-gray-400 text-sm mb-6">Join the organization to start collaborating.</p>

        {status && (
          <div className="bg-green-50 text-green-800 p-3 rounded mb-4 text-sm">{status}</div>
        )}
        {error && (
          <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm">{error}</div>
        )}

        {authToken ? (
          <div className="text-center text-sm text-gray-500">
            {working ? 'Accepting invitation…' : 'Click below to retry.'}
            {!working && (
              <button onClick={accept} className="btn-primary mt-3 w-full">Accept invitation</button>
            )}
          </div>
        ) : mode === 'choose' ? (
          <div className="space-y-3">
            <button onClick={() => setMode('signup')} className="btn-primary w-full">
              Create a new account
            </button>
            <button onClick={() => setMode('signin')} className="btn-outline w-full">
              I already have an account
            </button>
          </div>
        ) : mode === 'signup' ? (
          <div className="space-y-3">
            <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your name" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (matching invite)" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min 8)" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <button onClick={signupAndAccept} disabled={!email || !password || !fullName || working} className="btn-primary w-full">
              {working ? 'Creating account…' : 'Create account & accept'}
            </button>
            <button onClick={() => setMode('choose')} className="text-xs text-gray-400 hover:underline w-full">Back</button>
          </div>
        ) : (
          <div className="space-y-3">
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            <button onClick={signInAndAccept} disabled={!email || !password || working} className="btn-primary w-full">
              {working ? 'Signing in…' : 'Sign in & accept'}
            </button>
            <button onClick={() => setMode('choose')} className="text-xs text-gray-400 hover:underline w-full">Back</button>
          </div>
        )}
      </div>
    </div>
  );
}
