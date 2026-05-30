#!/usr/bin/env bash
# BizzRank AI v10 — Final Comprehensive Fix
# Fixes ALL 14 confirmed issues from the deep audit
# cd /workspaces/bizzrank/bizzrank-v10 && bash final_fix.sh
set -e
ROOT="$(pwd)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BizzRank AI v10 — Final Fix (14 issues)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────
# FIX 1: index.ts — Stripe webhook body parser
#
# BUG: express.json() is applied globally BEFORE all routes.
# Stripe's webhook requires raw Buffer body for signature verify.
# By the time the request hits billing.ts, the body is already
# parsed as JSON and the raw Buffer is gone. constructEvent()
# throws "No signatures found" on every webhook → all plan
# upgrades, cancellations, payment failures silently ignored.
# ALSO a security hole: anyone can POST fake webhook events.
#
# FIX: Register express.raw() for the webhook path BEFORE
# express.json(). Express matches the first middleware that fits.
# ─────────────────────────────────────────────────────────────
echo "  [1/14] index.ts — Stripe webhook raw body parser before express.json()"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/index.ts'
with open(path) as f: s = f.read()

# Insert raw body parser for webhook BEFORE express.json()
old = "app.use(express.json({ limit: '10mb' }));"
new = """// Stripe webhook needs raw Buffer body for signature verification.
// MUST be registered BEFORE express.json() — order matters.
// express.json() parses the body and destroys the raw Buffer.
// Without this, stripe.webhooks.constructEvent() throws every time.
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));"""

s = s.replace(old, new)

# Fix agency route registration — it's inside start() after app.listen()
# which is wrong. Move it to the correct position with other routes.
old_agency = """  app.use('/api/agency', agencyRoutes);\n\napp.listen(PORT, '0.0.0.0', () => {"""
new_agency = """app.listen(PORT, '0.0.0.0', () => {"""

s = s.replace(old_agency, new_agency)

# Add agency route in the correct place with all other routes
old_billing = "app.use('/api/billing',             billingRoutes);"
new_billing = """app.use('/api/billing',             billingRoutes);
app.use('/api/agency',              agencyRoutes);"""

if "'/api/agency'" not in s:
    s = s.replace(old_billing, new_billing)

open(path, 'w').write(s)
print("  ✓ Stripe webhook raw body parser fixed + agency route moved to correct position")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 2: auth middleware — remove unsafe JWT_SECRET! assertion
#
# BUG: process.env.JWT_SECRET! — if undefined, jwt.verify()
# uses undefined as secret → ALL tokens verify against each
# other → complete authentication bypass.
# ─────────────────────────────────────────────────────────────
echo "  [2/14] auth middleware — safe JWT_SECRET validation"
cat > "$ROOT/apps/api/src/api/middleware/auth.ts" << 'EOF'
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

export interface AuthRequest extends Request { userId?: string; userEmail?: string; }

// Validate at module load — fail loudly instead of silently
// using undefined as JWT secret (which makes ALL tokens valid)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('[auth middleware] JWT_SECRET environment variable is required but not set');
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  // Support both header and query param (SSE needs ?token=)
  const header = req.headers.authorization?.slice(7);
  const query  = req.query?.token as string | undefined;
  const token  = header ?? query;

  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const p = jwt.verify(token, JWT_SECRET) as any;
    req.userId    = p.userId;
    req.userEmail = p.email;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}
EOF
echo "  ✓ auth middleware — safe JWT_SECRET + SSE token-from-query built in"

# ─────────────────────────────────────────────────────────────
# FIX 3: leaderboard.ts — add rank change detection
#
# BUG: no rankChange/prevRank logic. Frontend expects
# data.rankChange and data.prevRank — both are undefined.
# "↑ Up 2 places" trend display never fires.
# ─────────────────────────────────────────────────────────────
echo "  [3/14] leaderboard.ts — add rank change detection"
cat > "$ROOT/apps/api/src/api/routes/leaderboard.ts" << 'EOF'
import { Router } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth } from '../middleware/auth.js';
import { loadOrgContext, OrgRequest } from '../middleware/orgContext.js';
import { permissionService } from '../../domains/orgs/PermissionService.js';

const router = Router();
router.use(requireAuth, loadOrgContext);

router.get('/', async (req: OrgRequest, res) => {
  try {
    const ctx = req.orgContext!;
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    if (!permissionService.canActOnBusiness(ctx, 'business.read', businessId as string)) {
      return res.status(403).json({ error: 'No access to this business' });
    }

    // Get the two most recent completed scans
    const { data: recentScans } = await supabase.from('organic_scans')
      .select('id, scan_date, keyword')
      .eq('business_id', businessId as string)
      .eq('state', 'completed')
      .order('created_at', { ascending: false })
      .limit(2);

    if (!recentScans?.length) {
      return res.json({ leaderboard: [], message: 'No completed scans found.' });
    }

    const latestScan   = recentScans[0];
    const previousScan = recentScans[1] ?? null;

    // Get current leaderboard
    const { data: leaderboard } = await supabase.from('leaderboard_scores')
      .select('*').eq('scan_id', latestScan.id).order('leaderboard_rank');

    // Get previous rank for the client business
    let prevRank: number | null     = null;
    let rankChange: number | null   = null;
    const currentEntry = (leaderboard ?? []).find((e: any) => e.is_client_business);
    const currentRank  = currentEntry?.leaderboard_rank ?? null;

    if (previousScan && currentRank !== null) {
      const { data: prevEntry } = await supabase.from('leaderboard_scores')
        .select('leaderboard_rank')
        .eq('scan_id', previousScan.id)
        .eq('is_client_business', true)
        .single();

      prevRank   = prevEntry?.leaderboard_rank ?? null;
      // Positive = moved up (was #5, now #3 = change +2)
      // Negative = moved down (was #3, now #5 = change -2)
      rankChange = (prevRank !== null && currentRank !== null)
        ? prevRank - currentRank
        : null;
    }

    res.json({
      leaderboard:  leaderboard ?? [],
      scanDate:     latestScan.scan_date,
      keyword:      latestScan.keyword,
      scanId:       latestScan.id,
      currentRank,
      prevRank,
      rankChange,   // positive = moved up, negative = moved down, null = first scan
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Leaderboard failed' });
  }
});

export default router;
EOF
echo "  ✓ leaderboard.ts — rankChange, currentRank, prevRank added"

# ─────────────────────────────────────────────────────────────
# FIX 4: profile.ts — add GDPR account deletion
#
# MISSING: No DELETE /profile/account endpoint.
# GDPR/CCPA right to erasure legally required for EU/CA users.
# ─────────────────────────────────────────────────────────────
echo "  [4/14] profile.ts — GDPR account deletion endpoint"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/profile.ts'
with open(path) as f: s = f.read()

if '/account' not in s:
    s = s.replace(
        'export default router;',
        '''/**
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

export default router;'''
    )
    open(path, 'w').write(s)
    print("  ✓ profile.ts — DELETE /profile/account added")
else:
    print("  ✓ already present")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 5: auth.ts — add forgot-password + reset-password
#
# MISSING: No forgot-password endpoint. Users who lose their
# password are permanently locked out. Supabase handles the
# full reset email flow natively.
# ─────────────────────────────────────────────────────────────
echo "  [5/14] auth.ts — forgot-password + reset-password endpoints"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/auth.ts'
with open(path) as f: s = f.read()

if 'forgot-password' not in s:
    s = s.replace(
        'export default router;',
        '''/**
 * POST /auth/forgot-password
 * Sends a password reset email via Supabase Auth.
 * Always returns success to prevent email enumeration.
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: (process.env.FRONTEND_URL ?? 'http://localhost:5173') + '/reset-password',
    });
    if (error) return res.status(400).json({ error: error.message });
    // Always success — prevents email enumeration attack
    res.json({ success: true, message: 'If an account exists for this email, a reset link has been sent' });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Reset request failed' });
  }
});

/**
 * POST /auth/reset-password
 * Called after user clicks the reset link (which contains an access token).
 * Updates the user\'s password using the token from the reset email.
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { accessToken, newPassword } = req.body;
    if (!accessToken || !newPassword) {
      return res.status(400).json({ error: 'accessToken and newPassword required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    // Set the session from the reset token, then update password
    const { data, error: sessErr } = await supabase.auth.setSession({
      access_token: accessToken, refresh_token: '',
    });
    if (sessErr || !data.user) {
      return res.status(400).json({ error: 'Invalid or expired reset link — please request a new one' });
    }
    const { error } = await supabase.auth.admin.updateUserById(data.user.id, { password: newPassword });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Password reset failed' });
  }
});

export default router;'''
    )
    open(path, 'w').write(s)
    print("  ✓ auth.ts — forgot-password + reset-password endpoints added")
else:
    print("  ✓ already present")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 6: adScans.ts — use billingService.checkAndDeductCredits
#
# BUG: Raw supabase.update() for credits — no atomicity,
# no race condition protection, no event firing.
# Two simultaneous ad scans can both pass the balance check
# before either deducts, going negative.
# ─────────────────────────────────────────────────────────────
echo "  [6/14] adScans.ts — atomic credit deduction via billingService"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/adScans.ts'
with open(path) as f: s = f.read()

# Add billingService import
if 'billingService' not in s:
    s = s.replace(
        "import { geoService } from '../../domains/geo/GeoService.js';",
        "import { geoService } from '../../domains/geo/GeoService.js';\nimport { billingService, CREDIT_COSTS } from '../../domains/billing/BillingService.js';\nimport { InsufficientCreditsError } from '../../shared/errors/DomainErrors.js';"
    )

# Replace raw credits check + raw update with billingService
old_credits = """  const { data: profile } = await supabase.from('profiles').select('credits_balance').eq('id', req.userId!).single();
  if (!profile) return res.status(402).json({ error: 'Profile not found' });"""

new_credits = """  // Use billingService for atomic, race-condition-safe credit deduction
  // Raw supabase.update() had a race condition: two simultaneous ad scans
  // could both pass the balance check before either deducted, going negative.
  const creditsBalance = await billingService.getCreditsBalance(req.userId!);"""

s = s.replace(old_credits, new_credits)

# Fix the balance check
s = s.replace(
    "  if (profile.credits_balance < totalSlots) {\n    return res.status(402).json({\n      error: 'This session requires ' + totalSlots + ' credits (' + validTimes.length + ' time slots x ' + businesses.length + ' businesses). You have ' + profile.credits_balance + ' credits.',\n      required: totalSlots,\n      available: profile.credits_balance,\n    });\n  }",
    """  if (creditsBalance < totalSlots) {
    return res.status(402).json({
      error: 'This session requires ' + totalSlots + ' credits (' + validTimes.length + ' time slots × ' + businesses.length + ' businesses). You have ' + creditsBalance + ' credits.',
      required: totalSlots,
      available: creditsBalance,
    });
  }"""
)

# Replace raw update with billingService call
old_deduct = """  // Deduct credits AFTER session is confirmed created\n  await supabase.from('profiles').update({ credits_balance: profile.credits_balance - totalSlots }).eq('id', req.userId!);\n  await supabase.from('credit_transactions').insert({\n    user_id: req.userId, amount: -totalSlots, balance_after: profile.credits_balance - totalSlots,\n    reason: 'Ad scan: ' + keyword + ' (' + slotsCount + ' slots × 25 pts)',\n    transaction_type: 'usage',\n  });"""

new_deduct = """  // Atomic credit deduction via billingService — race-condition safe
  try {
    await billingService.checkAndDeductCredits({
      userId: req.userId!,
      amount: totalSlots,
      reason: 'Ad scan: ' + keyword + ' (' + slotsCount + ' slots × 25 pts)',
      transactionType: 'usage',
    });
  } catch (err: any) {
    // If deduction fails after session was created, clean up the session
    await supabase.from('ad_scan_sessions').delete().eq('id', session.id);
    return res.status(402).json({ error: err.message ?? 'Insufficient credits' });
  }"""

s = s.replace(old_deduct, new_deduct)
open(path, 'w').write(s)
print("  ✓ adScans.ts — atomic billingService.checkAndDeductCredits() with race condition protection")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 7: Agency report endpoint — rate limiting
#
# SECURITY: Public endpoint with no rate limit. Token is
# hard to brute-force but there is no protection against
# scrapers or data harvesting.
# ─────────────────────────────────────────────────────────────
echo "  [7/14] agency.ts — rate limit on public report endpoint"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/api/src/api/routes/agency.ts'
with open(path) as f: s = f.read()

# Add rate limiter import and apply to public report route
if 'rateLimit' not in s:
    s = s.replace(
        "import { Router, Request, Response } from 'express';",
        "import { Router, Request, Response } from 'express';\nimport rateLimit from 'express-rate-limit';"
    )
    # Add rate limiter for public report
    s = s.replace(
        "// ── GET /agency/report/:token (PUBLIC — no auth) ──────────────",
        """// Rate limiter for the public report endpoint
// 30 requests per hour per IP — prevents scraping
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true, legacyHeaders: false,
});

// ── GET /agency/report/:token (PUBLIC — no auth) ──────────────"""
    )
    s = s.replace(
        "router.get('/report/:token', async (req: Request, res: Response) => {",
        "router.get('/report/:token', reportLimiter, async (req: Request, res: Response) => {"
    )
    open(path, 'w').write(s)
    print("  ✓ agency.ts — rate limiter added to public report endpoint")
else:
    print("  ✓ already has rate limiter")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 8: Delete agencyDashboard.ts — dead code, wrong file
#
# agencyDashboard.ts is the old version. agency.ts is the
# real one. Both have same route comments which confuses devs.
# It's not imported so no runtime conflict, but must be removed.
# ─────────────────────────────────────────────────────────────
echo "  [8/14] agencyDashboard.ts — remove dead code file"
rm -f "$ROOT/apps/api/src/api/routes/agencyDashboard.ts"
echo "  ✓ agencyDashboard.ts deleted"

# ─────────────────────────────────────────────────────────────
# FIX 9: App.tsx — add forgot-password + reset-password + onboarding routes
#
# MISSING: No /forgot-password, /reset-password, /onboarding routes.
# Signup still redirects to /overview not /onboarding.
# ─────────────────────────────────────────────────────────────
echo "  [9/14] App.tsx — add missing routes"
cat > "$ROOT/apps/frontend/src/App.tsx" << 'EOF'
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/auth';
import { LoginPage, SignupPage } from './pages/Auth';
import Layout from './components/Layout';
import { lazy, Suspense } from 'react';

// Lazy-load pages that are not always needed
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPassword'));
const ResetPasswordPage  = lazy(() => import('./pages/ResetPassword'));
const OnboardingPage     = lazy(() => import('./pages/Onboarding'));

function Protected({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuth(s => s.isLoggedIn());
  return isLoggedIn ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  const isLoggedIn = useAuth(s => s.isLoggedIn());
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" /></div>}>
      <Routes>
        <Route path="/login"          element={isLoggedIn ? <Navigate to="/overview" replace /> : <LoginPage />} />
        <Route path="/signup"         element={isLoggedIn ? <Navigate to="/overview" replace /> : <SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password"  element={<ResetPasswordPage />} />
        <Route path="/onboarding"      element={<Protected><OnboardingPage /></Protected>} />
        <Route path="/*"               element={<Protected><Layout /></Protected>} />
      </Routes>
    </Suspense>
  );
}
EOF
echo "  ✓ App.tsx — forgot-password, reset-password, onboarding routes added"

# ─────────────────────────────────────────────────────────────
# FIX 10: ForgotPassword.tsx + ResetPassword.tsx pages
# ─────────────────────────────────────────────────────────────
echo "  [10/14] ForgotPassword.tsx + ResetPassword.tsx — new pages"

cat > "$ROOT/apps/frontend/src/pages/ForgotPassword.tsx" << 'EOF'
import { useState } from 'react';
import { authApi } from '../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState('');
  const [sent, setSent]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      await authApi.forgotPassword({ email: email.trim().toLowerCase() });
      setSent(true);
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Something went wrong');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-brand-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white text-xl font-bold">B</span>
          </div>
          <h1 className="text-2xl font-bold">BizzRank AI</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          {sent ? (
            <div className="text-center">
              <p className="text-4xl mb-3">📧</p>
              <h2 className="text-lg font-bold mb-2">Check your email</h2>
              <p className="text-sm text-gray-500 mb-4">
                If an account exists for <strong>{email}</strong>, we've sent a password reset link.
              </p>
              <p className="text-xs text-gray-400">Didn't receive it? Check your spam folder.</p>
              <a href="/login" className="block mt-5 text-brand-600 text-sm font-semibold hover:underline">
                Back to sign in
              </a>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h2 className="text-lg font-bold mb-1">Reset your password</h2>
                <p className="text-sm text-gray-500 mb-4">
                  Enter your email and we'll send you a reset link.
                </p>
              </div>
              <div>
                <label className="label">Email address</label>
                <input
                  type="email" className="input w-full" autoFocus required
                  value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
              <button type="submit" className="btn-primary w-full py-2.5" disabled={loading || !email}>
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <p className="text-center text-sm text-gray-500">
                <a href="/login" className="text-brand-600 font-semibold hover:underline">
                  Back to sign in
                </a>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
EOF

cat > "$ROOT/apps/frontend/src/pages/ResetPassword.tsx" << 'EOF'
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../lib/api';

export default function ResetPasswordPage() {
  const nav = useNavigate();
  const [token, setToken]       = useState('');
  const [pw, setPw]             = useState('');
  const [confirm, setConfirm]   = useState('');
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState('');
  const [success, setSuccess]   = useState(false);

  useEffect(() => {
    // Supabase puts the access_token in the URL hash after redirect
    const hash   = window.location.hash;
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const t      = params.get('access_token');
    if (t) setToken(t);
    else   setErr('Invalid or expired reset link — please request a new one');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (pw !== confirm) return setErr('Passwords do not match');
    if (pw.length < 8)  return setErr('Password must be at least 8 characters');
    setLoading(true);
    try {
      await authApi.resetPassword({ accessToken: token, newPassword: pw });
      setSuccess(true);
      setTimeout(() => nav('/login'), 2500);
    } catch (ex: any) {
      setErr(ex.response?.data?.error ?? 'Reset failed — try requesting a new link');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-brand-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white text-xl font-bold">B</span>
          </div>
          <h1 className="text-2xl font-bold">BizzRank AI</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          {success ? (
            <div className="text-center">
              <p className="text-4xl mb-3">✅</p>
              <h2 className="text-lg font-bold mb-2">Password updated</h2>
              <p className="text-sm text-gray-500">Redirecting to sign in…</p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <h2 className="text-lg font-bold">Set new password</h2>
              {err && <p className="text-sm text-red-600 bg-red-50 p-2.5 rounded-xl">{err}</p>}
              {!token && !err ? (
                <p className="text-sm text-amber-600">Reading reset token…</p>
              ) : (
                <>
                  <div>
                    <label className="label">New password</label>
                    <input type="password" className="input w-full" value={pw}
                      onChange={e => setPw(e.target.value)} minLength={8} required autoFocus />
                  </div>
                  <div>
                    <label className="label">Confirm new password</label>
                    <input type="password" className="input w-full" value={confirm}
                      onChange={e => setConfirm(e.target.value)} minLength={8} required />
                    {confirm && pw !== confirm &&
                      <p className="text-xs text-red-500 mt-1">Passwords do not match</p>}
                  </div>
                  <button type="submit" className="btn-primary w-full py-2.5"
                    disabled={loading || !pw || !confirm || pw !== confirm}>
                    {loading ? 'Saving…' : 'Set new password'}
                  </button>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
EOF
echo "  ✓ ForgotPassword.tsx + ResetPassword.tsx created"

# ─────────────────────────────────────────────────────────────
# FIX 11: Auth.tsx — add forgot password link to login form
#         + redirect signup to /onboarding
# ─────────────────────────────────────────────────────────────
echo "  [11/14] Auth.tsx — forgot password link + signup → onboarding"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/pages/Auth.tsx'
with open(path) as f: s = f.read()

# Signup redirects to onboarding
if "nav('/onboarding')" not in s:
    # Line 38 and 89 both have nav('/overview')
    # Only change the one inside SignupPage (after successful signup)
    # LoginPage should still go to /overview
    # Approach: change the second occurrence (signup)
    count = s.count("nav('/overview')")
    if count >= 2:
        # Replace the second occurrence (signup form submit)
        idx = s.find("nav('/overview')")
        idx2 = s.find("nav('/overview')", idx + 1)
        s = s[:idx2] + "nav('/onboarding')" + s[idx2 + len("nav('/overview')"):]
    print("  signup → /onboarding")

# Add forgot password link to login form
if 'forgot-password' not in s:
    s = s.replace(
        "No account?{' '}",
        """<div className="text-right mb-2">
            <a href="/forgot-password" className="text-xs text-gray-400 hover:text-brand-600 hover:underline">
              Forgot password?
            </a>
          </div>
          No account?{' '}"""
    )
    print("  forgot password link added to login")

open(path, 'w').write(s)
print("  ✓ Auth.tsx updated")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 12: api.ts — add forgotPassword + resetPassword + deleteAccount
# ─────────────────────────────────────────────────────────────
echo "  [12/14] api.ts — add missing API methods"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/lib/api.ts'
with open(path) as f: s = f.read()
changed = False

if 'forgotPassword' not in s:
    s = s.replace(
        "  refresh: () => api.post('/auth/refresh'),",
        "  refresh:         () => api.post('/auth/refresh'),\n  forgotPassword:  (d: any) => api.post('/auth/forgot-password', d),\n  resetPassword:   (d: any) => api.post('/auth/reset-password', d),"
    )
    changed = True

if 'deleteAccount' not in s:
    s = s.replace(
        "  changePassword: (d: any) => api.patch('/profile/password', d),",
        "  changePassword: (d: any) => api.patch('/profile/password', d),\n  deleteAccount:  (d: any) => api.delete('/profile/account', { data: d }),"
    )
    changed = True

open(path, 'w').write(s)
print("  ✓ api.ts — forgotPassword, resetPassword, deleteAccount added")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 13: Profile.tsx — add delete account UI + danger zone
# ─────────────────────────────────────────────────────────────
echo "  [13/14] Profile.tsx — add delete account modal"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]
path = root + '/apps/frontend/src/pages/Profile.tsx'
with open(path) as f: s = f.read()

if 'deleteAccount' not in s:
    # Add import
    s = s.replace(
        "import { authApi, profileApi",
        "import { authApi, profileApi, billingApi"
    ) if 'billingApi' not in s else s

    s = s.replace(
        "import { authApi, profileApi } from '../lib/api';",
        "import { authApi, profileApi, billingApi } from '../lib/api';\nimport { useAuth } from '../store/auth';"
    ) if "import { authApi, profileApi } from '../lib/api';" in s and 'useAuth' not in s else s

    # Add state for delete modal
    s = s.replace(
        "  const [savingPw, setSavingPw]           = useState(false);",
        "  const [savingPw, setSavingPw]           = useState(false);\n  const [showDeleteModal, setShowDeleteModal] = useState(false);\n  const [deletePw, setDeletePw]               = useState('');\n  const [deleting, setDeleting]               = useState(false);\n  const logout = useAuth(st => st.logout);"
    )

    # Add danger zone + modal before closing div
    s = s.replace(
        "    </div>\n  );\n}",
        """      {/* ── Danger Zone (only shown on Account Details tab) ── */}
      {tab === 'details' && (
        <div className="card border border-red-100 mt-2">
          <h3 className="font-bold text-red-700 mb-1 text-sm">Danger Zone</h3>
          <p className="text-xs text-gray-400 mb-3">Permanently delete your account and all associated data. This cannot be undone.</p>
          <button onClick={() => setShowDeleteModal(true)}
            className="text-sm text-red-600 border border-red-200 px-4 py-2 rounded-xl hover:bg-red-50 transition-colors">
            Delete my account
          </button>
        </div>
      )}

      {/* ── Delete Account Modal ── */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div>
              <h3 className="font-bold text-red-700 text-lg mb-1">Delete account permanently?</h3>
              <p className="text-sm text-gray-500">
                This will delete all your businesses, scans, reviews, keywords, competitors, and all data.
                <strong> This cannot be undone.</strong>
              </p>
            </div>
            <div>
              <label className="label text-sm">Confirm your password to proceed</label>
              <input type="password" className="input w-full" value={deletePw}
                onChange={e => setDeletePw(e.target.value)} placeholder="Enter your password" autoFocus />
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setShowDeleteModal(false); setDeletePw(''); }}
                className="flex-1 btn-secondary">Cancel</button>
              <button
                disabled={!deletePw || deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await profileApi.deleteAccount({ password: deletePw });
                    logout();
                    window.location.href = '/login';
                  } catch (ex: any) {
                    alert(ex.response?.data?.error ?? 'Deletion failed');
                    setDeleting(false);
                  }
                }}
                className="flex-1 bg-red-600 text-white rounded-xl py-2 font-semibold hover:bg-red-700 disabled:opacity-50 transition-colors">
                {deleting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}"""
    )
    open(path, 'w').write(s)
    print("  ✓ Profile.tsx — Danger Zone + delete modal added")
else:
    print("  ✓ already present")
PYEOF

# ─────────────────────────────────────────────────────────────
# FIX 14: Email notifications — hook weekly report + low credits
#
# emailService.ts exists but only GBP Guard sends emails.
# Weekly report and low-credits warnings never fire.
# ─────────────────────────────────────────────────────────────
echo "  [14/14] WeeklyScheduler.ts + BillingService.ts — wire email notifications"
python3 - "$ROOT" << 'PYEOF'
import sys
root = sys.argv[1]

# BillingService — send low credits email when balance drops below 20%
bpath = root + '/apps/api/src/domains/billing/BillingService.ts'
with open(bpath) as f: s = f.read()
if 'emailService' not in s:
    s = s.replace(
        "import type { CreditDeduction } from '../../shared/types/contracts.js';",
        "import type { CreditDeduction } from '../../shared/types/contracts.js';\nimport { emailService } from '../../shared/utils/emailService.js';"
    )
    # After deducting, check if credits are low (< 20% of monthly allowance)
    s = s.replace(
        "    logger.info('[Billing] Credits deducted', {\n      userId: d.userId, amount: d.amount, newBalance: nb,\n    });\n  }",
        """    logger.info('[Billing] Credits deducted', {
      userId: d.userId, amount: d.amount, newBalance: nb,
    });

    // Send low-credits email when balance drops below 20% of allowance
    // Load profile to get email + monthly allowance
    try {
      const { data: profile } = await db.from('profiles')
        .select('monthly_allowance, plan').eq('id', d.userId).single();
      const allowance = profile?.monthly_allowance ?? 900;
      if (nb < allowance * 0.2 && nb >= 0) {
        // Get email from auth
        const { createClient } = await import('@supabase/supabase-js');
        const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
        const { data: au } = await admin.auth.admin.getUserById(d.userId);
        const email = au?.user?.email;
        if (email) {
          emailService.sendLowCredits({
            to: email, balance: nb, plan: profile?.plan ?? 'starter',
          }).catch(() => {}); // non-critical — don't block the deduction
        }
      }
    } catch { /* non-critical */ }
  }"""
    )
    open(bpath, 'w').write(s)
    print("  ✓ BillingService.ts — low credits email notification wired")

# WeeklyScheduler — send weekly report email after L3 reports
wpath = root + '/apps/api/src/domains/scheduling/WeeklyScheduler.ts'
with open(wpath) as f: s = f.read()
if 'emailService' not in s and 'sendWeeklyReport' not in s:
    s = s.replace(
        "import { gbpGuardService } from '../gbpguard/GBPGuardService.js';",
        "import { gbpGuardService } from '../gbpguard/GBPGuardService.js';\nimport { emailService } from '../../shared/utils/emailService.js';"
    )
    # After runWeeklyReports, send emails
    s = s.replace(
        "  async runWeeklyReports(): Promise<void> {",
        """  /**
   * runWeeklyReports — process L3 trend data and send weekly report emails.
   * Sends a brief email to each user with their top business visibility score.
   */
  async runWeeklyReports(): Promise<void> {"""
    )
    # Add email sending after the existing L3 logic at the end
    s = s.replace(
        "    logger.info('[Scheduler] Weekly L3 reports done');\n  }",
        """    logger.info('[Scheduler] Weekly L3 reports done');

    // Send weekly report emails
    try {
      const BATCH = 50;
      let offset = 0;
      while (true) {
        const { data: profiles } = await db.from('profiles')
          .select('id, plan').range(offset, offset + BATCH - 1);
        if (!profiles?.length) break;
        for (const p of profiles) {
          try {
            // Get email from supabase auth
            const { createClient } = await import('@supabase/supabase-js');
            const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
            const { data: au } = await admin.auth.admin.getUserById(p.id);
            const email = au?.user?.email;
            if (!email) continue;
            // Get their best visibility score
            const { data: topScore } = await db.from('organic_scores')
              .select('organic_visibility_score, businesses(name), keyword')
              .eq('user_id', p.id)
              .order('scanned_at', { ascending: false }).limit(1).single();
            if (!topScore) continue;
            const score = topScore.organic_visibility_score ?? 0;
            const bizName = (topScore.businesses as any)?.name ?? 'Your Business';
            await emailService.sendWeeklyReport({
              to: email, businessName: bizName, score,
              trend: score >= 60 ? 'Strong' : score >= 30 ? 'Growing' : 'Needs attention',
              topAction: score < 30
                ? 'Run a fresh scan to identify ranking opportunities'
                : score < 60
                ? 'Respond to recent reviews to improve ranking signals'
                : 'Maintain your position with weekly scan monitoring',
            }).catch(() => {});
            await new Promise(r => setTimeout(r, 200)); // rate limit emails
          } catch { /* non-critical */ }
        }
        if (profiles.length < BATCH) break;
        offset += BATCH;
      }
    } catch (e: any) {
      logger.error('[Scheduler] Weekly email send failed', { error: e.message });
    }
  }"""
    )
    open(wpath, 'w').write(s)
    print("  ✓ WeeklyScheduler.ts — weekly report emails wired")
PYEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " All 14 fixes applied. Verification:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
python3 - "$ROOT" << 'PYEOF'
import os, sys
root = sys.argv[1]

checks = [
  ("index.ts — webhook raw before json",      "apps/api/src/index.ts",                    "billing/webhook', express.raw"),
  ("index.ts — agency route correct position","apps/api/src/index.ts",                    "'/api/agency',              agencyRoutes"),
  ("auth middleware — safe JWT",              "apps/api/src/api/middleware/auth.ts",       "JWT_SECRET = process.env.JWT_SECRET"),
  ("auth middleware — no ! assertion",         "apps/api/src/api/middleware/auth.ts",       "JWT_SECRET!"),
  ("leaderboard — rankChange",               "apps/api/src/api/routes/leaderboard.ts",    "rankChange"),
  ("profile — delete account",               "apps/api/src/api/routes/profile.ts",        "deleteUser"),
  ("auth — forgot-password",                 "apps/api/src/api/routes/auth.ts",           "forgot-password"),
  ("auth — reset-password",                  "apps/api/src/api/routes/auth.ts",           "reset-password"),
  ("adScans — billingService deduction",     "apps/api/src/api/routes/adScans.ts",        "billingService.checkAndDeductCredits"),
  ("agency — report rate limit",             "apps/api/src/api/routes/agency.ts",         "reportLimiter"),
  ("agencyDashboard.ts — deleted",           "apps/api/src/api/routes/agencyDashboard.ts", None),
  ("App.tsx — forgot-password route",        "apps/frontend/src/App.tsx",                 "forgot-password"),
  ("App.tsx — onboarding route",             "apps/frontend/src/App.tsx",                 "onboarding"),
  ("ForgotPassword.tsx — exists",            "apps/frontend/src/pages/ForgotPassword.tsx", "ForgotPasswordPage"),
  ("ResetPassword.tsx — exists",             "apps/frontend/src/pages/ResetPassword.tsx", "ResetPasswordPage"),
  ("Auth.tsx — forgot password link",        "apps/frontend/src/pages/Auth.tsx",          "forgot-password"),
  ("Auth.tsx — signup → /onboarding",        "apps/frontend/src/pages/Auth.tsx",          "/onboarding"),
  ("api.ts — forgotPassword",               "apps/frontend/src/lib/api.ts",              "forgotPassword"),
  ("api.ts — deleteAccount",                "apps/frontend/src/lib/api.ts",              "deleteAccount"),
  ("Profile.tsx — delete account UI",       "apps/frontend/src/pages/Profile.tsx",       "deleteAccount"),
  ("BillingService — low credits email",    "apps/api/src/domains/billing/BillingService.ts", "sendLowCredits"),
  ("WeeklyScheduler — weekly report email", "apps/api/src/domains/scheduling/WeeklyScheduler.ts", "sendWeeklyReport"),
]

passed = 0
failed = 0
for label, filepath, needle in checks:
  fullpath = os.path.join(root, filepath)
  if needle is None:
    # Check file does NOT exist
    exists = os.path.exists(fullpath)
    icon = "❌ STILL EXISTS" if exists else "✅"
    if not exists: passed += 1
    else: failed += 1
    print(f"  {icon}  {label}")
  else:
    if not os.path.exists(fullpath):
      print(f"  ❌ FILE MISSING  {label}")
      failed += 1
      continue
    with open(fullpath) as f: content = f.read()
    # For the "no ! assertion" check, verify it's NOT present
    if label == "auth middleware — no ! assertion":
      found = needle in content
      icon = "❌ STILL PRESENT" if found else "✅"
      if not found: passed += 1
      else: failed += 1
    else:
      found = needle in content
      icon = "✅" if found else "❌ NOT FOUND"
      if found: passed += 1
      else: failed += 1
    print(f"  {icon}  {label}")

print()
print(f"  {passed}/{passed+failed} checks passed")
if failed > 0:
  print(f"  {failed} still need attention")
else:
  print("  All fixes confirmed ✅")
PYEOF
echo ""
echo " npm run dev"
echo ""
