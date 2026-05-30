/**
 * Billing Route — Stripe Checkout + Webhook + Customer Portal
 *
 * Endpoints:
 *   POST /billing/checkout         → create Stripe Checkout session
 *   POST /billing/webhook          → Stripe webhook (plan updates)
 *   POST /billing/portal           → Stripe Customer Portal link
 *   GET  /billing/status           → current subscription status
 */
import { Router } from 'express';
import Stripe from 'stripe';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { PLANS } from '../../domains/billing/BillingService.js';
import express from 'express';

const router = Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' })
  : null;

// Stripe Price IDs — set in .env
const PRICE_IDS: Record<string, string> = {
  growth:  process.env.STRIPE_PRICE_GROWTH  ?? '',
  pro:     process.env.STRIPE_PRICE_PRO     ?? '',
  agency:  process.env.STRIPE_PRICE_AGENCY  ?? '',
};

// GET /billing/status
router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  const { data: profile } = await supabase
    .from('profiles').select('plan, credits_balance, stripe_customer_id').eq('id', req.userId!).single();
  res.json({
    plan:              profile?.plan ?? 'starter',
    credits:           profile?.credits_balance ?? 0,
    stripeConfigured:  !!stripe,
    canUpgrade:        !!stripe && Object.values(PRICE_IDS).some(Boolean),
  });
});

// POST /billing/checkout — create Stripe Checkout session
router.post('/checkout', requireAuth, async (req: AuthRequest, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured — add STRIPE_SECRET_KEY to .env' });
  const { plan } = req.body;
  if (!PRICE_IDS[plan]) return res.status(400).json({ error: 'Invalid plan or price not configured' });

  const { data: profile } = await supabase
    .from('profiles').select('email, stripe_customer_id').eq('id', req.userId!).single();

  // Reuse existing Stripe customer or create new one
  let customerId = profile?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile?.email ?? '',
      metadata: { userId: req.userId! },
    });
    customerId = customer.id;
    await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', req.userId!);
  }

  const session = await stripe.checkout.sessions.create({
    customer:             customerId,
    mode:                 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/profile?upgraded=1`,
    cancel_url:  `${process.env.FRONTEND_URL}/profile?cancelled=1`,
    metadata:    { userId: req.userId!, plan },
    subscription_data: {
      metadata: { userId: req.userId!, plan },
    },
  });

  res.json({ url: session.url });
});

// POST /billing/portal — Stripe Customer Portal for self-service
router.post('/portal', requireAuth, async (req: AuthRequest, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const { data: profile } = await supabase
    .from('profiles').select('stripe_customer_id').eq('id', req.userId!).single();
  if (!profile?.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer:   profile.stripe_customer_id,
    return_url: `${process.env.FRONTEND_URL}/profile`,
  });

  res.json({ url: session.url });
});

// POST /billing/webhook — Stripe sends events here
// IMPORTANT: Mount with express.raw() body parser (see index.ts)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured');

  const sig = req.headers['stripe-signature'] as string;
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err: any) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Helper: update profile plan + credits when subscription changes
  async function syncSubscription(subscription: Stripe.Subscription) {
    const userId = subscription.metadata?.userId;
    const plan   = subscription.metadata?.plan;
    if (!userId || !plan || !PLANS[plan]) return;

    const planConfig = PLANS[plan];
    const isActive = ['active', 'trialing'].includes(subscription.status);

    await supabase.from('profiles').update({
      plan:              isActive ? plan : 'starter',
      credits_balance:   isActive ? planConfig.credits : PLANS.starter.credits,
      monthly_allowance: isActive ? planConfig.credits : PLANS.starter.credits,
      updated_at:        new Date().toISOString(),
    }).eq('id', userId);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      // Subscription started — sync plan immediately
      const session = event.data.object as Stripe.CheckoutSession;
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await syncSubscription(sub);
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await syncSubscription(event.data.object as Stripe.Subscription);
      break;
    }
    case 'invoice.payment_failed': {
      // Optional: log failed payment, could send email notification here
      const invoice = event.data.object as Stripe.Invoice;
      console.warn('[Stripe] Payment failed:', invoice.customer_email);
      break;
    }
  }

  res.json({ received: true });
});

export default router;
