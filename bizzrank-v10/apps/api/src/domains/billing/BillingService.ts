import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { InsufficientCreditsError } from '../../shared/errors/DomainErrors.js';
import type { CreditDeduction } from '../../shared/types/contracts.js';

export interface PlanConfig {
  name: string; displayName: string; priceMonthly: number;
  credits: number; maxBusinesses: number;
  maxCompetitorsPerLocation: number; maxKeywords: number;
  hasAiReplies: boolean; hasAutoPost: boolean;
  hasAdPressure: boolean; hasCitations: boolean;
  hasWhiteLabel: boolean; hasTeam: boolean;
  hasReviewIntelligence: boolean; hasL3Reports: boolean;
  citationAuditsPerMonth: number;
}

export const PLANS: Record<string, PlanConfig> = {
  starter:      { name:'starter',      displayName:'Starter',     priceMonthly:49,   credits:900,   maxBusinesses:1,   maxCompetitorsPerLocation:1, maxKeywords:1, hasAiReplies:true  },
  growth:       { name:'growth',       displayName:'Growth',      priceMonthly:119,  credits:1600,  maxBusinesses:1,   maxCompetitorsPerLocation:2, maxKeywords:2, hasAiReplies:true  },
  pro:          { name:'pro',          displayName:'Pro',         priceMonthly:199,  credits:1800,  maxBusinesses:2,   maxCompetitorsPerLocation:3, maxKeywords:3, hasAiReplies:true  },
  agency:       { name:'agency',       displayName:'Agency',      priceMonthly:499,  credits:3500,  maxBusinesses:5,   maxCompetitorsPerLocation:4, maxKeywords:4, hasAiReplies:true  },
  enterprise:   { name:'enterprise',   displayName:'Enterprise',  priceMonthly:0,    credits:99999, maxBusinesses:999, maxCompetitorsPerLocation:999, maxKeywords:999, hasAiReplies:true },
  professional: { name:'professional', displayName:'Pro',         priceMonthly:199,  credits:1800,  maxBusinesses:5,   maxCompetitorsPerLocation:5, maxKeywords:3, hasAiReplies:true  },
};

export function getPlan(n: string): PlanConfig        { return PLANS[n] ?? PLANS.starter; }
export function businessLimit(n: string): number       { return getPlan(n).maxBusinesses; }
export function competitorLimit(n: string): number     { return getPlan(n).maxCompetitorsPerLocation; }
export function keywordLimit(n: string): number        { return getPlan(n).maxKeywords; }
export function canUseAiReplies(n: string): boolean    { return getPlan(n).hasAiReplies; }
export function canAutoPost(n: string): boolean        { return getPlan(n).hasAutoPost; }

export const CREDIT_COSTS = { MANUAL_SCAN: 25, AI_REPLY: 1 } as const;

export class BillingService {
  getPlan(n: string): PlanConfig { return getPlan(n); }

  async getCreditsBalance(userId: string): Promise<number> {
    const { data } = await db.from('profiles').select('credits_balance').eq('id', userId).single();
    return data?.credits_balance ?? 0;
  }

  async checkAndDeductCredits(d: CreditDeduction): Promise<void> {
    const bal = await this.getCreditsBalance(d.userId);
    if (bal < d.amount) throw new InsufficientCreditsError(d.amount, bal);
    const nb = bal - d.amount;
    const { error } = await db.from('profiles').update({ credits_balance: nb }).eq('id', d.userId);
    if (error) throw new Error('Failed to deduct credits: ' + error.message);
    await db.from('credit_transactions').insert({
      user_id: d.userId, amount: -d.amount, balance_after: nb,
      reason: d.reason, transaction_type: d.transactionType,
    });
    eventBus.publish(Events.CREDITS_DEDUCTED, { userId: d.userId, amount: d.amount, newBalance: nb });
    logger.info('[Billing] Credits deducted', { userId: d.userId, amount: d.amount, newBalance: nb });
  }

  async getCreditHistory(userId: string, limit = 50): Promise<any[]> {
    const { data } = await db.from('credit_transactions')
      .select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    return data ?? [];
  }

  async resetMonthlyCredits(): Promise<void> {
    const { data: profiles } = await db.from('profiles').select('id, plan');
    if (!profiles?.length) return;
    for (const p of profiles) {
      const plan = getPlan(p.plan);
      if (plan.credits === 99999) continue;
      await db.from('profiles').update({ credits_balance: plan.credits }).eq('id', p.id);
      await db.from('credit_transactions').insert({
        user_id: p.id, amount: plan.credits, balance_after: plan.credits,
        reason: 'Monthly credit reset', transaction_type: 'monthly_reset',
      });
    }
    logger.info('[Billing] Monthly reset complete', { count: profiles.length });
  }
}

export const billingService = new BillingService();
