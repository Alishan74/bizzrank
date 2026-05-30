import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import { authApi, profileApi, billingApi } from '../lib/api';
const PLANS: Record<string, any> = {
  starter:      { name:'Starter',     price:'$49/mo',  credits:900,   businesses:1,  keywords:1, competitors:1, color:'bg-gray-100 text-gray-700'    },
  growth:       { name:'Growth',      price:'$119/mo', credits:1600,  businesses:1,  keywords:2, competitors:2, color:'bg-green-100 text-green-700'  },
  pro:          { name:'Pro',         price:'$199/mo', credits:1800,  businesses:2,  keywords:3, competitors:3, color:'bg-blue-100 text-blue-700'    },
  agency:       { name:'Agency',      price:'$499/mo', credits:3500,  businesses:5,  keywords:4, competitors:4, color:'bg-purple-100 text-purple-700' },
  enterprise:   { name:'Enterprise',  price:'Custom',  credits:99999, businesses:999,keywords:999,competitors:999,color:'bg-brand-100 text-brand-700' },
  professional: { name:'Pro',         price:'$199/mo', credits:1800,  businesses:5,  keywords:3, competitors:5, color:'bg-blue-100 text-blue-700'    },
};

// Plan features — what each plan includes
const PLAN_FEATURES: Record<string, string[]> = {
  starter:    ['AI review replies', 'Weekly automated scans', 'Daily change detection', 'Ad pressure scanning', 'Real Google Maps heatmap'],
  growth:     ['Everything in Starter', 'Auto-post GBP replies', 'Citation audit (2×/mo)', 'White-label reports', 'Ad pressure hourly sessions'],
  pro:        ['Everything in Growth', '2 locations', 'Team members (5)', 'Citation audit (2×/mo)'],
  agency:     ['Everything in Pro', '5 locations', 'Unlimited team members', 'Citation audit (4×/mo)', 'White-label client reports'],
  enterprise: ['Everything in Agency', 'Custom locations', 'Unlimited keywords', 'Dedicated support', 'Custom SLA'],
  professional:['Everything in Growth', '5 locations', 'Team members'],
};

export default function ProfilePage() {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => authApi.me().then(r => r.data) });
  const { data: creditHistory } = useQuery({ queryKey: ['credit-history'], queryFn: () => profileApi.credits().then(r => r.data) });

  const [tab, setTab] = useState<'details'|'password'|'subscription'|'credits'>('details');
  const [fullName, setFullName]       = useState('');
  const [companyName, setCompanyName] = useState('');
  const [currentPw, setCurrentPw]     = useState('');
  const [newPw, setNewPw]             = useState('');
  const [confirmPw, setConfirmPw]     = useState('');
  const [detailMsg, setDetailMsg]     = useState('');
  const [detailErr, setDetailErr]     = useState('');
  const [pwMsg, setPwMsg]             = useState('');
  const [pwErr, setPwErr]             = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [savingPw, setSavingPw]           = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePw, setDeletePw]               = useState('');
  const [deleting, setDeleting]               = useState(false);
  const logout = useAuth(st => st.logout);

  useEffect(() => {
    if (me) { setFullName(me.full_name ?? ''); setCompanyName(me.company_name ?? ''); }
  }, [me]);

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavingDetails(true); setDetailErr(''); setDetailMsg('');
    try {
      await profileApi.updateDetails({ fullName, companyName });
      setDetailMsg('Details updated successfully');
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (ex: any) {
      setDetailErr(ex.response?.data?.error ?? 'Update failed');
    } finally { setSavingDetails(false); }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwErr(''); setPwMsg('');
    if (newPw !== confirmPw) return setPwErr('New passwords do not match');
    if (newPw.length < 8)   return setPwErr('New password must be at least 8 characters');
    setSavingPw(true);
    try {
      await profileApi.changePassword({ currentPassword: currentPw, newPassword: newPw });
      setPwMsg('Password changed successfully');
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (ex: any) {
      setPwErr(ex.response?.data?.error ?? 'Password change failed');
    } finally { setSavingPw(false); }
  }

  const planKey      = me?.plan ?? 'starter';
  const currentPlan  = PLANS[planKey] ?? PLANS.starter;
  const planFeatures = PLAN_FEATURES[planKey] ?? PLAN_FEATURES.starter;

  // Credits — use actual values from API, not computed from monthly_allowance
  const creditsBalance   = me?.credits_balance   ?? 0;
  const monthlyAllowance = me?.monthly_allowance ?? currentPlan.credits;
  const usedCredits      = Math.max(0, monthlyAllowance - creditsBalance);
  const creditPct        = Math.min(100, (usedCredits / Math.max(monthlyAllowance, 1)) * 100);
  const transactions: any[] = creditHistory?.transactions ?? [];

  const TABS = [
    { id: 'details',      label: 'Account Details' },
    { id: 'password',     label: 'Password' },
    { id: 'subscription', label: 'Subscription' },
    { id: 'credits',      label: 'Credit History' },
  ] as const;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-gray-400 text-sm">Manage your account, subscription and credits</p>
      </div>

      <div className="flex border-b border-gray-200">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={'px-4 py-3 text-sm font-medium transition-colors ' + (tab === t.id ? 'border-b-2 border-brand-500 text-brand-700' : 'text-gray-500 hover:text-gray-700')}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Account Details ── */}
      {tab === 'details' && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Account Information</h2>
          <div>
            <label className="label">Email address</label>
            <div className="flex items-center gap-3">
              <input type="email" className="input bg-gray-50 cursor-not-allowed" value={me?.email ?? ''} readOnly />
              <span className="badge-green whitespace-nowrap">Verified</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">Email cannot be changed.</p>
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
              <span className="font-mono text-xs text-gray-400">{me?.id?.slice(0,8)}...</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Password ── */}
      {tab === 'password' && (
        <div className="card space-y-5">
          <h2 className="font-bold text-gray-700">Change Password</h2>
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-700">
            Password must be at least 8 characters.
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

      {/* ── Subscription ── */}
      {tab === 'subscription' && (
        <div className="space-y-4">

          {/* Current plan card */}
          <div className="card">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="font-bold text-gray-700">Current Plan</h2>
                  <span className={'badge ' + currentPlan.color}>{currentPlan.name}</span>
                </div>
                <p className="text-3xl font-black text-gray-900">{currentPlan.price}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400">Renews monthly</p>
                <p className="text-xs text-green-600 font-semibold mt-1">Active</p>
              </div>
            </div>

            {/* Credit usage bar */}
            <div className="mb-5">
              <div className="flex justify-between text-sm mb-1.5">
                <span className="text-gray-600">Manual scan credits</span>
                <span className="font-semibold">{creditsBalance.toLocaleString()} remaining</span>
              </div>
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={'h-full rounded-full transition-all ' + (creditPct >= 80 ? 'bg-red-500' : creditPct >= 50 ? 'bg-amber-500' : 'bg-brand-500')}
                  style={{ width: creditPct + '%' }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>{usedCredits.toLocaleString()} used this month</span>
                <span>Credits never expire · roll over monthly</span>
              </div>
            </div>

            {/* Plan stats */}
            <div className="grid grid-cols-2 gap-3 text-sm mb-5">
              {[
                ['Monthly credits',   currentPlan.credits === 99999 ? 'Unlimited' : currentPlan.credits.toLocaleString()],
                ['Locations',         currentPlan.businesses === 999 ? 'Unlimited' : currentPlan.businesses],
                ['Keywords / location', currentPlan.keywords === 999 ? 'Unlimited' : currentPlan.keywords],
                ['Competitors / location', currentPlan.competitors === 999 ? 'Unlimited' : currentPlan.competitors],
              ].map(([label, val]) => (
                <div key={label as string} className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className="font-bold text-gray-800">{val}</p>
                </div>
              ))}
            </div>

            {/* Plan features */}
            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Included in your plan</p>
              <div className="space-y-1.5">
                {planFeatures.map(f => (
                  <div key={f} className="flex items-center gap-2 text-sm text-gray-600">
                    <span className="text-green-500 font-bold">✓</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Available plans */}
          <div className="card">
            <h3 className="font-bold mb-1">Available Plans</h3>
            <p className="text-sm text-gray-400 mb-4">Choose a plan below to upgrade instantly.</p>
            <div className="space-y-3">
              {Object.entries(PLANS)
                .filter(([k]) => !['professional'].includes(k))
                .map(([key, plan]) => {
                  const isCurrent = key === planKey;
                  return (
                    <div key={key}
                      className={'flex items-center justify-between p-4 border-2 rounded-xl transition-colors ' + (isCurrent ? 'border-brand-400 bg-brand-50' : 'border-gray-100 hover:border-brand-200 hover:bg-brand-50 cursor-pointer')}>
                      <div className="flex items-center gap-3">
                        <span className={'badge ' + plan.color}>{plan.name}</span>
                        <div>
                          <p className="text-sm font-semibold">{plan.price}</p>
                          <p className="text-xs text-gray-400">
                            {plan.credits === 99999 ? 'Unlimited' : plan.credits.toLocaleString()} credits
                            {' · '}
                            {plan.businesses === 999 ? 'Unlimited' : plan.businesses} {plan.businesses === 1 ? 'location' : 'locations'}
                            {' · '}
                            {plan.keywords === 999 ? 'Unlimited' : plan.keywords} {plan.keywords === 1 ? 'keyword' : 'keywords'}
                          </p>
                        </div>
                      </div>
                      {isCurrent
                        ? <div className="flex gap-2 items-center"><span className="text-xs font-semibold text-brand-600 bg-brand-100 px-2 py-1 rounded-full">Current</span>{planKey !== 'starter' && <button onClick={async () => { try { const r = await billingApi.portal(); window.location.href = r.data.url; } catch(e:any){alert('Billing portal failed');} }} className="text-xs text-gray-500 hover:underline">Manage billing</button>}</div>
                        : <button onClick={async () => { try { const r = await billingApi.checkout(key); window.location.href = r.data.url; } catch(e:any) { alert(e.response?.data?.error ?? 'Failed to start checkout'); } }} className="text-xs font-semibold text-brand-600 hover:underline">Upgrade →</button>
                      }
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {/* ── Credit History ── */}
      {tab === 'credits' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-brand-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-brand-600">{creditsBalance.toLocaleString()}</p>
              <p className="text-xs text-brand-400 mt-1">Current balance</p>
            </div>
            <div className="bg-green-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-green-600">{monthlyAllowance.toLocaleString()}</p>
              <p className="text-xs text-green-400 mt-1">Monthly allowance</p>
            </div>
            <div className="bg-amber-50 rounded-2xl p-4 text-center">
              <p className="text-2xl font-black text-amber-600">{usedCredits.toLocaleString()}</p>
              <p className="text-xs text-amber-400 mt-1">Used this month</p>
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-700">
            <strong>Credits never expire.</strong> Unused credits roll over to next month automatically.
            25 credits = 1 manual scan (25 grid points). Automated weekly scans are free — they don't use credits.
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
                      <div className={'w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold ' + (t.amount > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
                        {t.amount > 0 ? '+' : '−'}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-800">{t.reason}</p>
                        <p className="text-xs text-gray-400">{new Date(t.created_at).toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={'text-sm font-bold ' + (t.amount > 0 ? 'text-green-600' : 'text-red-500')}>
                        {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString()}
                      </p>
                      <p className="text-xs text-gray-400">{t.balance_after.toLocaleString()} left</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* ── Danger Zone (only shown on Account Details tab) ── */}
      {tab === 'details' && (
        <div className="card border border-red-100 mt-2">
          <h3 className="font-bold text-red-700 mb-1 text-sm">Danger Zone</h3>
          <p className="text-xs text-gray-400 mb-3">Permanently delete your account and all associated data. This cannot be undone.</p>
          <button onClick={() => setShowDeleteModal(true)}
            className="text-sm text-red-600 border border-red-200 px-4 py-2 rounded-xl hover:bg-red-50 transition-colors">
            Delete my account
          </button>
        </div>
      )}

      {/* ── Delete Account Modal ── */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div>
              <h3 className="font-bold text-red-700 text-lg mb-1">Delete account permanently?</h3>
              <p className="text-sm text-gray-500">
                This will delete all your businesses, scans, reviews, keywords, competitors, and all data.
                <strong> This cannot be undone.</strong>
              </p>
            </div>
            <div>
              <label className="label text-sm">Confirm your password to proceed</label>
              <input type="password" className="input w-full" value={deletePw}
                onChange={e => setDeletePw(e.target.value)} placeholder="Enter your password" autoFocus />
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setShowDeleteModal(false); setDeletePw(''); }}
                className="flex-1 btn-secondary">Cancel</button>
              <button
                disabled={!deletePw || deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await profileApi.deleteAccount({ password: deletePw });
                    logout();
                    window.location.href = '/login';
                  } catch (ex: any) {
                    alert(ex.response?.data?.error ?? 'Deletion failed');
                    setDeleting(false);
                  }
                }}
                className="flex-1 bg-red-600 text-white rounded-xl py-2 font-semibold hover:bg-red-700 disabled:opacity-50 transition-colors">
                {deleting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
