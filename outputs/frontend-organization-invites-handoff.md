# Frontend Handoff: Organization Invites

Owner: Claude Code / frontend
Backend status: ready
Scope: make organization membership invite-only and add UI for inviting members before Squads member management.

## Product Rule

Users cannot join an organization by org ID anymore. The backend now rejects:

```http
POST /organizations/:organizationId/join
```

with:

```json
{
  "code": "forbidden",
  "message": "Organizations can only be joined through an invite link."
}
```

The only supported join path is:

```text
admin creates email-bound invite
→ recipient opens invite link
→ recipient signs in with the same email
→ recipient accepts invite
→ recipient becomes org member
→ recipient can create a personal Privy wallet
→ admin can later propose adding that wallet to Squads treasury
```

## UX Placement

Add this to organization settings / members area.

Recommended pages:

- `/organizations/:organizationId/members`
- `/invites/:inviteToken`

If a dedicated settings page does not exist, add a simple `Members` page under the current organization sidebar.

## Concepts

- **Org member:** Decimal application member. Has app role: `owner`, `admin`, or `member`.
- **Personal wallet:** User-owned Privy embedded wallet.
- **Squads member:** Onchain treasury member. This comes later through Squads config proposals.

Do not blur these concepts in UI copy. A user can be an org member without being a Squads treasury signer yet.

## API Endpoints

All protected endpoints use the existing bearer session token.

### Preview Invite

Public route. Use this on `/invites/:inviteToken` before forcing login.

```http
GET /invites/:inviteToken
```

Response:

```ts
type PublicInvite = {
  organizationInviteId: string;
  invitedEmail: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  organization: {
    organizationId: string;
    organizationName: string;
    status: string;
  };
  invitedByUser: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
};
```

Frontend behavior:

- If `status !== "pending"`, show a terminal state.
- If user is not signed in, route them to sign in with return path `/invites/:inviteToken`.
- If signed-in user email does not match `invitedEmail`, show "This invite was sent to X. Sign in with that email."

### Accept Invite

```http
POST /invites/:inviteToken/accept
```

Response:

```ts
type AcceptInviteResponse = {
  organizationId: string;
  organizationName: string;
  membershipId: string;
  role: 'admin' | 'member';
  invite: OrganizationInvite;
};
```

Frontend behavior:

- On success, refresh session/org list.
- Navigate to `/organizations/:organizationId/wallets` or the org overview.
- If accepted user has no personal wallet, show the existing personal wallet onboarding path.

### List Members

Existing endpoint; use for members page:

```http
GET /organizations/:organizationId/members
```

Current response shape:

```ts
type MembersResponse = {
  items: Array<{
    membershipId: string;
    role: 'owner' | 'admin' | 'member';
    status: 'active';
    user: {
      userId: string;
      email: string;
      displayName: string;
    };
  }>;
};
```

### List Invites

Admin only.

```http
GET /organizations/:organizationId/invites
GET /organizations/:organizationId/invites?status=pending
```

Response:

```ts
type OrganizationInvite = {
  organizationInviteId: string;
  organizationId: string;
  invitedEmail: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  organization: {
    organizationId: string;
    organizationName: string;
    status: string;
  };
  invitedByUser: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
  acceptedByUser: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
};
```

### Create Invite

Admin only.

```http
POST /organizations/:organizationId/invites
```

Body:

```ts
{
  email: string;
  role: 'admin' | 'member';
}
```

Response includes a one-time visible token/link:

```ts
OrganizationInvite & {
  inviteToken: string;
  inviteLink: string;
}
```

Frontend behavior:

- Show invite form with email + role.
- After create, show the returned `inviteLink` with copy button.
- MVP can be manual sharing; no email delivery is implemented yet.
- If backend returns conflict, show "This user is already an active organization member."

### Revoke Invite

Admin only.

```http
POST /organizations/:organizationId/invites/:organizationInviteId/revoke
```

Frontend behavior:

- Show revoke action only for pending invites.
- Refresh invites list after success.

## Members Page Recommended Layout

Header:

- Title: `Members`
- Primary CTA: `Invite member`
- Helper text: `Invite teammates into Decimal first. Add them to Squads treasury separately after they create a signing wallet.`

Sections:

1. Active members table
   - Name
   - Email
   - Decimal role
   - Wallet status if easy to fetch later
   - Squads status later

2. Pending invites table
   - Email
   - Role
   - Invited by
   - Expires
   - Copy link
   - Revoke

3. Accepted/revoked invite history can be collapsed or filtered.

## Invite Page Recommended Flow

Route: `/invites/:inviteToken`

States:

- Loading preview
- Invalid invite
- Expired/revoked/accepted invite
- Not signed in
- Signed in as wrong email
- Ready to accept
- Accepted success

Copy:

- `You were invited to join {organizationName}`
- `This invite was sent to {invitedEmail}.`
- `Role: {role}`
- Primary action: `Accept invite`

## Important Security UX

- Do not let the user edit the invite email during acceptance.
- Do not allow "join another org by ID" anywhere in the frontend.
- Do not call the old `/organizations/:id/join` route.
- Treat invite links as secrets. Only show/copy the full invite link right after creation and in pending invite rows for admins.

## Backend Validation To Surface

- `Email verification is required before creating or accepting organization invites.`
- `This user is already an active organization member.`
- `This invite belongs to a different email address.`
- `Invite is accepted.`
- `Invite is revoked.`
- `Invite is expired.`
- `Only pending invites can be revoked.`

## Testing Checklist

1. Owner creates org.
2. Owner invites `member@example.com`.
3. Owner copies invite link.
4. Logged-out user opens invite link and sees org preview.
5. User signs in as wrong email and cannot accept.
6. User signs in as `member@example.com` and accepts.
7. Session/org list refreshes.
8. Members page shows owner + new member.
9. Owner can create another invite and revoke it.
10. No UI path calls `/organizations/:id/join`.
