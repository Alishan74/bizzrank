import { useState } from 'react';

interface Member {
  id: string;
  user_id: string;
  role: string;
  monthly_credit_budget: number;
  credits_used_this_month: number;
  created_at: string;
}

const ROLES = [
  { value: 'manager', label: 'Manager' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'billing_admin', label: 'Billing admin' },
];

interface Props {
  members: Member[];
  isOwner: boolean;
  onChangeRole: (userId: string, role: string) => void;
  onSetBudget: (userId: string, monthlyBudget: number) => void;
  onResetPassword: (userId: string) => void;
  onRemove: (userId: string) => void;
  onAssignBusinesses: (userId: string) => void;
}

export default function MembersList({
  members, isOwner,
  onChangeRole, onSetBudget, onResetPassword, onRemove, onAssignBusinesses,
}: Props) {
  const [editingBudget, setEditingBudget] = useState<string | null>(null);
  const [budgetValue, setBudgetValue] = useState('');

  function startEditingBudget(member: Member) {
    setEditingBudget(member.user_id);
    setBudgetValue(String(member.monthly_credit_budget));
  }

  function saveBudget(userId: string) {
    const n = parseInt(budgetValue, 10);
    if (isNaN(n) || n < 0) return;
    onSetBudget(userId, n);
    setEditingBudget(null);
  }

  return (
    <div className="card">
      <h2 className="font-bold mb-3">Team members ({members.length})</h2>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
          <tr>
            <th className="py-2">User ID</th>
            <th>Role</th>
            <th>Monthly budget</th>
            <th>Used</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {members.map(m => {
            const isOwnerRow = m.role === 'owner';
            return (
              <tr key={m.id} className="hover:bg-gray-50">
                <td className="py-3 font-mono text-xs text-gray-500">{m.user_id.slice(0, 8)}…</td>
                <td>
                  {isOwner && !isOwnerRow ? (
                    <select
                      value={m.role}
                      onChange={e => onChangeRole(m.user_id, e.target.value)}
                      className="text-xs px-2 py-1 border border-gray-200 rounded"
                    >
                      {ROLES.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={'badge ' + (isOwnerRow ? 'badge-blue' : 'badge-gray')}>{m.role}</span>
                  )}
                </td>
                <td>
                  {editingBudget === m.user_id ? (
                    <span className="flex items-center gap-1">
                      <input
                        type="number"
                        value={budgetValue}
                        onChange={e => setBudgetValue(e.target.value)}
                        className="w-20 px-2 py-1 border border-gray-200 rounded text-xs"
                      />
                      <button onClick={() => saveBudget(m.user_id)} className="text-xs text-brand-600">Save</button>
                      <button onClick={() => setEditingBudget(null)} className="text-xs text-gray-300">Cancel</button>
                    </span>
                  ) : (
                    <span>
                      {m.monthly_credit_budget === 0 ? <em className="text-gray-300">no cap</em> : m.monthly_credit_budget}
                      {isOwner && !isOwnerRow && (
                        <button onClick={() => startEditingBudget(m)} className="ml-2 text-xs text-brand-600 hover:underline">edit</button>
                      )}
                    </span>
                  )}
                </td>
                <td className="text-gray-500">{m.credits_used_this_month}</td>
                <td className="text-right">
                  {isOwner && !isOwnerRow && (
                    <div className="flex gap-3 justify-end text-xs">
                      <button onClick={() => onAssignBusinesses(m.user_id)} className="text-brand-600 hover:underline">Businesses</button>
                      <button onClick={() => onResetPassword(m.user_id)} className="text-gray-600 hover:underline">Reset password</button>
                      <button onClick={() => onRemove(m.user_id)} className="text-red-500 hover:underline">Remove</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
