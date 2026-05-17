import 'dotenv/config';

export async function fetchGBPReviews(accessToken: string, locationName: string) {
  try {
    const d = await fetch(`https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50`, { headers:{ Authorization:`Bearer ${accessToken}` } }).then(r => r.json()) as any;
    return (d.reviews ?? []).map((r: any) => ({ reviewId: r.reviewId, reviewerName: r.reviewer?.displayName ?? 'Anonymous', reviewerPhoto: r.reviewer?.profilePhotoUrl ?? null, rating: ({ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5} as any)[r.starRating] ?? 5, text: r.comment ?? '', date: r.createTime, isReplied: !!r.reviewReply?.comment }));
  } catch { return []; }
}

export async function postGBPReply(accessToken: string, locationName: string, reviewId: string, replyText: string): Promise<boolean> {
  try {
    const res = await fetch(`https://mybusiness.googleapis.com/v4/${locationName}/reviews/${reviewId}/reply`, { method:'PUT', headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' }, body: JSON.stringify({ comment: replyText }) });
    return res.ok;
  } catch { return false; }
}
