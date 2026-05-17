import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, profileApi } from '../lib/api';

const PLANS: Record<string, any> = {
  starter: { name: 'Starter', price: '$149/mo', credits: 100, businesses: 1, competitors: 3, color: 'bg-gray-100 text-gray-700' },
  professional: { name: 'Pro', price: '$249/mo', credits: 300, businesses: 5, competitors: 5, color: 'bg-blue-100 text-blue-700' },
  agency: { name: 'Agency', price: '$599/mo', credits: 2000, businesses: 999, competitors: 10, color: 'bg-purple-100 text-purple-700' },
  enterprise: { name: 'Enterprise', price: '$999/mo', credits: 10000, businesses: 999, competitors: 999, color: 'bg-brand-100 text-brand-700' },
};

export default function ProfilePage() {
  const qc = useQueryClient();
  const { data: me, refetch } = useQuery({ queryKey: ['me'], queryFn: () => authApi.me().then(r => r.data) });
  const { data: creditHistory } = useQuery({ queryKey: ['credit-history'], queryFn: () => profileApi.credits().then(r => r.data) });

  const [tab, setTab] = useState<'details' | 'password' | 'subscription' | 'credits'>('details');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [detailMsg, setDetailMsg] = useState('');
  const [detailErr, setDetailErr] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  useEffect(() => {
    if (me) {
      setFullName(me.full_name ?? '');
      setCompanyName(me.company_name ?? '');
    }
  }, [me]);

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavingDetails(true);
    setDetailErr('');
    setDetailMsg('');
    try {
      await profileApi.updateDetails({ fullName, companyName });
      setDetailMsg('Details updated successfully');
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (ex: any) {
      setDetailErr(ex.response?.data?.error ?? 'Update failed');
    } finally {
      setSavingDetails(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwErr('');
    setPwMsg('');
    if (newPw !== confirmPw) return setPwErr('New passwords do not match');
    if (newPw.length < 8) return setPwErr('New password must be at least 8 characters');
    setSavingPw(true);
    try {
      await profileApi.changePassword({ currentPassword: currentPw, newPassword: newPw });
      setPwMsg('Password changed successfully');
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (ex: any) {
      setPwErr(ex.response?.data?.error ?? 'Password change failed');
    } finally {
      setSavingPw(false);
    }
  }

  const currentPlan = PLANS[me?.plan ?? 'starter'] ?? PLANS.starter;
  const usedCredits = (me?.monthly_allowance ?? 100) - (me?.credits_balance ?? 0);
  const creditPct = Math.min(100, (usedCredits / Math.max(me?.monthly_allowance ?? 100, 1)) * 100);
  const transactions: any[] = creditHistory?.transactions ?? [];

  const TABS = [
    { id: 'details', label: 'Account Details' },
    { id: 'password', label: 'Password' },
    { id: 'subscription', label: 'Subscription' },
    { id: 'credits', label: 'Credit History' },
  ] as const;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-gray-400 text-sm">Manage your account, subscription and credits</p>
      </div>

      <div className="flex border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={'px-4 py-3 text-sm font-medium transition-colors ' + (tab === t.id ? 'border-b-2 border-brand-500 text-brand-700' : 'text-gray-500 hover:text-gray-700')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Account Information</h2>
          <div>
            <label className="label">Email address</label>
            <div className="flex items-center gap-3">
              <input type="email" className="input bg-gray-50 cursor-not-allowed" value={me?.email ?? ''} readOnly />
              <span className="badge-green whitespace-nowrap">Verified</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">Email cannot be changed. Contact support if needed.</p>
          </div>
          <form onSubmit={saveDetails} className="space-y-4">
            <div>
              <label className="label">Full name</label>
              <input type="text" className="input" value={fullName} onChange={e => setFullName(e.target.value)} />
            </div>
            <div>
              <label className="label">Company name</label>
              <input type="text" className="input" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Optional" />
            </div>
            {detailMsg && <p className="text-sm text-green-600 bg-green-50 p-2.5 rounded-xl">{detailMsg}</p>}
            {detailErr && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{detailErr}</p>}
            <button type="submit" className="btn-primary" disabled={savingDetails}>
              {savingDetails ? 'Saving...' : 'Save changes'}
            </button>
          </form>
          <div className="border-t border-gray-100 pt-4 space-y-2 text-sm text-gray-500">
            <div className="flex justify-between">
              <span>Account created</span>
              <span className="font-medium text-gray-700">{me?.created_at ? new Date(me.created_at).toLocaleDateString() : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Account ID</span>
              <span className="font-mono text-xs text-gray-400">{me?.id?.slice(0, 8)}...</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'password' && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Change Password</h2>
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-700">
            Your password must be at least 8 characters long.
          </div>
          <form onSubmit={changePassword} className="space-y-4">
            <div>
              <label className="label">Current password</label>
              <input type="password" className="input" value={currentPw} onChange={e => setCurrentPw(e.target.value)} required />
            </div>
            <div>
              <label className="label">New password</label>
              <input type="password" className="input" value={newPw} onChange={e => setNewPw(e.target.value)} required minLength={8} />
            </div>
            <div>
              <label className="label">Confirm new password</label>
              <input type="password" className="input" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required minLength={8} />
              {confirmPw && newPw !== confirmPw && <p className="text-xs text-red-500 mt-1">Passwords do not match</p>}
            </div>
            {pwMsg && <p className="text-sm text-green-600 bg-green-50 p-2.5 rounded-xl">{pwMsg}</p>}
            {pwErr && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{pwErr}</p>}
            <button type="submit" className="btn-primary" disabled={savingPw || (!!confirmPw && newPw !== confirmPw)}>
              {savingPw ? 'Changing...' : 'Change password'}
            </button>
          </form>
        </div>
      )}

      {tab === 'subscription' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="font-bold text-gray-700">Current Plan</h2>
                  <span className={'badge ' + currentPlan.color}>{currentPlan.name}</span>
                </div>
                <p className="text-2xl font-black text-gray-900">{currentPlan.price}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400">Renews monthly</p>
                <p className="text-xs text-green-600 font-semibold mt-1">Active</p>
              </div>
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-sm mb-1.5">
                <span className="text-gray-600">Monthly credits</span>
                <span className="font-semibold">{usedCredits} / {me?.monthly_allowance ?? 100} used</span>
              </div>
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={'h-full rounded-full transition-all ' + (creditPct >= 80 ? 'bg-red-500' : creditPct >= 50 ? 'bg-amber-500' : 'bg-brand-500')}
                  style={{ width: creditPct + '%' }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>{me?.credits_balance ?? 0} remaining</span>
                <span>Resets monthly</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Credits/month', currentPlan.credits.toLocaleString()],
                ['Businesses', currentPlan.businesses === 999 ? 'Unlimited' : currentPlan.businesses],
                ['Competitors/biz', currentPlan.competitors === 999 ? 'Unlimited' : currentPlan.competitors],
                ['Price', currentPlan.price],
              ].map(([label, val]) => (
                <div key={label} className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className="font-bold text-gray-800">{val}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="card border-2 border-brand-100">
            <h3 className="font-bold mb-1">Need more credits?</h3>
            <p className="text-sm text-gray-500 mb-3">Buy additional credits anytime. They never expire.</p>
            <div className="grid grid-cols-3 gap-3 mb-3">
              {[['50 credits', '$50'], ['200 credits', '$200'], ['500 credits', '$500']].map(([label, price]) => (
                <div key={label} className="border-2 border-gray-100 rounded-xl p-3 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition-colors">
                  <p className="text-sm font-bold">{label}</p>
                  <p className="text-xs text-gray-400">{price}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400">$1 per credit · Billing via Stripe</p>
          </div>

          <div className="card">
            <h3 className="font-bold mb-3">Upgrade Plan</h3>
            <div className="space-y-3">
              {Object.entries(PLANS).filter(([k]) => k !== (me?.plan ?? 'starter')).map(([key, plan]) => (
                <div key={key} className="flex items-center justify-between p-3 border border-gray-100 rounded-xl hover:border-brand-200 hover:bg-brand-50 transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <span className={'badge ' + plan.color}>{plan.name}</span>
                    <div>
                      <p className="text-sm font-semibold">{plan.price}</p>
                      <p className="text-xs text-gray-400">{plan.credits.toLocaleString()} credits · {plan.businesses === 999 ? 'Unlimited' : plan.businesses} businesses</p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-brand-600">Upgrade →</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-3">Contact support to change your plan: support@bizzrank.ai</p>
          </div>
        </div>
      )}

      {tab === 'credits' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-brand-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-brand-600">{me?.credits_balance ?? 0}</p>
              <p className="text-xs text-brand-400 mt-1">Current balance</p>
            </div>
            <div className="bg-green-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-green-600">{me?.monthly_allowance ?? 100}</p>
              <p className="text-xs text-green-400 mt-1">Monthly allowance</p>
            </div>
            <div className="bg-amber-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-amber-600">{usedCredits}</p>
              <p className="text-xs text-amber-400 mt-1">Used this month</p>
            </div>
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
              <h3 className="font-bold text-gray-700 text-sm">Transaction History</h3>
            </div>
            {transactions.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No transactions yet</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {transactions.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={'w-8 h-8 rounded-xl flex items-center justify-center text-sm ' + (t.amount > 0 ? 'bg-green-100' : 'bg-red-100')}>
                        {t.amount > 0 ? '+' : '−'}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-800">{t.reason}</p>
                        <p className="text-xs text-gray-400">{new Date(t.created_at).toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={'text-sm font-bold ' + (t.amount > 0 ? 'text-green-600' : 'text-red-500')}>
                        {t.amount > 0 ? '+' : ''}{t.amount}
                      </p>
                      <p className="text-xs text-gray-400">{t.balance_after} left</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
