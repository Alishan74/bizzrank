import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

const ROLE_BADGE: Record<string, string> = {
  owner:   'bg-purple-100 text-purple-700',
  manager: 'bg-blue-100 text-blue-700',
  viewer:  'bg-gray-100 text-gray-500',
};
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', manager: 'Manager', viewer: 'Viewer',
};

export default function TeamPage() {
  const qc = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'manager'|'viewer'>('viewer');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteErr, setInviteErr] = useState('');
  const [inviting, setInviting] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['org'],
    queryFn: () => api.get('/orgs').then(r => r.data),
    retry: 1,
  });

  const removeM   = useMutation({ mutationFn: (id: string) => api.delete('/orgs/members/' + id), onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }) });
  const changeRole = useMutation({ mutationFn: ({ id, role }: any) => api.patch('/orgs/members/' + id + '/role', { role }), onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }) });
  const revokeInv  = useMutation({ mutationFn: (id: string) => api.delete('/orgs/invitations/' + id), onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }) });

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true); setInviteErr(''); setInviteLink('');
    try {
      const r = await api.post('/orgs/invitations', { email: inviteEmail.trim(), role: inviteRole });
      setInviteLink(r.data.inviteUrl);
      setInviteEmail('');
      qc.invalidateQueries({ queryKey: ['org'] });
    } catch (ex: any) {
      setInviteErr(ex.response?.data?.error ?? 'Invitation failed');
    } finally { setInviting(false); }
  }

  if (isLoading) return (
    <div className="max-w-3xl space-y-4 animate-pulse">
      <div className="h-8 w-40 bg-gray-200 rounded" />
      <div className="h-40 bg-gray-100 rounded-2xl" />
    </div>
  );

  if (error || !data) return (
    <div className="max-w-3xl">
      <div className="card text-center py-10">
        <p className="text-red-500 font-semibold mb-2">Could not load organization</p>
        <p className="text-sm text-gray-500 mb-4">Run the SQL migration first, then restart the API.</p>
        <div className="bg-gray-50 rounded-xl p-4 text-left text-sm font-mono text-gray-600 max-w-md mx-auto">
          <p className="font-semibold text-gray-800 mb-1 font-sans">Supabase SQL Editor:</p>
          <p>migration/006-team-orgs.sql</p>
        </div>
      </div>
    </div>
  );

  const { org, members, invitations, myRole } = data;
  const isOwner = myRole === 'owner';

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Team</h1>
        <p className="text-gray-400 text-sm">Manage organization members and access</p>
      </div>

      <div className="card flex items-center gap-4">
        <div className="w-12 h-12 bg-brand-100 rounded-2xl flex items-center justify-center shrink-0">
          <span className="text-2xl">🏢</span>
        </div>
        <div>
          <p className="font-bold text-lg">{org?.name ?? 'My Organization'}</p>
          <p className="text-sm text-gray-400">
            {members?.length ?? 0} member{members?.length !== 1 ? 's' : ''} ·{' '}
            <span className={'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ' + (ROLE_BADGE[myRole] ?? ROLE_BADGE.viewer)}>
              {ROLE_LABEL[myRole] ?? myRole}
            </span>
          </p>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="font-semibold text-gray-700">Members</h2>
        </div>
        <div className="divide-y divide-gray-50">
          {(members ?? []).map((m: any) => (
            <div key={m.id} className="flex items-center gap-3 px-5 py-4">
              <div className="w-9 h-9 bg-brand-100 rounded-full flex items-center justify-center shrink-0 font-bold text-brand-700 text-sm">
                {m.name?.[0]?.toUpperCase() ?? '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-sm">{m.name}{m.isMe && <span className="text-gray-400 font-normal text-xs"> (you)</span>}</p>
                  <span className={'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ' + (ROLE_BADGE[m.role] ?? ROLE_BADGE.viewer)}>
                    {ROLE_LABEL[m.role] ?? m.role}
                  </span>
                </div>
                <p className="text-xs text-gray-400">{m.company || 'No company'} · {m.plan} · 💳 {m.credits}</p>
              </div>
              {isOwner && !m.isMe && m.role !== 'owner' && (
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                    value={m.role}
                    onChange={e => changeRole.mutate({ id: m.id, role: e.target.value })}
                  >
                    <option value="manager">Manager</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    onClick={() => { if (confirm('Remove this member?')) removeM.mutate(m.id); }}
                    className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {isOwner && (invitations ?? []).length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-amber-50">
            <h2 className="font-semibold text-amber-800">Pending Invitations</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {invitations.map((inv: any) => (
              <div key={inv.id} className="flex items-center gap-3 px-5 py-4">
                <div className="w-9 h-9 bg-amber-100 rounded-full flex items-center justify-center shrink-0 text-sm text-amber-600">✉</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{inv.email}</p>
                  <p className="text-xs text-gray-400">Role: {ROLE_LABEL[inv.role] ?? inv.role} · Expires {new Date(inv.expires_at).toLocaleDateString()}</p>
                </div>
                <button onClick={() => revokeInv.mutate(inv.id)} className="text-xs text-gray-400 hover:text-red-500 shrink-0">Revoke</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOwner && (
        <div className="card">
          <h2 className="font-semibold mb-1">Invite a Team Member</h2>
          <p className="text-sm text-gray-500 mb-4">They receive an invite link to join your organization.</p>
          <form onSubmit={sendInvite} className="flex flex-col gap-3">
            <div className="flex gap-2">
              <input type="email" className="input flex-1" placeholder="teammate@company.com"
                value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required />
              <select className="input w-36 shrink-0" value={inviteRole} onChange={e => setInviteRole(e.target.value as any)}>
                <option value="manager">Manager</option>
                <option value="viewer">Viewer</option>
              </select>
              <button type="submit" className="btn-primary shrink-0" disabled={inviting}>
                {inviting ? 'Sending...' : 'Invite'}
              </button>
            </div>
            {inviteErr && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-xl">{inviteErr}</p>}
            {inviteLink && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <p className="text-sm font-semibold text-green-800 mb-2">Invitation created</p>
                <div className="flex gap-2">
                  <input type="text" readOnly value={inviteLink}
                    className="input text-xs flex-1 bg-white" onClick={e => (e.target as HTMLInputElement).select()} />
                  <button type="button" onClick={() => navigator.clipboard.writeText(inviteLink)}
                    className="btn-outline text-xs shrink-0">Copy</button>
                </div>
                <p className="text-xs text-green-600 mt-2">Link expires in 7 days</p>
              </div>
            )}
          </form>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400">
              <strong>Manager:</strong> can view businesses and run scans.<br />
              <strong>Viewer:</strong> read-only access.
            </p>
          </div>
        </div>
      )}

      {!isOwner && (
        <div className="card bg-gray-50 text-center py-6">
          <p className="text-sm text-gray-500">Only the org owner can invite members.</p>
        </div>
      )}
    </div>
  );
}
