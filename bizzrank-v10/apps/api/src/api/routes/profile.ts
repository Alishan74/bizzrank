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

export default router;
