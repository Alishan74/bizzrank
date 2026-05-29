# BizzRank RBAC frontend — installation

This is the third and final RBAC delivery: the UI pages and components for
managing your team and assigning business access.

Prerequisites:
  - bizzrank-rbac-foundation.zip installed (SQL migration + orgs route)
  - bizzrank-rbac-routes.zip installed (per-route enforcement)

## Files included

Two pages and two components:

  apps/frontend/src/pages/OrgSettings.tsx           (new — team management page)
  apps/frontend/src/pages/InviteAccept.tsx          (new — public invite landing page)
  apps/frontend/src/components/OrgManagement/MembersList.tsx
  apps/frontend/src/components/OrgManagement/BusinessAssignment.tsx

## Two small wiring changes you do yourself

### 1. Add two new routes to your Layout.tsx

Open `apps/frontend/src/components/Layout.tsx`. Find the existing routes
list. Add these two:

    import OrgSettingsPage from '../pages/OrgSettings';
    import InviteAcceptPage from '../pages/InviteAccept';

    <Route path="/team" element={<OrgSettingsPage />} />
    <Route path="/invite/accept" element={<InviteAcceptPage />} />

Place /team alongside the other authenticated routes (Overview, Businesses,
etc.). Place /invite/accept OUTSIDE the auth-protected section if you have
one — invitees may not be signed in yet when they land here.

### 2. Add a "Team" link to your sidebar nav

In your sidebar nav component (probably also in Layout.tsx or a Sidebar.tsx),
add a link to /team. Visible to everyone — the page itself hides actions
based on role.

Example:

    <NavLink to="/team" className="nav-link">Team</NavLink>

If your sidebar uses an icon system, the team icon could be something like
👥 or 🛡 or just text "Team".

## How it works in the UI

### OrgSettings page (route: /team)

What every member sees:
  - Org plan, credit usage, member count
  - List of all team members with their roles

What only the OWNER sees (everyone else sees a banner explaining):
  - Invite form (email + role dropdown)
  - List of pending invitations with copy-link / revoke buttons
  - Role dropdown next to each member (to change their role)
  - Monthly budget editor next to each member
  - "Businesses" button (opens the assignment modal)
  - "Reset password" button (admin password reset)
  - "Remove" button

### Invite accept page (route: /invite/accept?token=...)

Public page (no auth required to land here). Three flows:
  - If user is already signed in → auto-accepts and redirects to /overview
  - If user has no account → "Create account" form (uses /api/auth/accept-invite-signup)
  - If user has an account → "Sign in" form (uses /api/auth/login, then accepts)

## Apply

    cd /workspaces/bizzrank/bizzrank-v10
    unzip -o bizzrank-rbac-frontend.zip

Then make the two wiring edits to Layout.tsx (described above).

Vite will hot-reload the new files automatically.

## Smoke test as the OWNER

1. Open BizzRank, click "Team" in the sidebar.
2. You should see your org details and yourself in the members list.
3. Invite a fresh email (use yourself+test@gmail.com if you want).
4. Copy the invitation link from the success message.
5. Open that link in an Incognito window.
6. Should land on /invite/accept with the "You've been invited" panel.
7. Choose "Create a new account", fill the form (matching the invited email).
8. After signup completes, you're redirected to /overview as the new user.

## Smoke test as the MANAGER

Continuing from the test above, while still signed in as the new manager:

1. Click "Team" — should see the same page but with a banner saying
   "You're a manager in this organization. Only the owner can invite..."
2. Click "Businesses" in the sidebar — empty list (no businesses assigned yet).
3. Sign back in as the owner.
4. Go to /team, find the new manager, click "Businesses" next to them.
5. Toggle one of your businesses on. Close the modal.
6. Sign in as the manager again. Refresh /businesses — that one business now appears.
7. The other businesses are completely hidden — not visible anywhere in the app.

If those test sequences work, RBAC is fully operational.

## Troubleshooting

**"You are not a member of this organization" when accepting an invite**

Means the JWT is for a user who isn't in `org_members`. Try logging out and
back in. If still broken, the invite token didn't match the email used to sign up.

**Invite link copies but pasted URL has wrong host**

The /api/orgs/invitations endpoint includes `acceptUrl` using FRONTEND_URL
from your API .env. Make sure that's set correctly in apps/api/.env:
  FRONTEND_URL=http://localhost:5173

For production, update it to your actual domain.

**Team page shows empty member list**

The /api/orgs endpoint returned but members array was empty. Run this in
Supabase to confirm your data:
  select * from public.org_members where org_id = '<your-org-id>';
