import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bizApi, reviewApi } from '../lib/api';
import { Skeleton, Modal } from '../components/Shared';

function BrandVoiceModal({ biz, onClose, onSaved }: any) {
  const [ownerName, setOwnerName] = useState(biz.brand_voice?.ownerName ?? '');
  const [description, setDescription] = useState(biz.brand_voice?.businessDescription ?? '');
  const [tone, setTone] = useState(biz.brand_voice?.tone ?? 'friendly');
  const [emphasize, setEmphasize] = useState(biz.brand_voice?.emphasize ?? '');
  const [avoid, setAvoid] = useState(biz.brand_voice?.avoid ?? '');
  const [exampleReply, setExampleReply] = useState(biz.brand_voice?.exampleReply ?? '');
  const [autoReply, setAutoReply] = useState(biz.brand_voice?.autoReply345 ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await bizApi.updateBrandVoice(biz.id, {
      ownerName, businessDescription: description, tone,
      emphasize, avoid, exampleReply, autoReply345: autoReply,
    });
    setSaving(false);
    onSaved();
  }

  return (
    <Modal title={'Brand Voice — ' + biz.name} onClose={onClose}>
      <p className="text-sm text-gray-500 mb-4">Configure how Gemini AI sounds when replying to reviews.</p>
      <div className="space-y-4">
        <div>
          <label className="label">Owner name</label>
          <input type="text" className="input" value={ownerName} onChange={e => setOwnerName(e.target.value)} placeholder="John Smith" />
        </div>
        <div>
          <label className="label">Business description</label>
          <textarea className="input min-h-[80px] resize-none" value={description} onChange={e => setDescription(e.target.value)} placeholder="Family-owned Italian restaurant est. 2005..." />
        </div>
        <div>
          <label className="label">Reply tone</label>
          <select className="input" value={tone} onChange={e => setTone(e.target.value)}>
            <option value="professional">Professional — polished, warm</option>
            <option value="friendly">Friendly — personable, local feel</option>
            <option value="casual">Casual — relaxed, conversational</option>
            <option value="formal">Formal — respectful, measured</option>
            <option value="luxury">Luxury — refined, elevated</option>
            <option value="local_warm">Local and Warm — community-focused</option>
          </select>
        </div>
        <div>
          <label className="label">Always emphasize <span className="text-gray-400 font-normal text-xs">(optional)</span></label>
          <input type="text" className="input" value={emphasize} onChange={e => setEmphasize(e.target.value)} placeholder="our family-owned heritage, fresh daily ingredients..." />
        </div>
        <div>
          <label className="label">Always avoid <span className="text-gray-400 font-normal text-xs">(optional)</span></label>
          <input type="text" className="input" value={avoid} onChange={e => setAvoid(e.target.value)} placeholder="never mention discounts, never be defensive..." />
        </div>
        <div>
          <label className="label">Example reply <span className="text-gray-400 font-normal text-xs">(AI learns your style)</span></label>
          <textarea className="input min-h-[80px] resize-none" value={exampleReply} onChange={e => setExampleReply(e.target.value)} placeholder="Paste one of your own review replies here..." />
        </div>
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
          <div>
            <p className="text-sm font-semibold">Auto-reply for 3–5 star reviews</p>
            <p className="text-xs text-gray-400">1–2 star always requires your approval</p>
          </div>
          <div
            className={'w-10 h-5 rounded-full cursor-pointer transition-colors ' + (autoReply ? 'bg-brand-500' : 'bg-gray-300')}
            onClick={() => setAutoReply(!autoReply)}
          >
            <div className={'w-4 h-4 bg-white rounded-full mt-0.5 shadow transition-transform ' + (autoReply ? 'translate-x-5 ml-0.5' : 'translate-x-0.5')} />
          </div>
        </div>
      </div>
      <div className="flex gap-3 mt-5">
        <button onClick={save} className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Save Brand Voice'}</button>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
      </div>
    </Modal>
  );
}

function ApproveModal({ review, onClose, onApproved }: any) {
  const [text, setText] = useState(review.ai_reply_draft ?? '');
  const approve = useMutation({ mutationFn: () => reviewApi.approve(review.id, text), onSuccess: onApproved });
  const regen = useMutation({ mutationFn: () => reviewApi.regenerate(review.id), onSuccess: (r: any) => setText(r.data.reply) });

  return (
    <Modal title="Review and Approve Reply" onClose={onClose}>
      <div className="bg-red-50 border border-red-100 rounded-xl p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-red-500">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span>
          <span className="text-sm font-semibold">{review.reviewer_name}</span>
        </div>
        <p className="text-sm text-gray-700">"{review.review_text}"</p>
      </div>
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
        1–2 star replies require your approval before posting to Google.
      </p>
      <label className="label">Your reply (edit before posting)</label>
      <textarea className="input min-h-[120px] resize-none" value={text} onChange={e => setText(e.target.value)} />
      <div className="flex gap-3 mt-4">
        <button onClick={() => approve.mutate()} className="btn-primary flex-1" disabled={!text || approve.isPending}>
          {approve.isPending ? 'Posting...' : 'Approve and Post to Google'}
        </button>
        <button onClick={() => regen.mutate()} disabled={regen.isPending} className="btn-secondary">
          {regen.isPending ? '...' : 'Regenerate'}
        </button>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
      </div>
    </Modal>
  );
}

function ReviewCard({ review, onApprove, onRefetch, gbpConnected }: any) {
  const [expanded, setExpanded] = useState(false);
  const toggleAuto = useMutation({ mutationFn: (enabled: boolean) => reviewApi.toggleAuto(review.id, enabled), onSuccess: onRefetch });
  const regen = useMutation({ mutationFn: () => reviewApi.regenerate(review.id), onSuccess: onRefetch });
  const isLow = review.rating <= 2;
  const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);

  const cardBg = review.is_replied
    ? 'border-green-100 bg-green-50'
    : (review.ai_reply_status === 'draft_ready' && review.requires_approval)
    ? 'border-amber-100 bg-amber-50'
    : 'border-gray-100 bg-white';

  return (
    <div className={'rounded-2xl border p-4 ' + cardBg}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="w-9 h-9 bg-gray-200 rounded-full flex items-center justify-center shrink-0 text-sm font-bold">
            {review.reviewer_name?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold">{review.reviewer_name ?? 'Anonymous'}</span>
              <span className={'text-sm ' + (isLow ? 'text-red-500' : 'text-amber-400')}>{stars}</span>
              <span className="text-xs text-gray-400">
                {review.review_date ? new Date(review.review_date).toLocaleDateString() : ''}
              </span>
              {review.source === 'serp' && <span className="badge-gray text-xs">Auto-fetched</span>}
            </div>
            {review.review_text && <p className="text-sm text-gray-700 line-clamp-2">{review.review_text}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {review.is_replied && <span className="badge-green text-xs">Replied</span>}
          {review.ai_reply_status === 'draft_ready' && review.requires_approval && !review.is_replied && (
            <span className="badge-amber text-xs">Needs approval</span>
          )}
          {gbpConnected && !isLow && !review.is_replied && (
            <label className="flex items-center gap-1 cursor-pointer">
              <span className="text-xs text-gray-500">Auto</span>
              <div
                className={'w-8 h-4 rounded-full transition-colors cursor-pointer ' + (review.auto_reply_enabled ? 'bg-brand-500' : 'bg-gray-300')}
                onClick={() => toggleAuto.mutate(!review.auto_reply_enabled)}
              >
                <div className={'w-3 h-3 bg-white rounded-full mt-0.5 shadow transition-transform ' + (review.auto_reply_enabled ? 'translate-x-4 ml-0.5' : 'translate-x-0.5')} />
              </div>
            </label>
          )}
          {isLow && review.ai_reply_status === 'draft_ready' && !review.is_replied && (
            <button onClick={onApprove} className="btn-primary text-xs py-1 px-3">Review and Post</button>
          )}
          <button onClick={() => setExpanded(!expanded)} className="text-gray-400 text-xs">
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {expanded && review.ai_reply_draft && (
        <div className="mt-3 pl-12">
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500">AI Draft Reply</span>
              <button onClick={() => regen.mutate()} disabled={regen.isPending} className="text-xs text-brand-600 hover:underline">
                {regen.isPending ? 'Regenerating...' : 'Regenerate'}
              </button>
            </div>
            <p className="text-sm text-gray-700 italic">"{review.ai_reply_draft}"</p>
          </div>
        </div>
      )}

      {expanded && !review.ai_reply_draft && gbpConnected && (
        <div className="mt-3 pl-12">
          <p className="text-xs text-gray-400">No AI reply drafted yet. Use Generate AI Replies above.</p>
        </div>
      )}

      {expanded && !gbpConnected && (
        <div className="mt-3 pl-12">
          <p className="text-xs text-amber-600">Connect Google Business Profile to enable AI reply posting.</p>
        </div>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const [selectedBizId, setSelectedBizId] = useState('');
  const [showBrandVoice, setShowBrandVoice] = useState(false);
  const [approveModal, setApproveModal] = useState<any>(null);
  const qc = useQueryClient();

  const { data: bizData } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => bizApi.list().then(r => r.data.businesses),
  });

  useEffect(() => {
    if (bizData?.length && !selectedBizId) setSelectedBizId(bizData[0].id);
  }, [bizData]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['reviews', selectedBizId],
    queryFn: () => reviewApi.list(selectedBizId).then(r => r.data),
    enabled: !!selectedBizId,
    refetchInterval: 5000,
  });

  const fetchReviews = useMutation({
    mutationFn: () => reviewApi.fetch(selectedBizId),
    onSuccess: () => setTimeout(() => refetch(), 1000),
  });

  const generateAll = useMutation({
    mutationFn: () => reviewApi.generateAll(selectedBizId),
    onSuccess: () => setTimeout(() => refetch(), 2000),
  });

  const { reviews = [], stats, gbpConnected, lastSync, canFetchWithoutGBP } = data ?? {};
  const unanswered = reviews.filter((r: any) => !r.is_replied && r.ai_reply_status !== 'posted');
  const needsApproval = reviews.filter((r: any) => r.ai_reply_status === 'draft_ready' && r.requires_approval);
  const selectedBiz = bizData?.find((b: any) => b.id === selectedBizId);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Reviews</h1>
        <p className="text-gray-400 text-sm">AI-powered review management</p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <select className="input max-w-xs" value={selectedBizId} onChange={e => setSelectedBizId(e.target.value)}>
          {bizData?.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button
          onClick={() => fetchReviews.mutate()}
          className="btn-secondary text-sm"
          disabled={fetchReviews.isPending || !selectedBizId}
        >
          {fetchReviews.isPending ? 'Fetching...' : 'Fetch Reviews'}
        </button>
        {gbpConnected && (
          <button
            onClick={() => setShowBrandVoice(true)}
            className="btn-outline text-sm"
          >
            Brand Voice
          </button>
        )}
      </div>

      {/* GBP status info */}
      {!gbpConnected && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="font-semibold text-blue-800 mb-1">Reviews visible without Google Business Profile</p>
          <p className="text-sm text-blue-700">
            Reviews are fetched automatically via SerpApi every 24 hours.
            Connect Google Business Profile to enable AI reply posting.
          </p>
          {lastSync && <p className="text-xs text-blue-500 mt-1">Last sync: {new Date(lastSync).toLocaleString()}</p>}
        </div>
      )}

      {/* Review debt */}
      {unanswered.length > 0 && (
        <div className="rounded-2xl bg-gradient-to-r from-red-500 to-rose-600 text-white p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-red-100 text-sm font-medium mb-1">Review Debt Detected</p>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-5xl font-black">{unanswered.length}</span>
                <span className="text-red-100">unanswered reviews</span>
              </div>
              <p className="text-red-100 text-sm">
                Estimated revenue impact: <strong className="text-white text-xl">${stats?.revenueLost?.toLocaleString()}</strong>
              </p>
            </div>
            {gbpConnected && (
              <button
                onClick={() => generateAll.mutate()}
                disabled={generateAll.isPending}
                className="bg-white text-red-600 font-bold px-5 py-3 rounded-xl hover:bg-red-50 text-sm whitespace-nowrap disabled:opacity-70"
              >
                {generateAll.isPending ? 'Generating...' : 'Generate AI Replies'}
              </button>
            )}
          </div>
          {!gbpConnected && (
            <p className="text-red-100 text-sm mt-3">
              Connect Google Business Profile from the Businesses page to enable AI-powered replies.
            </p>
          )}
        </div>
      )}

      {/* Needs approval */}
      {needsApproval.length > 0 && gbpConnected && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="font-semibold text-amber-800">{needsApproval.length} {needsApproval.length === 1 ? 'reply needs' : 'replies need'} approval</p>
            <p className="text-xs text-amber-600">1–2 star replies need your approval before posting to Google</p>
          </div>
          <button onClick={() => setApproveModal(needsApproval[0])} className="btn-secondary text-sm border-amber-300">
            Review now
          </button>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-gray-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-gray-400">Total</p>
          </div>
          <div className="bg-amber-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-amber-700">{stats.avgRating}★</p>
            <p className="text-xs text-gray-400">Avg rating</p>
          </div>
          <div className="bg-red-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-red-600">{unanswered.length}</p>
            <p className="text-xs text-gray-400">Unanswered</p>
          </div>
          <div className="bg-green-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-green-600">{reviews.filter((r: any) => r.is_replied).length}</p>
            <p className="text-xs text-gray-400">Replied</p>
          </div>
        </div>
      )}

      {isLoading ? <Skeleton /> : reviews.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-gray-400 mb-3">No reviews yet.</p>
          <button onClick={() => fetchReviews.mutate()} className="btn-primary text-sm" disabled={fetchReviews.isPending}>
            {fetchReviews.isPending ? 'Fetching...' : 'Fetch Reviews Now'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map((review: any) => (
            <ReviewCard
              key={review.id}
              review={review}
              onApprove={() => setApproveModal(review)}
              onRefetch={refetch}
              gbpConnected={gbpConnected}
            />
          ))}
        </div>
      )}

      {showBrandVoice && selectedBiz && (
        <BrandVoiceModal
          biz={selectedBiz}
          onClose={() => setShowBrandVoice(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['businesses'] }); setShowBrandVoice(false); }}
        />
      )}
      {approveModal && (
        <ApproveModal
          review={approveModal}
          onClose={() => setApproveModal(null)}
          onApproved={() => { setApproveModal(null); refetch(); }}
        />
      )}
    </div>
  );
}
