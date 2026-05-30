import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../lib/api';

export default function ResetPasswordPage() {
  const nav = useNavigate();
  const [token, setToken]       = useState('');
  const [pw, setPw]             = useState('');
  const [confirm, setConfirm]   = useState('');
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState('');
  const [success, setSuccess]   = useState(false);

  useEffect(() => {
    // Supabase puts the access_token in the URL hash after redirect
    const hash   = window.location.hash;
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const t      = params.get('access_token');
    if (t) setToken(t);
    else   setErr('Invalid or expired reset link — please request a new one');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (pw !== confirm) return setErr('Passwords do not match');
    if (pw.length < 8)  return setErr('Password must be at least 8 characters');
    setLoading(true);
    try {
      await authApi.resetPassword({ accessToken: token, newPassword: pw });
      setSuccess(true);
      setTimeout(() => nav('/login'), 2500);
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Reset failed — try requesting a new link');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-brand-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white text-xl font-bold">B</span>
          </div>
          <h1 className="text-2xl font-bold">BizzRank AI</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          {success ? (
            <div className="text-center">
              <p className="text-4xl mb-3">✅</p>
              <h2 className="text-lg font-bold mb-2">Password updated</h2>
              <p className="text-sm text-gray-500">Redirecting to sign in…</p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <h2 className="text-lg font-bold">Set new password</h2>
              {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
              {!token && !err ? (
                <p className="text-sm text-amber-600">Reading reset token…</p>
              ) : (
                <>
                  <div>
                    <label className="label">New password</label>
                    <input type="password" className="input w-full" value={pw}
                      onChange={e => setPw(e.target.value)} minLength={8} required autoFocus />
                  </div>
                  <div>
                    <label className="label">Confirm new password</label>
                    <input type="password" className="input w-full" value={confirm}
                      onChange={e => setConfirm(e.target.value)} minLength={8} required />
                    {confirm && pw !== confirm &&
                      <p className="text-xs text-red-500 mt-1">Passwords do not match</p>}
                  </div>
                  <button type="submit" className="btn-primary w-full py-2.5"
                    disabled={loading || !pw || !confirm || pw !== confirm}>
                    {loading ? 'Saving…' : 'Set new password'}
                  </button>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
