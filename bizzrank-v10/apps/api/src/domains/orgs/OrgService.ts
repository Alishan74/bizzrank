/**
 * Org domain.
 * Owns organization lifecycle: create, member management, invitations,
 * role updates, business assignment, credit budget allocation.
 *
 * All authorization happens here OR in PermissionService — routes
 * should never make decisions about who can do what directly.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import { logger } from '../../infrastructure/logger/Logger.js';
import type {
  AssignableRole, OrgInvitation, OrgMember, OrgRole, Organization,
} from '../../shared/types/rbac.js';

export class OrgService {
  // ─────────────────────────────────────────────────────────
  // ORG CRUD
  // ─────────────────────────────────────────────────────────

  /**
   * Create a brand new org and make the user its owner.
   * Called on signup (every new user gets their own personal org)
   * and from the admin dashboard if a user wants a second org.
   */
  async createOrg(userId: string, name: string, plan = 'starter'): Promise<Organization> {
    const planConfig = this.planDefaults(plan);

    const { data: org, error } = await db.from('organizations').insert({
      name,
      plan,
      credits_pool: planConfig.credits,
      monthly_allowance: planConfig.credits,
      max_businesses: planConfig.maxBusinesses,
      max_users: planConfig.maxUsers,
      owner_user_id: userId,
    }).select().single();
    if (error || !org) throw new Error('Failed to create org: ' + (error?.message ?? 'unknown'));

    // Make the creator the owner member
    await db.from('org_members').insert({
      org_id: org.id,
      user_id: userId,
      role: 'owner',
    });

    logger.info('[Orgs] Created', { orgId: org.id, ownerUserId: userId, plan });
    return org as Organization;
  }

  async getOrg(orgId: string): Promise<Organization | null> {
    const { data } = await db.from('organizations').select('*').eq('id', orgId).single();
    return (data as Organization) ?? null;
  }

  /** Update plan and recalculate limits from defaults. */
  async updateOrgPlan(orgId: string, plan: string): Promise<void> {
    const planConfig = this.planDefaults(plan);
    await db.from('organizations').update({
      plan,
      credits_pool: planConfig.credits,
      monthly_allowance: planConfig.credits,
      max_businesses: planConfig.maxBusinesses,
      max_users: planConfig.maxUsers,
      updated_at: new Date().toISOString(),
    }).eq('id', orgId);
  }

  // ─────────────────────────────────────────────────────────
  // MEMBERS
  // ─────────────────────────────────────────────────────────

  async listMembers(orgId: string): Promise<OrgMember[]> {
    const { data } = await db.from('org_members').select('*').eq('org_id', orgId).order('created_at');
    return (data as OrgMember[]) ?? [];
  }

  async getMember(orgId: string, userId: string): Promise<OrgMember | null> {
    const { data } = await db.from('org_members').select('*')
      .eq('org_id', orgId).eq('user_id', userId).single();
    return (data as OrgMember) ?? null;
  }

  /**
   * Change a member's role. Cannot change the owner.
   * Throws if the target is the owner.
   */
  async updateMemberRole(orgId: string, userId: string, newRole: AssignableRole): Promise<void> {
    const member = await this.getMember(orgId, userId);
    if (!member) throw new Error('Member not found');
    if (member.role === 'owner') throw new Error('Cannot change the owner role');

    await db.from('org_members').update({ role: newRole })
      .eq('org_id', orgId).eq('user_id', userId);

    logger.info('[Orgs] Role changed', { orgId, userId, newRole });
  }

  /**
   * Set per-user monthly credit budget.
   * 0 = no individual cap (uses the org pool directly).
   */
  async setMemberBudget(orgId: string, userId: string, budget: number): Promise<void> {
    await db.from('org_members').update({ monthly_credit_budget: Math.max(0, budget) })
      .eq('org_id', orgId).eq('user_id', userId);
  }

  /**
   * Remove a member. Cannot remove the owner.
   * Also revokes all business access for this user in this org.
   */
  async removeMember(orgId: string, userId: string): Promise<void> {
    const member = await this.getMember(orgId, userId);
    if (!member) throw new Error('Member not found');
    if (member.role === 'owner') throw new Error('Cannot remove the owner');

    await db.from('business_user_access').delete()
      .eq('org_id', orgId).eq('user_id', userId);
    await db.from('org_members').delete()
      .eq('org_id', orgId).eq('user_id', userId);

    logger.info('[Orgs] Member removed', { orgId, userId });
  }

  /**
   * Admin-side password reset for a member.
   * Caller MUST verify the caller is owner before invoking this.
   * Uses Supabase admin API to set a new password directly.
   */
  async resetMemberPassword(targetUserId: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw new Error('Password must be at least 8 characters');
    const { error } = await db.auth.admin.updateUserById(targetUserId, { password: newPassword });
    if (error) throw new Error('Password reset failed: ' + error.message);
    logger.info('[Orgs] Member password reset', { targetUserId });
  }

  // ─────────────────────────────────────────────────────────
  // INVITATIONS
  // ─────────────────────────────────────────────────────────

  /**
   * Create an invitation. Returns the row (token included).
   * The invite link your frontend constructs:
   *   `${FRONTEND_URL}/invite/accept?token=${invitation.token}`
   */
  async createInvitation(
    orgId: string, email: string, role: AssignableRole, invitedBy: string,
  ): Promise<OrgInvitation> {
    // Org user-cap check
    const [{ count: memberCount }, { data: org }] = await Promise.all([
      db.from('org_members').select('*', { count: 'exact', head: true }).eq('org_id', orgId),
      db.from('organizations').select('max_users').eq('id', orgId).single() as any,
    ]);
    if (org && memberCount != null && memberCount >= org.max_users) {
      throw new Error('User limit reached for this plan');
    }

    // Don't duplicate pending invites
    const { data: existing } = await db.from('org_invitations').select('id')
      .eq('org_id', orgId).eq('email', email.toLowerCase().trim()).is('accepted_at', null).single();
    if (existing) throw new Error('A pending invitation already exists for this email');

    const { data, error } = await db.from('org_invitations').insert({
      org_id: orgId,
      email: email.toLowerCase().trim(),
      role,
      invited_by: invitedBy,
    }).select().single();
    if (error || !data) throw new Error('Invite creation failed: ' + (error?.message ?? 'unknown'));

    logger.info('[Orgs] Invitation created', { orgId, email, role });
    return data as OrgInvitation;
  }

  /** Look up an unaccepted, unexpired invitation by token. */
  async getInvitationByToken(token: string): Promise<OrgInvitation | null> {
    const { data } = await db.from('org_invitations').select('*').eq('token', token).single();
    if (!data) return null;
    const inv = data as OrgInvitation;
    if (inv.accepted_at) return null;
    if (new Date(inv.expires_at) < new Date()) return null;
    return inv;
  }

  /**
   * Accept an invitation: creates the org_members row and marks the invite used.
   * Called from /api/auth/accept-invite — the user must already exist in Supabase Auth
   * (the frontend should require signup/login before accepting).
   */
  async acceptInvitation(token: string, acceptingUserId: string): Promise<OrgMember> {
    const inv = await this.getInvitationByToken(token);
    if (!inv) throw new Error('Invalid or expired invitation');

    // Don't re-add if already a member
    const existing = await this.getMember(inv.org_id, acceptingUserId);
    if (existing) {
      await db.from('org_invitations').update({ accepted_at: new Date().toISOString() }).eq('id', inv.id);
      return existing;
    }

    const { data: member, error } = await db.from('org_members').insert({
      org_id: inv.org_id,
      user_id: acceptingUserId,
      role: inv.role,
      invited_by: inv.invited_by,
    }).select().single();
    if (error || !member) throw new Error('Could not add member: ' + (error?.message ?? 'unknown'));

    await db.from('org_invitations').update({ accepted_at: new Date().toISOString() }).eq('id', inv.id);

    logger.info('[Orgs] Invitation accepted', { orgId: inv.org_id, userId: acceptingUserId });
    return member as OrgMember;
  }

  // ─────────────────────────────────────────────────────────
  // BUSINESS ACCESS
  // ─────────────────────────────────────────────────────────

  /** Give a user explicit access to a specific business in their org. */
  async grantBusinessAccess(
    orgId: string, businessId: string, userId: string, grantedBy: string,
  ): Promise<void> {
    // Belt-and-suspenders: verify the user is actually a member of this org
    const member = await this.getMember(orgId, userId);
    if (!member) throw new Error('User is not a member of this org');

    // Verify the business belongs to this org
    const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', businessId).single();
    if (!biz || biz.org_id !== orgId) throw new Error('Business does not belong to this org');

    const { error } = await db.from('business_user_access').upsert({
      business_id: businessId,
      user_id: userId,
      org_id: orgId,
      granted_by: grantedBy,
    }, { onConflict: 'business_id,user_id' });
    if (error) throw new Error('Grant failed: ' + error.message);

    logger.info('[Orgs] Business access granted', { orgId, businessId, userId });
  }

  async revokeBusinessAccess(orgId: string, businessId: string, userId: string): Promise<void> {
    await db.from('business_user_access').delete()
      .eq('business_id', businessId).eq('user_id', userId);
    logger.info('[Orgs] Business access revoked', { orgId, businessId, userId });
  }

  /** List the businesses a user can see in a specific org. */
  async getAccessibleBusinessIds(orgId: string, userId: string): Promise<string[]> {
    const { data } = await db.from('business_user_access').select('business_id')
      .eq('org_id', orgId).eq('user_id', userId);
    return (data ?? []).map((r: any) => r.business_id);
  }

  // ─────────────────────────────────────────────────────────
  // PLAN DEFAULTS
  // ─────────────────────────────────────────────────────────

  // FIXED: was completely wrong — starter had 100 credits, agency had 2000.
  // Now matches BillingService.PLANS exactly. Single source of truth.
  private planDefaults(plan: string): { credits: number; maxBusinesses: number; maxUsers: number } {
    switch (plan) {
      case 'starter':      return { credits: 900,   maxBusinesses: 1,   maxUsers: 1   };
      case 'growth':       return { credits: 1600,  maxBusinesses: 1,   maxUsers: 3   };
      case 'pro':          return { credits: 1800,  maxBusinesses: 2,   maxUsers: 5   };
      case 'professional': return { credits: 1800,  maxBusinesses: 5,   maxUsers: 5   };
      case 'agency':       return { credits: 3500,  maxBusinesses: 5,   maxUsers: 20  };
      case 'enterprise':   return { credits: 99999, maxBusinesses: 999, maxUsers: 999 };
      default:             return { credits: 900,   maxBusinesses: 1,   maxUsers: 1   };
    }
  }
}

export const orgService = new OrgService();
