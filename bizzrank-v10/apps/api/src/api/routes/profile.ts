import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
const router = Router();

// GET /api/profile/credits — credit transaction history
router.get('/credits', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await supabase
    .from('credit_transactions')
    .select('*')
    .eq('user_id', req.userId!)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json({ transactions: data ?? [] });
});

// PATCH /api/profile/details — update name and company
router.patch('/details', requireAuth, async (req: AuthRequest, res) => {
  const { fullName, companyName } = req.body;
  if (!fullName) return res.status(400).json({ error: 'Full name required' });
  const { error } = await supabase
    .from('profiles')
    .update({ full_name: fullName, company_name: companyName ?? '', updated_at: new Date().toISOString() })
    .eq('id', req.userId!);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH /api/profile/password — change password
router.patch('/password', requireAuth, async (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

  // Verify current password by trying to sign in
  const { data: user } = await supabase.auth.admin.getUserById(req.userId!);
  if (!user.user?.email) return res.status(400).json({ error: 'User not found' });

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.user.email,
    password: currentPassword,
  });
  if (signInError) return res.status(401).json({ error: 'Current password is incorrect' });

  // Update password
  const { error } = await supabase.auth.admin.updateUserById(req.userId!, { password: newPassword });
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

export default router;
