/**
 * Middleware: loads the requesting user's org context onto every authenticated request.
 *
 * Sets req.orgContext containing { orgId, role, accessibleBusinessIds, seesAllBusinesses }.
 * Routes use this to decide what data to return and which actions to allow.
 *
 * Mount AFTER requireAuth.
 */

import { Request, Response, NextFunction } from 'express';
import { supabase } from '../../infrastructure/database/SupabaseClient.js';
import { permissionService } from '../../domains/orgs/PermissionService.js';
import type { OrgContext } from '../../shared/types/rbac.js';

export interface OrgRequest extends Request {
  userId?: string;
  userEmail?: string;
  orgContext?: OrgContext;
}

/**
 * Loads the user's current_org_id from their profile, then builds the permission context.
 * If the user has no current_org_id (shouldn't happen post-migration, but a safety net),
 * picks their first owned org.
 */
export async function loadOrgContext(req: OrgRequest, res: Response, next: NextFunction) {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    let { data: profile } = await supabase
      .from('profiles')
      .select('current_org_id')
      .eq('id', req.userId)
      .single();

    let orgId = profile?.current_org_id as string | undefined;

    if (!orgId) {
      const { data: org } = await supabase
        .from('organizations')
        .select('id')
        .eq('owner_id', req.userId)
        .order('created_at', { ascending: true })
        .limit(1)
        .single();
      orgId = org?.id;
      if (orgId) {
        await supabase.from('profiles').update({ current_org_id: orgId }).eq('id', req.userId);
      }
    }

    if (!orgId) return res.status(403).json({ error: 'No organization for this user' });

    const ctx = await permissionService.buildContext(req.userId, orgId);
    if (!ctx) return res.status(403).json({ error: 'You are not a member of this organization' });

    req.orgContext = ctx;
    next();
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load org context: ' + err.message });
  }
}

/**
 * Helper for routes to require a specific action.
 * Usage:
 *   router.post('/', requireAuth, loadOrgContext, require('business.create'), handler)
 */
export function require(action: Parameters<typeof permissionService.canPerform>[1]) {
  return (req: OrgRequest, res: Response, next: NextFunction) => {
    if (!req.orgContext) return res.status(403).json({ error: 'No org context' });
    if (!permissionService.canPerform(req.orgContext.role, action)) {
      return res.status(403).json({
        error: `Your role (${req.orgContext.role}) cannot perform "${action}"`,
      });
    }
    next();
  };
}
