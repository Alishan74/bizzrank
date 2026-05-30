import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/credits', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { data } = await supabase
      .from('credit_transactions')
      .select('*')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: false })
      .limit(50);
    res.json({ transactions: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to load credits' });
  }
});

router.patch('/details', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { fullName, companyName } = req.body;
    if (!fullName) return res.status(400).json({ error: 'Full name required' });
    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: fullName,
        company_name: companyName ?? '',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.userId!);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/password', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const { data: user } = await supabase.auth.admin.getUserById(req.userId!);
    if (!user.user?.email) return res.status(400).json({ error: 'User not found' });

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.user.email,
      password: currentPassword,
    });
    if (signInError) return res.status(401).json({ error: 'Current password is incorrect' });

    const { error } = await supabase.auth.admin.updateUserById(req.userId!, { password: newPassword });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /profile/account
 * GDPR / CCPA right to erasure — permanently deletes all user data.
 * Requires password confirmation to prevent accidental deletion.
 */
router.delete('/account', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password confirmation required' });

    // Verify password before deletion
    const { data: user } = await supabase.auth.admin.getUserById(req.userId!);
    if (!user.user?.email) return res.status(400).json({ error: 'User not found' });
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: user.user.email, password,
    });
    if (signInErr) return res.status(401).json({ error: 'Incorrect password' });

    const uid = req.userId!;

    // Delete leaf tables first (cascade handles children via FK)
    await Promise.allSettled([
      supabase.from('intel_signals').delete().eq('user_id', uid),
      supabase.from('credit_transactions').delete().eq('user_id', uid),
      supabase.from('gbp_guard_alerts').delete().eq('user_id', uid),
      supabase.from('gbp_snapshots').delete().eq('user_id', uid),
      supabase.from('ai_visibility_results').delete().eq('user_id', uid),
      supabase.from('ai_citation_intelligence').delete().eq('user_id', uid),
      supabase.from('agency_work_queue').delete().eq('user_id', uid),
    ]);

    // Delete businesses (cascade removes scans, reviews, keywords, competitors)
    await supabase.from('businesses').delete().eq('user_id', uid);

    // Delete org and all members/invitations
    const { data: orgs } = await supabase.from('organizations')
      .select('id').eq('owner_id', uid);
    for (const org of orgs ?? []) {
      await supabase.from('org_members').delete().eq('org_id', org.id);
      await supabase.from('org_invitations').delete().eq('org_id', org.id);
      await supabase.from('agency_clients').delete().eq('org_id', org.id);
      await supabase.from('organizations').delete().eq('id', org.id);
    }

    // Delete profile row
    await supabase.from('profiles').delete().eq('id', uid);

    // Delete Supabase auth user — permanent, no undo
    await supabase.auth.admin.deleteUser(uid);

    res.json({ success: true, message: 'Account and all data permanently deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Deletion failed' });
  }
});

export default router;
