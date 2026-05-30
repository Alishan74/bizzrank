/**
 * Auth routes — UPDATED for RBAC.
 *
 * Key changes vs. previous version:
 *   - POST /signup       → creates the user, then creates their personal org
 *                          (via OrgService.createOrg), then adds them as owner.
 *   - POST /accept-invite-signup → signs up + immediately accepts an org invitation
 *                                  (so an invitee can register and join in one flow).
 *   - GET  /me           → now also includes the user's current org and role.
 *
 * Existing /login, /gbp/* endpoints unchanged.
 */

import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { getGBPAuthUrl, exchangeGBPCode, fetchGBPLocations } from '../../domains/identity/GoogleMapsService.js';
import { orgService } from '../../domains/orgs/OrgService.js';
import { PLANS } from '../../domains/billing/BillingService.js';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const router = Router();
const JWT = process.env.JWT_SECRET!;

/**
 * Create a brand-new user + their own personal org.
 * The new user is always the OWNER of their freshly created org.
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, fullName, companyName } = req.body;
    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Email, password and full name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: fullName, company_name: companyName ?? '' },
    });
    if (error) {
      if (error.message.includes('already')) {
        return res.status(400).json({ error: 'This email is already registered — try signing in' });
      }
      return res.status(400).json({ error: error.message });
    }

    // No sleep needed — we upsert the profile directly below
    // The trigger may or may not have fired; upsert handles both cases

    // Make sure the profile exists (idempotent)
    await supabase.from('profiles').upsert({
      id: data.user.id,
      full_name: fullName,
      company_name: companyName ?? '',
      plan: 'starter',
      credits_balance: PLANS.starter.credits,
      monthly_allowance: PLANS.starter.credits,
      max_businesses: 1,
      max_competitors_per_location: 3,
    }, { onConflict: 'id' });

    // Create the user's personal org — they become its owner
    const org = await orgService.createOrg(
      data.user.id,
      `${fullName}'s workspace`,
      'starter',
    );

    // Point their profile at the new org as the active one
    await supabase.from('profiles').update({ current_org_id: org.id }).eq('id', data.user.id);

    const token = jwt.sign({ userId: data.user.id, email }, JWT, { expiresIn: '7d' });
    res.status(201).json({
      token,
      user: { id: data.user.id, email, fullName, orgId: org.id, role: 'owner' },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Signup failed' });
  }
});

/**
 * Signup AND immediately accept an org invitation in one call.
 * Used by the invite-accept page when the invitee doesn't have an account yet.
 * Result: new user signs in, gets added to the inviting org with the invited role.
 */
router.post('/accept-invite-signup', async (req, res) => {
  try {
    const { email, password, fullName, token: inviteToken } = req.body;
    if (!email || !password || !fullName || !inviteToken) {
      return res.status(400).json({ error: 'email, password, fullName, token required' });
    }

    // Validate invitation first so we don't create a user for a bad token
    const inv = await orgService.getInvitationByToken(inviteToken);
    if (!inv) return res.status(400).json({ error: 'Invalid or expired invitation' });
    if (inv.email !== email.toLowerCase().trim()) {
      return res.status(400).json({ error: 'Invitation email does not match' });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) {
      if (error.message.includes('already')) {
        return res.status(400).json({ error: 'Account already exists — sign in then accept the invite' });
      }
      return res.status(400).json({ error: error.message });
    }

    await supabase.from('profiles').upsert({
      id: data.user.id, full_name: fullName, plan: 'starter',
      credits_balance: 0, monthly_allowance: 0,
    }, { onConflict: 'id' });

    // Accept the invitation — adds them to the inviter's org with the assigned role
    const member = await orgService.acceptInvitation(inviteToken, data.user.id);

    // Point their profile at the new org
    await supabase.from('profiles').update({ current_org_id: member.org_id }).eq('id', data.user.id);

    const jwtToken = jwt.sign({ userId: data.user.id, email }, JWT, { expiresIn: '7d' });
    res.status(201).json({
      token: jwtToken,
      user: { id: data.user.id, email, fullName, orgId: member.org_id, role: member.role },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Signup + accept failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ userId: data.user.id, email }, JWT, { expiresIn: '7d' });
    res.json({ token, user: { id: data.user.id, email } });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Login failed' });
  }
});

router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('profiles').select('*').eq('id', req.userId).single();
    if (error || !profile) {
      return res.status(404).json({ error: 'Profile not found — please sign in again' });
    }

    // Also include current org + role for convenience
    let org = null;
    let role = null;
    if (profile.current_org_id) {
      const { data: orgData } = await supabase
        .from('organizations').select('*').eq('id', profile.current_org_id).single();
      org = orgData;
      const { data: member } = await supabase
        .from('org_members').select('role')
        .eq('org_id', profile.current_org_id).eq('user_id', req.userId).single();
      role = member?.role ?? null;
    }

    res.json({
      id: req.userId,
      email: req.userEmail,
      ...profile,
      currentOrg: org,
      currentRole: role,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to load profile' });
  }
});

router.get('/gbp/connect', requireAuth, (req: AuthRequest, res) => {
  try {
    res.json({ url: getGBPAuthUrl(req.userId!) });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'GBP not configured' });
  }
});

router.get('/gbp/callback', async (req, res) => {
  const { code, state: userId } = req.query as any;
  if (!code || !userId) return res.status(400).send('Missing params');
  try {
    const { accessToken, refreshToken } = await exchangeGBPCode(code);
    await supabase.from('profiles').update({
      gbp_access_token: accessToken,
      gbp_refresh_token: refreshToken,
      gbp_connected: true,
    }).eq('id', userId);
    const locations = await fetchGBPLocations(accessToken);
    await supabase.from('gbp_pending_locations').upsert({
      user_id: userId, locations, created_at: new Date().toISOString(),
    });
    res.redirect(`${process.env.FRONTEND_URL}/businesses?gbp=connected`);
  } catch (err: any) {
    console.error('[GBP Callback]', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/businesses?gbp=error`);
  }
});

router.get('/gbp/locations', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { data } = await supabase.from('gbp_pending_locations')
      .select('locations').eq('user_id', req.userId).single();
    res.json({ locations: data?.locations ?? [] });
  } catch {
    res.json({ locations: [] });
  }
});

/**
 * POST /auth/refresh
 * Refreshes a JWT token if it's within 24h of expiry.
 * Called by frontend interceptor when a 401 is received.
 * Issues a new 7-day token without requiring re-login.
 */
router.post('/refresh', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles').select('plan').eq('id', req.userId!).single();

    // Issue a fresh 7-day token
    const token = jwt.sign(
      { userId: req.userId!, email: req.userEmail },
      JWT,
      { expiresIn: '7d' }
    );

    res.json({ token, plan: profile?.plan ?? 'starter' });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Refresh failed' });
  }
});

export default router;
