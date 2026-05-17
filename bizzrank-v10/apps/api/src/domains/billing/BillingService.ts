/**
 * Billing Domain
 * Owns ALL credit and plan logic.
 * No other domain touches credits directly.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { eventBus, Events } from '../../infrastructure/events/EventBus.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import { InsufficientCreditsError } from '../../shared/errors/DomainErrors.js';
import type { PlanName, CreditDeduction } from '../../shared/types/contracts.js';

export interface PlanConfig {
  name: PlanName;
  displayName: string;
  priceMonthly: number;
  credits: number;
  maxBusinesses: number;
  maxCompetitorsPerLocation: number;
}

export const PLANS: Record<PlanName, PlanConfig> = {
  starter:      { name: 'starter',      displayName: 'Starter',     priceMonthly: 149,  credits: 100,   maxBusinesses: 1,   maxCompetitorsPerLocation: 3 },
  professional: { name: 'professional', displayName: 'Pro',         priceMonthly: 249,  credits: 300,   maxBusinesses: 5,   maxCompetitorsPerLocation: 5 },
  agency:       { name: 'agency',       displayName: 'Agency',      priceMonthly: 599,  credits: 2000,  maxBusinesses: 999, maxCompetitorsPerLocation: 10 },
  enterprise:   { name: 'enterprise',   displayName: 'Enterprise',  priceMonthly: 999,  credits: 10000, maxBusinesses: 999, maxCompetitorsPerLocation: 999 },
};

export class BillingService {
  getPlan(planName: string): PlanConfig {
    return PLANS[planName as PlanName] ?? PLANS.starter;
  }

  async getCreditsBalance(userId: string): Promise<number> {
    const { data } = await db.from('profiles').select('credits_balance').eq('id', userId).single();
    return data?.credits_balance ?? 0;
  }

  async checkAndDeductCredits(deduction: CreditDeduction): Promise<void> {
    const balance = await this.getCreditsBalance(deduction.userId);

    if (balance < deduction.amount) {
      throw new InsufficientCreditsError(deduction.amount, balance);
    }

    const newBalance = balance - deduction.amount;

    const { error } = await db.from('profiles')
      .update({ credits_balance: newBalance })
      .eq('id', deduction.userId);

    if (error) throw new Error('Failed to deduct credits: ' + error.message);

    await db.from('credit_transactions').insert({
      user_id: deduction.userId,
      amount: -deduction.amount,
      balance_after: newBalance,
      reason: deduction.reason,
      transaction_type: deduction.transactionType,
    });

    eventBus.publish(Events.CREDITS_DEDUCTED, { userId: deduction.userId, amount: deduction.amount, newBalance });
    logger.info('[Billing] Credits deducted', { userId: deduction.userId, amount: deduction.amount, newBalance });
  }

  async getCreditHistory(userId: string, limit: number = 50): Promise<any[]> {
    const { data } = await db.from('credit_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  }
}

export const billingService = new BillingService();
