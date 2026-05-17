import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bizApi, citationApi } from '../lib/api';
import { Skeleton } from '../components/Shared';

export default function CitationsPage() {
  const [selectedBizId, setSelectedBizId] = useState('');
  const qc = useQueryClient();

  const { data: bizData } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  useEffect(() => {
    if (bizData?.length && !selectedBizId) setSelectedBizId(bizData[0].id);
  }, [bizData]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['citations', selectedBizId],
    queryFn: () => citationApi.get(selectedBizId).then(r => r.data),
    enabled: !!selectedBizId,
  });

  const runAudit = useMutation({
    mutationFn: () => citationApi.run(selectedBizId),
    onSuccess: () => setTimeout(refetch, 3000),
  });

  const completeTask = useMutation({
    mutationFn: ({ auditId, idx }: any) => citationApi.completeTask(auditId, idx),
    onSuccess: refetch,
  });

  const audit = data?.audit;
  const hasBL = data?.brightlocalEnabled;
  const tasks: any[] = audit?.conquest_tasks ?? [];
  const completedCount = tasks.filter((t: any) => t.completed).length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Citation Audit</h1>
          <p className="text-gray-400 text-sm">NAP consistency across {hasBL ? '50+' : '24'} platforms · Auto-updates weekly</p>
        </div>
        <div className="flex gap-2">
          <select className="input max-w-xs" value={selectedBizId} onChange={e => setSelectedBizId(e.target.value)}>
            {bizData?.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button
            onClick={() => runAudit.mutate()}
            className="btn-primary"
            disabled={runAudit.isPending || !selectedBizId}
          >
            {runAudit.isPending ? 'Running...' : audit ? 'Re-audit' : 'Run Audit'}
          </button>
        </div>
      </div>

      {!hasBL && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="font-semibold text-blue-800 mb-1">Connect BrightLocal for Full Accuracy</p>
          <p className="text-sm text-blue-700">
            Add <code className="bg-blue-100 px-1 rounded">BRIGHTLOCAL_API_KEY</code> to your .env file to check 50+ directories with real NAP data from BrightLocal API.
          </p>
        </div>
      )}

      <div className="bg-brand-50 border border-brand-200 rounded-xl p-4">
        <p className="font-semibold text-brand-800 mb-1">What is a Citation Audit?</p>
        <p className="text-sm text-brand-700">
          Google ranks businesses higher when your Name, Address and Phone are <strong>identical</strong> across the web.
          Even small differences like "St" vs "Street" hurt your rankings. This audit finds every mismatch and tells you exactly how to fix it.
        </p>
      </div>

      {!audit && !isLoading && (
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">📋</div>
          <p className="text-gray-500 mb-4">No audit run yet for this business</p>
          <button onClick={() => runAudit.mutate()} className="btn-primary" disabled={!selectedBizId}>
            Run Citation Audit
          </button>
        </div>
      )}

      {isLoading && <Skeleton />}

      {audit && (
        <>
          {audit.status === 'running' && (
            <div className="card bg-blue-50 border-blue-200">
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                <p className="text-sm text-blue-700">Checking your listings across directories... this takes about 30 seconds</p>
              </div>
            </div>
          )}

          {audit.status === 'completed' && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-bold">NAP Health Score</h3>
                  <p className="text-sm text-gray-400">{audit.total_platforms} platforms checked</p>
                </div>
                <p className={'text-3xl font-black ' + (audit.health_score >= 70 ? 'text-green-600' : audit.health_score >= 40 ? 'text-amber-600' : 'text-red-600')}>
                  {audit.health_score}%
                </p>
              </div>
              <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={'h-full rounded-full ' + (audit.health_score >= 70 ? 'bg-green-500' : audit.health_score >= 40 ? 'bg-amber-500' : 'bg-red-500')}
                  style={{ width: audit.health_score + '%' }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>{audit.matching_platforms} matching</span>
                <span>{audit.issues_found} issues found</span>
              </div>
            </div>
          )}

          {tasks.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-bold">Conquest Tasks</h3>
                  <p className="text-sm text-gray-400">{completedCount} of {tasks.length} fixed</p>
                </div>
                <p className="text-xl font-bold text-brand-600">
                  {Math.round((completedCount / Math.max(tasks.length, 1)) * 100)}%
                </p>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 rounded-full transition-all"
                  style={{ width: ((completedCount / Math.max(tasks.length, 1)) * 100) + '%' }}
                />
              </div>
            </div>
          )}

          <div className="space-y-3">
            {tasks.map((task: any, idx: number) => (
              <div
                key={idx}
                className={'rounded-xl border p-4 ' + (task.completed ? 'bg-green-50 border-green-200' : task.priority === 'high' ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold">{task.platform}</span>
                      {task.priority === 'high' && !task.completed && <span className="badge-red text-xs">High priority</span>}
                      {task.completed && <span className="badge-green text-xs">Fixed</span>}
                    </div>
                    <p className="text-sm text-gray-600">{task.action}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {task.listingUrl && (
                      <a href={task.listingUrl} target="_blank" rel="noreferrer" className="btn-secondary text-xs py-1.5 px-3">
                        View listing
                      </a>
                    )}
                    {!task.completed && (
                      <button onClick={() => completeTask.mutate({ auditId: audit.id, idx })} className="btn-primary text-xs py-1.5 px-3">
                        Mark fixed
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {audit.next_audit_date && (
            <p className="text-xs text-gray-400 text-center">
              Next weekly auto-audit: {new Date(audit.next_audit_date).toLocaleDateString()}
            </p>
          )}
        </>
      )}
    </div>
  );
}
