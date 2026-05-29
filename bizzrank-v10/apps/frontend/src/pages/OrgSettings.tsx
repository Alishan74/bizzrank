import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth';
import MembersList from '../components/OrgManagement/MembersList';
import BusinessAssignment from '../components/OrgManagement/BusinessAssignment';

const ROLE_LABELS: Record<string, string> = {
  manager: 'Manager — can run scans on assigned businesses',
  viewer: 'Viewer — read-only on assigned businesses',
  billing_admin: 'Billing Admin — sees billing + all businesses, no edits',
};

interface Member {
  id: string;
  user_id: string;
  role: string;
  monthly_credit_budget: number;
  credits_used_this_month: number;
  created_at: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  token: string;
  expires_at: string;
  created_at: string;
}

async function api(path: string, token: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export default function OrgSettingsPage() {
  const token = useAuth(s => s.token) ?? '';
  const qc = useQueryClient();
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('manager');
  const [inviteErr, setInviteErr] = useState('');
  const [showCopiedLink, setShowCopiedLink] = useState<string | null>(null);

  const { data: orgData, isLoading: orgLoading } = useQuery({
    queryKey: ['org'],
    queryFn: () => api('/api/orgs', token),
  });
  const { data: invitesData } = useQuery({
    queryKey: ['org-invitations'],
    queryFn: () => api('/api/orgs/invitations', token),
    enabled: orgData?.yourRole === 'owner',
  });
  const { data: businesses } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => api('/api/businesses', token).then(d => d.businesses ?? []),
  });

  const inviteMut = useMutation({
    mutationFn: () => api('/api/orgs/invitations', token, {
      method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    }),
    onSuccess: (res) => {
      setInviteEmail('');
      setInviteErr('');
      setShowCopiedLink(res.acceptUrl);
      qc.invalidateQueries({ queryKey: ['org-invitations'] });
    },
    onError: (e: any) => setInviteErr(e.message),
  });

  const revokeInviteMut = useMutation({
    mutationFn: (id: string) => api(`/api/orgs/invitations/${id}`, token, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-invitations'] }),
  });

  const removeMemberMut = useMutation({
    mutationFn: (userId: string) => api(`/api/orgs/members/${userId}`, token, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });

  const changeRoleMut = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api(`/api/orgs/members/${userId}/role`, token, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });

  const setBudgetMut = useMutation({
    mutationFn: ({ userId, monthlyBudget }: { userId: string; monthlyBudget: number }) =>
      api(`/api/orgs/members/${userId}/budget`, token, { method: 'PATCH', body: JSON.stringify({ monthlyBudget }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });

  const resetPasswordMut = useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      api(`/api/orgs/members/${userId}/password`, token, { method: 'POST', body: JSON.stringify({ newPassword }) }),
  });

  if (orgLoading) {
    return <div className="card p-8 text-center text-gray-400">Loading organization…</div>;
  }
  if (!orgData) {
    return <div className="card p-8 text-center text-red-500">Could not load organization</div>;
  }

  const isOwner = orgData.yourRole === 'owner';
  const org = orgData.organization;
  const members: Member[] = orgData.members ?? [];
  const invitations: Invitation[] = invitesData?.invitations ?? [];

  function copyLink(url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setShowCopiedLink(url);
      setTimeout(() => setShowCopiedLink(null), 3000);
    });
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Team & Permissions</h1>
        <p className="text-gray-400 text-sm">Manage who has access to {org?.name ?? 'your organization'}</p>
      </div>

      {/* Org summary */}
      <div className="card grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">Plan</p>
          <p className="text-lg font-bold capitalize">{org?.plan}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">Credits this month</p>
          <p className="text-lg font-bold">{org?.credits_used_this_month} / {org?.monthly_allowance}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">Members</p>
          <p className="text-lg font-bold">{members.length} / {org?.max_users}</p>
        </div>
      </div>

      {!isOwner && (
        <div className="card bg-amber-50 border-amber-200">
          <p className="text-sm text-amber-800">
            You're a <strong>{orgData.yourRole}</strong> in this organization. Only the owner can invite users and change roles.
          </p>
        </div>
      )}

      {/* Invite form */}
      {isOwner && (
        <div className="card">
          <h2 className="font-bold mb-4">Invite a team member</h2>
          <div className="flex flex-col gap-3">
            <div className="flex gap-3">
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="email@example.com"
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
              >
                <option value="manager">Manager</option>
                <option value="viewer">Viewer</option>
                <option value="billing_admin">Billing admin</option>
              </select>
              <button
                onClick={() => inviteMut.mutate()}
                disabled={!inviteEmail || inviteMut.isPending}
                className="btn-primary"
              >
                {inviteMut.isPending ? 'Sending…' : 'Send invite'}
              </button>
            </div>
            <p className="text-xs text-gray-400">{ROLE_LABELS[inviteRole]}</p>
            {inviteErr && <p className="text-sm text-red-600 bg-red-50 p-2 rounded">{inviteErr}</p>}
            {showCopiedLink && (
              <div className="text-sm bg-green-50 text-green-800 p-3 rounded border border-green-200">
                <strong>Invitation sent.</strong> Share this link with the invitee:
                <div className="mt-2 flex gap-2">
                  <code className="flex-1 bg-white px-2 py-1 rounded text-xs break-all">{showCopiedLink}</code>
                  <button onClick={() => copyLink(showCopiedLink)} className="text-xs btn-outline">Copy</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Pending invitations */}
      {isOwner && invitations.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3">Pending invitations ({invitations.length})</h2>
          <ul className="space-y-2">
            {invitations.map(inv => (
              <li key={inv.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg text-sm">
                <div>
                  <span className="font-semibold">{inv.email}</span>
                  <span className="ml-2 text-gray-400">— {inv.role}</span>
                  <span className="ml-2 text-xs text-gray-300">expires {new Date(inv.expires_at).toLocaleDateString()}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => copyLink(`${window.location.origin}/invite/accept?token=${inv.token}`)}
                    className="text-xs text-brand-600 hover:underline"
                  >
                    Copy link
                  </button>
                  <button
                    onClick={() => { if (confirm('Revoke this invitation?')) revokeInviteMut.mutate(inv.id); }}
                    className="text-xs text-red-500 hover:underline"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Members list */}
      <MembersList
        members={members}
        isOwner={isOwner}
        onChangeRole={(userId, role) => changeRoleMut.mutate({ userId, role })}
        onSetBudget={(userId, monthlyBudget) => setBudgetMut.mutate({ userId, monthlyBudget })}
        onResetPassword={async (userId) => {
          const newPassword = prompt('Enter the new password (min 8 chars):');
          if (!newPassword || newPassword.length < 8) {
            if (newPassword) alert('Password must be at least 8 characters');
            return;
          }
          try {
            await resetPasswordMut.mutateAsync({ userId, newPassword });
            alert('Password reset successfully');
          } catch (e: any) {
            alert('Failed: ' + e.message);
          }
        }}
        onRemove={(userId) => {
          if (confirm('Remove this member? They will lose access immediately.')) {
            removeMemberMut.mutate(userId);
          }
        }}
        onAssignBusinesses={(userId) => setSelectedBusinessId(userId)}
      />

      {/* Business assignment modal */}
      {selectedBusinessId && (
        <BusinessAssignment
          userId={selectedBusinessId}
          businesses={businesses ?? []}
          token={token}
          onClose={() => setSelectedBusinessId(null)}
        />
      )}
    </div>
  );
}
