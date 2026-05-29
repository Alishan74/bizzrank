import { useState, useEffect } from 'react';

interface Business {
  id: string;
  name: string;
  address?: string;
}

interface Props {
  userId: string;
  businesses: Business[];
  token: string;
  onClose: () => void;
}

/**
 * Modal that lists every business in the org and lets the owner toggle
 * which ones this member can access.
 */
export default function BusinessAssignment({ userId, businesses, token, onClose }: Props) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    // Load current assignments by querying each business's access list
    (async () => {
      const result = new Set<string>();
      await Promise.all(businesses.map(async b => {
        try {
          const res = await fetch(`/api/orgs/businesses/${b.id}/access`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const d = await res.json();
            if ((d.access ?? []).some((a: any) => a.user_id === userId)) {
              result.add(b.id);
            }
          }
        } catch {}
      }));
      setAssigned(result);
      setLoading(false);
    })();
  }, [userId, businesses, token]);

  async function toggle(business: Business) {
    setSaving(business.id);
    const currentlyAssigned = assigned.has(business.id);
    try {
      if (currentlyAssigned) {
        const res = await fetch(`/api/orgs/businesses/${business.id}/assign/${userId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Revoke failed');
        const next = new Set(assigned); next.delete(business.id); setAssigned(next);
      } else {
        const res = await fetch(`/api/orgs/businesses/${business.id}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ userId }),
        });
        if (!res.ok) throw new Error('Grant failed');
        const next = new Set(assigned); next.add(business.id); setAssigned(next);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="font-bold">Assign businesses</h2>
            <p className="text-xs text-gray-400 mt-1">User ID: <code className="text-xs">{userId.slice(0, 12)}…</code></p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-100 text-gray-400">×</button>
        </div>
        <div className="p-5 overflow-y-auto flex-1">
          {loading ? (
            <p className="text-center text-gray-400 py-8">Loading access list…</p>
          ) : businesses.length === 0 ? (
            <p className="text-center text-gray-400 py-8">No businesses in this org yet.</p>
          ) : (
            <ul className="space-y-2">
              {businesses.map(b => (
                <li key={b.id}>
                  <button
                    onClick={() => toggle(b)}
                    disabled={saving === b.id}
                    className={'w-full text-left p-3 rounded-xl border-2 transition-colors flex items-center gap-3 ' +
                      (assigned.has(b.id) ? 'border-brand-500 bg-brand-50' : 'border-gray-100 hover:border-gray-200')}
                  >
                    <div className={'w-5 h-5 rounded-md border-2 flex items-center justify-center ' +
                      (assigned.has(b.id) ? 'bg-brand-500 border-brand-500' : 'border-gray-300')}>
                      {assigned.has(b.id) && <span className="text-white text-xs">✓</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{b.name}</p>
                      {b.address && <p className="text-xs text-gray-400 truncate">{b.address}</p>}
                    </div>
                    {saving === b.id && <span className="text-xs text-gray-400">…</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="p-4 border-t border-gray-100 text-right">
          <button onClick={onClose} className="btn-primary">Done</button>
        </div>
      </div>
    </div>
  );
}
