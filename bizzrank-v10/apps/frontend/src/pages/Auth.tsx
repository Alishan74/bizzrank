import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { authApi } from '../lib/api';

function AuthShell({ sub, children }: { sub: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-50 to-indigo-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-brand-500 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg">
            <span className="text-white text-2xl font-bold">B</span>
          </div>
          <h1 className="text-2xl font-bold">BizzRank AI</h1>
          <p className="text-gray-500 text-sm">{sub}</p>
        </div>
        <div className="card shadow-xl">{children}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuth();
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const r = await authApi.login({ email, password: pw });
      setAuth(r.data.token, r.data.user);
      nav('/overview');
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell sub="Geo visibility intelligence">
      <h2 className="text-lg font-bold mb-5">Sign in</h2>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Email</label>
          <input type="email" className="input" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="label">Password</label>
          <input type="password" className="input" value={pw} onChange={e => setPw(e.target.value)} required />
        </div>
        {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
        <button type="submit" className="btn-primary w-full py-2.5" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      <p className="text-center text-sm text-gray-500 mt-4">
        No account?{' '}
        <a href="/signup" className="text-brand-600 font-semibold hover:underline">Sign up</a>
      </p>
    </AuthShell>
  );
}

export function SignupPage() {
  const [form, setForm] = useState({ email: '', password: '', fullName: '', companyName: '' });
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuth();
  const nav = useNavigate();

  function setField(k: string) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const r = await authApi.signup(form);
      setAuth(r.data.token, r.data.user);
      nav('/overview');
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell sub="Start tracking your visibility">
      <h2 className="text-lg font-bold mb-5">Create account</h2>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Full name</label>
          <input type="text" className="input" value={form.fullName} onChange={setField('fullName')} required />
        </div>
        <div>
          <label className="label">Company (optional)</label>
          <input type="text" className="input" value={form.companyName} onChange={setField('companyName')} />
        </div>
        <div>
          <label className="label">Email</label>
          <input type="email" className="input" value={form.email} onChange={setField('email')} required />
        </div>
        <div>
          <label className="label">
            Password <span className="text-gray-400 font-normal text-xs">(min 8 characters)</span>
          </label>
          <input type="password" className="input" value={form.password} onChange={setField('password')} required minLength={8} />
        </div>
        {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
        <button type="submit" className="btn-primary w-full py-2.5" disabled={loading}>
          {loading ? 'Creating...' : 'Create account'}
        </button>
      </form>
      <p className="text-center text-sm text-gray-500 mt-4">
        Have an account?{' '}
        <a href="/login" className="text-brand-600 font-semibold hover:underline">Sign in</a>
      </p>
    </AuthShell>
  );
}
