/**
 * Orgs Route — /api/orgs
 * Team management. Auto-creates org for new users on first access.
 */
import { Router } from 'express';
import { db } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

async function ensureOrg(userId: string): Promise<string> {
  const { data: existing } = await db.from('organizations')
    .select('id').eq('owner_id', userId).single();
  if (existing?.id) return existing.id;

  const { data: profile } = await db.from('profiles')
    .select('full_name, company_name').eq('id', userId).single();
  const orgName = profile?.company_name || profile?.full_name || 'My Team';

  const { data: org, error } = await db.from('organizations')
    .insert({ owner_id: userId, name: orgName })
    .select().single();
  if (error || !org) throw new Error('Failed to create organization: ' + (error?.message ?? ''));

  await db.from('org_members').insert({ org_id: org.id, user_id: userId, role: 'owner' });
  return org.id;
}

// GET /api/orgs
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    const [{ data: org }, { data: members }, { data: invitations }] = await Promise.all([
      db.from('organizations').select('*').eq('id', orgId).single(),
      db.from('org_members')
        .select('id, user_id, role, created_at, profiles(full_name, company_name, plan, credits_balance)')
        .eq('org_id', orgId).order('created_at'),
      db.from('org_invitations')
        .select('id, email, role, accepted, expires_at, created_at')
        .eq('org_id', orgId).eq('accepted', false)
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    ]);

    const myMembership = (members ?? []).find((m: any) => m.user_id === req.userId);
    const myRole = myMembership?.role ?? 'owner';

    res.json({
      org,
      members: (members ?? []).map((m: any) => ({
        id: m.id, userId: m.user_id, role: m.role, joinedAt: m.created_at,
        name:    m.profiles?.full_name ?? 'Unknown',
        company: m.profiles?.company_name ?? '',
        plan:    m.profiles?.plan ?? 'starter',
        credits: m.profiles?.credits_balance ?? 0,
        isMe:    m.user_id === req.userId,
      })),
      invitations: myRole === 'owner' ? (invitations ?? []) : [],
      myRole,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orgs/invitations
router.post('/invitations', requireAuth, async (req: AuthRequest, res) => {
  const { email, role = 'viewer' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data: myM } = await db.from('org_members')
      .select('role').eq('org_id', orgId).eq('user_id', req.userId!).single();
    if (myM?.role !== 'owner') return res.status(403).json({ error: 'Only org owner can invite' });

    const { data: inv, error } = await db.from('org_invitations').insert({
      org_id: orgId, invited_by: req.userId!,
      email: email.toLowerCase().trim(), role,
    }).select().single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Invitation already exists for this email' });
      throw new Error(error.message);
    }

    const inviteUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173') + '/accept-invite?token=' + inv.token;
    res.status(201).json({ invitation: inv, inviteUrl,
      message: 'Invitation created. Share the invite link with ' + email });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orgs/invitations
router.get('/invitations', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data } = await db.from('org_invitations').select('*')
      .eq('org_id', orgId).eq('accepted', false).order('created_at', { ascending: false });
    res.json({ invitations: data ?? [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/orgs/invitations/:id
router.delete('/invitations/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    await db.from('org_invitations').delete().eq('id', req.params.id).eq('org_id', orgId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/orgs/members/:id/role
router.patch('/members/:memberId/role', requireAuth, async (req: AuthRequest, res) => {
  const { role } = req.body;
  if (!['manager','viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data: t } = await db.from('org_members').select('role')
      .eq('id', req.params.memberId).eq('org_id', orgId).single();
    if (t?.role === 'owner') return res.status(403).json({ error: 'Cannot change owner role' });
    await db.from('org_members').update({ role }).eq('id', req.params.memberId).eq('org_id', orgId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/orgs/members/:id
router.delete('/members/:memberId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orgId = await ensureOrg(req.userId!);
    const { data: t } = await db.from('org_members').select('role, user_id')
      .eq('id', req.params.memberId).eq('org_id', orgId).single();
    if (!t) return res.status(404).json({ error: 'Member not found' });
    if (t.role === 'owner') return res.status(403).json({ error: 'Cannot remove owner' });
    if (t.user_id === req.userId) return res.status(403).json({ error: 'Cannot remove yourself' });
    await db.from('org_members').delete().eq('id', req.params.memberId).eq('org_id', orgId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
