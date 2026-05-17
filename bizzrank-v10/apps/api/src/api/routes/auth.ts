import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getGBPAuthUrl, exchangeGBPCode, fetchGBPLocations } from '../../domains/identity/GoogleMapsService.js';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
const router = Router();
const JWT = process.env.JWT_SECRET!;

router.post('/signup', async (req, res) => {
  const { email, password, fullName, companyName } = req.body;
  if (!email || !password || !fullName) return res.status(400).json({ error: 'Email, password and full name are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName, company_name: companyName ?? '' } });
  if (error) {
    if (error.message.includes('already')) return res.status(400).json({ error: 'This email is already registered — try signing in instead' });
    return res.status(400).json({ error: error.message });
  }
  await new Promise(r => setTimeout(r, 700));
  const token = jwt.sign({ userId: data.user.id, email }, JWT, { expiresIn: '7d' });
  res.status(201).json({ token, user: { id: data.user.id, email, fullName } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ userId: data.user.id, email }, JWT, { expiresIn: '7d' });
  res.json({ token, user: { id: data.user.id, email } });
});

router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', req.userId).single();
  if (error || !profile) {
    // Profile missing — clear token so user re-authenticates cleanly
    return res.status(404).json({ error: 'Profile not found — please sign in again' });
  }
  res.json({ id: req.userId, email: req.userEmail, ...profile });
});

router.get('/gbp/connect', requireAuth, (req: AuthRequest, res) => res.json({ url: getGBPAuthUrl(req.userId!) }));

router.get('/gbp/callback', async (req, res) => {
  const { code, state: userId } = req.query as any;
  if (!code || !userId) return res.status(400).send('Missing params');
  try {
    const { accessToken, refreshToken } = await exchangeGBPCode(code);
    await supabase.from('profiles').update({ gbp_access_token: accessToken, gbp_refresh_token: refreshToken, gbp_connected: true }).eq('id', userId);
    const locations = await fetchGBPLocations(accessToken);
    await supabase.from('gbp_pending_locations').upsert({ user_id: userId, locations, created_at: new Date().toISOString() });
    res.redirect(`${process.env.FRONTEND_URL}/businesses?gbp=connected`);
  } catch (err: any) {
    console.error('[GBP Callback]', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/businesses?gbp=error`);
  }
});

router.get('/gbp/locations', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await supabase.from('gbp_pending_locations').select('locations').eq('user_id', req.userId).single();
  res.json({ locations: data?.locations ?? [] });
});

export default router;
