import { useState } from 'react';
import { authApi } from '../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState('');
  const [sent, setSent]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      await authApi.forgotPassword({ email: email.trim().toLowerCase() });
      setSent(true);
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Something went wrong');
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
          {sent ? (
            <div className="text-center">
              <p className="text-4xl mb-3">📧</p>
              <h2 className="text-lg font-bold mb-2">Check your email</h2>
              <p className="text-sm text-gray-500 mb-4">
                If an account exists for <strong>{email}</strong>, we've sent a password reset link.
              </p>
              <p className="text-xs text-gray-400">Didn't receive it? Check your spam folder.</p>
              <a href="/login" className="block mt-5 text-brand-600 text-sm font-semibold hover:underline">
                Back to sign in
              </a>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h2 className="text-lg font-bold mb-1">Reset your password</h2>
                <p className="text-sm text-gray-500 mb-4">
                  Enter your email and we'll send you a reset link.
                </p>
              </div>
              <div>
                <label className="label">Email address</label>
                <input
                  type="email" className="input w-full" autoFocus required
                  value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={loading || !email}>
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <p className="text-center text-sm text-gray-500">
                <a href="/login" className="text-brand-600 font-semibold hover:underline">
                  Back to sign in
                </a>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
