/**
 * Role-based access control types.
 * Shared between domain services, middleware, and routes.
 */

export type OrgRole = 'owner' | 'manager' | 'viewer' | 'billing_admin';

/** Roles that can be assigned to invited users (owner is assigned only at org creation). */
export type AssignableRole = Exclude<OrgRole, 'owner'>;

export const ASSIGNABLE_ROLES: AssignableRole[] = ['manager', 'viewer', 'billing_admin'];

export interface Organization {
  id: string;
  name: string;
  plan: string;
  credits_pool: number;
  credits_used_this_month: number;
  monthly_allowance: number;
  max_businesses: number;
  max_users: number;
  billing_cycle_start: string | null;
  owner_user_id: string;
  created_at: string;
}

export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string;
  role: OrgRole;
  monthly_credit_budget: number;
  credits_used_this_month: number;
  invited_by: string | null;
  created_at: string;
}

export interface OrgInvitation {
  id: string;
  org_id: string;
  email: string;
  role: AssignableRole;
  invited_by: string;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface OrgContext {
  orgId: string;
  userId: string;
  role: OrgRole;
  /** IDs of businesses this user has explicit access to. Empty for owner/billing_admin (they see all). */
  accessibleBusinessIds: string[];
  /** True if user is owner or billing_admin — they see every business in the org regardless of explicit grants. */
  seesAllBusinesses: boolean;
}

/** Per-action permission decisions. Returned by PermissionService. */
export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}
