/**
 * Permission domain.
 *
 * Pure boolean decisions: "can this userId do this action on this resource?"
 * Routes and middleware call into here — no role logic anywhere else.
 *
 * Role rules:
 *   - owner          → can do everything in the org, sees every business
 *   - billing_admin  → can manage billing, see every business (read-only otherwise)
 *   - manager        → can run scans + edit ONLY assigned businesses
 *   - viewer         → can ONLY view assigned businesses; no scans, no edits
 *
 * "Assigned business" = row exists in business_user_access(business_id, user_id).
 * Owners and billing_admins always have implicit access to every business in their org.
 */

import { db } from '../../infrastructure/database/SupabaseClient.js';
import type { OrgRole, OrgContext } from '../../shared/types/rbac.js';

export type Action =
  | 'org.read'
  | 'org.manage'           // invite users, change roles, reset passwords, assign businesses
  | 'org.billing'          // see + change plan, see credit usage org-wide
  | 'business.read'
  | 'business.create'
  | 'business.edit'
  | 'business.delete'
  | 'scan.run'
  | 'scan.read'
  | 'reviews.read'
  | 'reviews.fetch'
  | 'reviews.reply';

const ROLE_ACTIONS: Record<OrgRole, Action[]> = {
  owner: [
    'org.read', 'org.manage', 'org.billing',
    'business.read', 'business.create', 'business.edit', 'business.delete',
    'scan.run', 'scan.read',
    'reviews.read', 'reviews.fetch', 'reviews.reply',
  ],
  billing_admin: [
    'org.read', 'org.billing',
    'business.read', 'scan.read', 'reviews.read',
  ],
  manager: [
    'org.read',
    'business.read', 'business.create', 'business.edit',
    'scan.run', 'scan.read',
    'reviews.read', 'reviews.fetch', 'reviews.reply',
  ],
  viewer: [
    'org.read',
    'business.read', 'scan.read', 'reviews.read',
  ],
};

const SEES_ALL_BUSINESSES: OrgRole[] = ['owner', 'billing_admin'];

export class PermissionService {
  /**
   * Build the full request-time permission context for a user in their current org.
   * Called by the orgContext middleware once per request and stashed on req.
   */
  async buildContext(userId: string, orgId: string): Promise<OrgContext | null> {
    const { data: member } = await db.from('org_members')
      .select('role')
      .eq('org_id', orgId).eq('user_id', userId).single();
    if (!member) return null;

    const role = member.role as OrgRole;
    const seesAll = SEES_ALL_BUSINESSES.includes(role);

    let accessibleBusinessIds: string[] = [];
    if (!seesAll) {
      const { data: access } = await db.from('business_user_access')
        .select('business_id')
        .eq('org_id', orgId).eq('user_id', userId);
      accessibleBusinessIds = (access ?? []).map((a: any) => a.business_id);
    }

    return {
      orgId,
      userId,
      role,
      accessibleBusinessIds,
      seesAllBusinesses: seesAll,
    };
  }

  /** Does this role have the named action at all? (Resource access checked separately.) */
  canPerform(role: OrgRole, action: Action): boolean {
    return ROLE_ACTIONS[role]?.includes(action) ?? false;
  }

  /**
   * Combined check: does the user have role permission AND access to the specific business?
   * For org-wide actions (no business), pass businessId = null.
   */
  canActOnBusiness(ctx: OrgContext, action: Action, businessId: string | null): boolean {
    if (!this.canPerform(ctx.role, action)) return false;
    if (businessId === null) return true;
    if (ctx.seesAllBusinesses) return true;
    return ctx.accessibleBusinessIds.includes(businessId);
  }

  /**
   * Filter a list of business IDs down to those the user can see.
   * Use this in list endpoints (e.g., GET /api/businesses) to scope results.
   */
  filterAccessibleBusinesses(ctx: OrgContext, businessIds: string[]): string[] {
    if (ctx.seesAllBusinesses) return businessIds;
    return businessIds.filter(id => ctx.accessibleBusinessIds.includes(id));
  }
}

export const permissionService = new PermissionService();
