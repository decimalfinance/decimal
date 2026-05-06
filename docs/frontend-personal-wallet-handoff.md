# Frontend Handoff: Personal Wallets vs Treasury Wallets

This handoff is for the UI refactor after Google OAuth + Privy embedded wallets.

## Product Rule

Personal wallets and organization treasury wallets are different things.

- A personal wallet belongs to a user.
- A treasury wallet belongs to an organization.
- A personal wallet can be authorized to act for an organization or treasury wallet.
- A personal wallet must never be displayed as organization treasury funds.

## Desired User Flow

1. User signs in with Google.
2. User creates or joins an organization.
3. User creates their personal signing wallet through Privy.
4. User creates/connects an organization treasury wallet separately.
5. User authorizes a personal wallet as signer/admin/approver for that treasury wallet.

For MVP, it is fine if step 3 appears after organization creation, but the UI copy must still say "Personal wallet", not "Organization wallet".

## Naming

Use these labels in UI:

- `Personal wallet`: Privy embedded wallet owned by the individual user.
- `Treasury account`: organization-owned wallet used for payments, collections, balances, and reconciliation.
- `Wallet authorization`: permission connecting a personal wallet to an org or treasury account.

Avoid:

- "Member wallet" unless there is no better space; "Personal wallet" is clearer.
- Showing a Privy personal wallet under treasury accounts.
- Asking users for Privy wallet id or public key when creating the embedded wallet.

## Backend Endpoints

### Personal Wallets

Preferred routes:

- `GET /personal-wallets`
- `POST /personal-wallets/managed`
- `POST /personal-wallets/challenge`
- `POST /personal-wallets/external`
- `POST /personal-wallets/embedded`

Legacy aliases still work:

- `GET /user-wallets`
- `POST /user-wallets/managed`
- `POST /user-wallets/challenge`
- `POST /user-wallets/external`
- `POST /user-wallets/embedded`

Use `/personal-wallets` in new frontend code.

Create Privy personal wallet:

```ts
POST /personal-wallets/managed
{
  "provider": "privy",
  "label": "Fuyo personal wallet"
}
```

Response shape is the existing wallet shape:

```ts
{
  "userWalletId": "uuid",
  "userId": "uuid",
  "chain": "solana",
  "walletAddress": "base58",
  "walletType": "privy_embedded",
  "provider": "privy",
  "providerWalletId": "privy wallet id",
  "label": "Fuyo personal wallet",
  "status": "active"
}
```

### Treasury Accounts

Existing routes still apply:

- `GET /organizations/:organizationId/treasury-wallets`
- `POST /organizations/:organizationId/treasury-wallets`
- `PATCH /organizations/:organizationId/treasury-wallets/:treasuryWalletId`
- `GET /organizations/:organizationId/treasury-wallets/balances`

UI should call these "Treasury accounts".

### Wallet Authorizations

List:

```ts
GET /organizations/:organizationId/wallet-authorizations
GET /organizations/:organizationId/wallet-authorizations?treasuryWalletId=:treasuryWalletId
GET /organizations/:organizationId/wallet-authorizations?userWalletId=:userWalletId
GET /organizations/:organizationId/wallet-authorizations?status=active
```

Create:

```ts
POST /organizations/:organizationId/wallet-authorizations
{
  "userWalletId": "personal wallet id",
  "treasuryWalletId": "treasury wallet id",
  "role": "signer"
}
```

Org-level authorization without targeting one treasury account:

```ts
POST /organizations/:organizationId/wallet-authorizations
{
  "userWalletId": "personal wallet id",
  "role": "admin",
  "scope": "organization"
}
```

Revoke:

```ts
POST /organizations/:organizationId/wallet-authorizations/:walletAuthorizationId/revoke
{}
```

Authorization response:

```ts
{
  "walletAuthorizationId": "uuid",
  "organizationId": "uuid",
  "treasuryWalletId": "uuid | null",
  "userWalletId": "uuid",
  "membershipId": "uuid",
  "role": "signer",
  "status": "active",
  "scope": "treasury_wallet",
  "personalWallet": {
    "userWalletId": "uuid",
    "walletAddress": "base58",
    "walletType": "privy_embedded",
    "provider": "privy",
    "label": "Fuyo personal wallet"
  },
  "membership": {
    "membershipId": "uuid",
    "role": "owner",
    "user": {
      "email": "user@example.com",
      "displayName": "User"
    }
  },
  "treasuryWallet": {
    "treasuryWalletId": "uuid",
    "address": "base58",
    "displayName": "Ops Treasury"
  }
}
```

## Suggested Screens

### Personal Wallet Setup

Purpose: create the user's own signing wallet.

Primary CTA:

- `Create personal wallet`

Content:

- Explain that this wallet belongs to the user.
- Explain it can later be authorized to act for org treasury accounts.
- Do not show custody providers except Privy for now.
- Do not show wallet address form.
- Do not ask for Privy wallet id.

### Treasury Account Setup

Purpose: add or create organization-owned wallet/account.

Primary CTA:

- `Add treasury account`

Content:

- Show treasury account address.
- Show USDC ATA.
- Show balance.
- Show "Authorized personal wallets" section.

### Treasury Account Detail

Sections:

- Treasury account identity.
- Balances.
- Authorized personal wallets.
- Payments using this treasury account.
- Collections received into this treasury account.

### Authorization UI

For each treasury account:

- Button: `Authorize personal wallet`
- Select from the current user's personal wallets or org members' wallets.
- Role dropdown: `signer`, `approver`, `admin`.
- Revoke action for existing authorizations.

## UI Rules

- Sidebar item currently called `Wallets` should probably become `Treasury accounts`.
- Personal wallet should live in profile/onboarding, not in the treasury registry.
- If the user has no personal wallet, show onboarding card:
  - "Create your personal signing wallet"
  - "This wallet belongs to you, not the organization."
- If the org has no treasury account, show onboarding card:
  - "Add an organization treasury account"
  - "This is the wallet Decimal monitors and reconciles."
- Do not mix personal wallets and treasury accounts in the same table unless the table is explicitly named "Authorizations".

## Backend Compatibility Notes

- Existing frontend calls to `/user-wallets` still work.
- New frontend code should move to `/personal-wallets`.
- The database table is still `user_wallets` for migration safety, but Prisma now calls the model `PersonalWallet`.
- The bridge table is `organization_wallet_authorizations`.

