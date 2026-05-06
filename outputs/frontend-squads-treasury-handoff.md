# Frontend Handoff: Squads v4 Treasury Creation

Owner: Claude Code / frontend
Backend status: ready for integration
Scope: create a Squads v4 treasury wallet for an organization and persist the Squads vault PDA as a Decimal treasury account.

## Current Backend State

The backend now supports the first Squads tranche:

- Prepare a Squads v4 multisig creation transaction.
- Let the user's personal signing wallet sign and submit that transaction.
- Confirm the onchain Squads multisig and store its vault PDA as an organization treasury wallet.
- Read live Squads status for a stored Squads treasury.

This does not yet create payment proposals through Squads. It only creates the treasury account that later payment execution will use.

## Product Model

Use these terms in the UI:

- Personal wallet: the user's individual signing wallet. This is usually Privy embedded now.
- Treasury wallet: organization-owned money account that Decimal monitors.
- Squads treasury: a treasury wallet backed by a Squads v4 multisig. Decimal stores the vault PDA as the treasury address and the multisig PDA as metadata.

Important distinction:

- A personal wallet belongs to a user.
- A Squads treasury belongs to the organization.
- Personal wallets become Squads members, but they are not themselves treasury wallets.

## Desired UX

Build this into the treasury wallets area, not the personal wallet area.

Recommended entry point:

- Page: organization treasury wallets page.
- Primary CTA: `Create Squads treasury`.
- Existing manual `Add treasury account` can remain secondary as `Add existing treasury address`.

Flow:

1. User opens `Create Squads treasury`.
2. UI checks the user has at least one active personal Solana wallet.
3. User chooses a display name.
4. User chooses Squads members from personal wallets owned by active organization members.
5. User chooses permissions and threshold.
6. UI calls `create-intent`.
7. UI shows review screen with multisig PDA, vault PDA, members, threshold, and required signer.
8. User signs and submits the returned transaction with the required personal wallet.
9. UI calls `confirm` with the submitted transaction signature and intent details.
10. UI refreshes treasury wallets and shows the new Squads treasury.

MVP default:

- If the current user has exactly one personal wallet, default to a 1-of-1 Squads treasury.
- Permissions for that wallet: `initiate`, `vote`, `execute`.
- Threshold: `1`.
- Timelock: `0`.
- Vault index: `0`.

Do not expose config authority. Backend creates autonomous Squads treasuries only.

## Existing Frontend Context

Relevant current files:

- `frontend/src/pages/Wallets.tsx`: treasury accounts UI.
- `frontend/src/api.ts`: API client wrapper.
- `frontend/src/types.ts`: shared frontend types.
- `frontend/src/lib/solana-wallet.ts`: existing Solana wallet discovery/signing helpers.

Current signing helper handles legacy `Transaction` payment packets. Squads returns a serialized `VersionedTransaction`, so add a small dedicated helper instead of forcing the existing payment packet builder to fit this flow.

## API Endpoints

All routes require the existing session auth token.

### List Personal Wallets

Use existing endpoint:

```http
GET /personal-wallets
```

Response shape already exists in `UserWallet`.

Use only active Solana wallets:

```ts
wallet.status === 'active' && wallet.chain === 'solana'
```

### Create Squads Treasury Intent

```http
POST /organizations/:organizationId/treasury-wallets/squads/create-intent
```

Request:

```ts
type CreateSquadsTreasuryIntentRequest = {
  displayName?: string | null;
  creatorPersonalWalletId: string;
  threshold: number;
  timeLockSeconds?: number;
  vaultIndex?: number;
  members: Array<{
    personalWalletId: string;
    permissions: Array<'initiate' | 'vote' | 'execute'>;
  }>;
};
```

Response:

```ts
type CreateSquadsTreasuryIntentResponse = {
  intent: {
    provider: 'squads_v4';
    programId: string;
    createKey: string;
    multisigPda: string;
    vaultPda: string;
    vaultIndex: number;
    threshold: number;
    timeLockSeconds: number;
    displayName: string | null;
    members: Array<{
      personalWalletId: string;
      walletAddress: string;
      userId: string;
      membershipId: string;
      permissions: Array<'initiate' | 'vote' | 'execute'>;
    }>;
  };
  transaction: {
    encoding: 'base64';
    serializedTransaction: string;
    requiredSigner: string;
    recentBlockhash: string;
    lastValidBlockHeight: number;
  };
};
```

Validation errors to surface cleanly:

- `creatorPersonalWalletId must be included as a Squads member.`
- `creatorPersonalWalletId must belong to the authenticated user.`
- `Every Squads member must be an active Solana personal wallet.`
- `Every Squads member wallet owner must be an active organization member.`
- `threshold cannot exceed the number of voting Squads members.`
- `At least one Squads member must have initiate permission.`
- `At least one Squads member must have vote permission.`
- `At least one Squads member must have execute permission.`
- `Squads treasury wallet already exists in this organization.`

### Confirm Squads Treasury

```http
POST /organizations/:organizationId/treasury-wallets/squads/confirm
```

Request:

```ts
type ConfirmSquadsTreasuryRequest = {
  signature: string;
  displayName?: string | null;
  createKey: string;
  multisigPda: string;
  vaultIndex?: number;
};
```

Response is a `TreasuryWallet`:

```ts
type TreasuryWallet = {
  treasuryWalletId: string;
  organizationId: string;
  chain: string;
  address: string;       // Squads vault PDA
  assetScope: string;
  usdcAtaAddress: string | null;
  isActive: boolean;
  source: 'squads_v4' | string;
  sourceRef: string | null; // Squads multisig PDA
  displayName: string | null;
  notes: string | null;
  propertiesJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

### Squads Treasury Status

```http
GET /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/status
```

Response:

```ts
type SquadsTreasuryStatus = {
  treasuryWalletId: string;
  provider: 'squads_v4';
  programId: string;
  multisigPda: string;
  vaultPda: string;
  vaultIndex: number;
  threshold: number;
  timeLockSeconds: number;
  transactionIndex: string;
  staleTransactionIndex: string;
  members: Array<{
    walletAddress: string;
    permissionsMask: number;
    permissions: Array<'initiate' | 'vote' | 'execute'>;
  }>;
  localStateMatchesChain: boolean;
};
```

Use this in a details panel or row expansion for Squads treasury accounts.

## Frontend API Client Additions

Add these methods to `frontend/src/api.ts`:

```ts
createSquadsTreasuryIntent(
  organizationId: string,
  input: CreateSquadsTreasuryIntentRequest,
) {
  return request<CreateSquadsTreasuryIntentResponse>(
    `/organizations/${organizationId}/treasury-wallets/squads/create-intent`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

confirmSquadsTreasury(
  organizationId: string,
  input: ConfirmSquadsTreasuryRequest,
) {
  return request<TreasuryWallet>(
    `/organizations/${organizationId}/treasury-wallets/squads/confirm`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

getSquadsTreasuryStatus(organizationId: string, treasuryWalletId: string) {
  return request<SquadsTreasuryStatus>(
    `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/status`,
  );
}
```

Add the corresponding types in `frontend/src/types.ts`.

## Signing and Submission

The backend returns a base64 serialized `VersionedTransaction` that is already partially signed by the backend-generated Squads `createKey`.

The frontend must:

1. Deserialize it.
2. Make sure the selected signer equals `transaction.requiredSigner`.
3. Ask the wallet to sign.
4. Submit the signed transaction.
5. Confirm the transaction.
6. Call backend `confirm`.

Suggested helper:

```ts
import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { getPublicSolanaRpcUrl } from '../public-config';

export async function signAndSubmitSerializedVersionedTransaction(input: {
  serializedTransactionBase64: string;
  requiredSigner: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  walletOptionId?: string;
}) {
  const connection = new Connection(getPublicSolanaRpcUrl(), 'confirmed');
  const bytes = Uint8Array.from(atob(input.serializedTransactionBase64), (char) => char.charCodeAt(0));
  const transaction = VersionedTransaction.deserialize(bytes);

  // Reuse the existing wallet discovery/resolution pattern from solana-wallet.ts.
  // The selected account/public key must equal input.requiredSigner.
  // Prefer signTransaction if available, then submit with sendRawTransaction.
  // If the wallet only exposes signAndSendTransaction, use that and return its signature.

  const signature = await signWithSelectedWalletAndSubmit({
    transaction,
    requiredSigner: new PublicKey(input.requiredSigner).toBase58(),
    walletOptionId: input.walletOptionId,
    connection,
  });

  await connection.confirmTransaction(
    {
      signature,
      blockhash: input.recentBlockhash,
      lastValidBlockHeight: input.lastValidBlockHeight,
    },
    'confirmed',
  );

  return signature;
}
```

Implementation note:

- Do not rebuild Squads instructions in the frontend.
- Do not install `@sqds/multisig` in the frontend for this tranche.
- Use the transaction exactly as returned by the backend.
- Preserve the backend `createKey` partial signature. Do not recreate or replace the transaction.

## Component Flow

Recommended component structure:

```txt
WalletsPage
  CreateSquadsTreasuryDialog
    StepMembers
    StepPolicy
    StepReview
    StepSignAndConfirm
```

State shape:

```ts
type SquadsTreasuryDraft = {
  displayName: string;
  creatorPersonalWalletId: string;
  threshold: number;
  timeLockSeconds: number;
  vaultIndex: number;
  members: Array<{
    personalWalletId: string;
    permissions: Array<'initiate' | 'vote' | 'execute'>;
  }>;
};

type PendingSquadsIntent = CreateSquadsTreasuryIntentResponse & {
  submittedSignature?: string;
};
```

Mutation sequence:

```txt
createIntent -> signAndSubmit -> confirm -> invalidate treasury queries
```

Invalidate these query keys after confirmation:

- `['treasury-wallet-balances', organizationId]`
- `['treasury-wallets', organizationId]` if present
- `['addresses', organizationId]` if still used by the address book
- `['organization-summary', organizationId]` if present

## UI Details

Create dialog copy:

- Title: `Create Squads treasury`
- Body: `Create an organization treasury controlled by selected member wallets. Decimal will monitor the Squads vault and use it as the source wallet for payments.`

Review screen fields:

- Treasury name
- Threshold, for example `1 of 1` or `2 of 3`
- Required signer
- Multisig address
- Treasury vault address
- Members and permissions

Treasury table:

- For `source === 'squads_v4'`, show a `Squads` badge.
- Address column should show `address`, which is the vault PDA.
- Add small secondary text or details drawer for `sourceRef`, which is the multisig PDA.

Empty state:

- If no personal wallet exists:
  - Title: `Create your signing wallet first`
  - Body: `A Squads treasury needs at least one personal wallet as a member. Create a Privy signing wallet from the wallet setup flow first.`
  - CTA: route to personal wallet setup/profile if available.

## Error Handling

Handle these states explicitly:

- No personal wallet: block treasury creation until a personal wallet exists.
- User rejects wallet signature: keep the intent on screen and allow retry.
- Selected wallet mismatch: tell user the required signer and ask them to select the matching personal wallet.
- Blockhash expired: show `Transaction expired. Prepare again.` and rerun `create-intent`.
- Transaction submitted but backend confirm failed: keep the signature and show `Retry confirmation`.
- Backend says treasury already exists: refresh treasury wallets and close the dialog.

Do not silently reset the flow after a failed confirmation. The signature is valuable and should be reusable for retry.

## Minimal Happy Path Test

Use this local flow:

1. Sign in.
2. Create organization.
3. Create/register one Privy personal wallet.
4. Go to treasury wallets.
5. Click `Create Squads treasury`.
6. Use default 1-of-1 settings.
7. Create intent.
8. Sign with the required personal wallet.
9. Confirm.
10. Verify a new treasury row appears with:
    - `source: squads_v4`
    - `address`: Squads vault PDA
    - `sourceRef`: Squads multisig PDA
    - `usdcAtaAddress`: non-null

Optional check:

1. Open the Squads status panel.
2. Call status endpoint.
3. Confirm `localStateMatchesChain === true`.

## Out of Scope

Do not implement these in this UI tranche:

- Squads payment proposal creation.
- Voting on Squads proposals.
- Executing Squads proposals.
- Importing existing Squads multisigs.
- Changing Squads members.
- Changing threshold.
- Custom config authority.
- Non-Squads custody providers.

Those are separate backend tranches.

## Backend Verification Already Done

The backend tranche was verified with:

```bash
npm run build
make test-api
```

API tests cover the create intent, confirm, and status path with mocked Squads runtime.
