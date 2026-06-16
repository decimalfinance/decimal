import type {
  AcceptInviteResponse,
  AuthenticatedSession,
  CapabilitiesResponse,
  CollectionCsvPreview,
  CollectionRequest,
  CollectionProofPacket,
  CollectionRunProofPacket,
  CollectionRunCsvPreview,
  CollectionRunImportResult,
  CollectionRunSummary,
  Counterparty,
  CounterpartyWallet,
  CounterpartyWalletTrustState,
  CreateOrganizationInviteResponse,
  LoginResponse,
  OrganizationInvite,
  OrganizationInviteRole,
  OrganizationInviteStatus,
  AutomationAgent,
  CreateSpendingLimitPolicyIntentRequest,
  OrganizationCreatedResponse,
  OrganizationMember,
  OrganizationSummary,
  RemoveSpendingLimitPolicyIntentRequest,
  ReplaceSpendingLimitPolicyIntentRequest,
  ReplaceSpendingLimitPolicyIntentResponse,
  SpendingLimitExecution,
  SpendingLimitPolicy,
  SpendingLimitPolicyIntentResponse,
  PaymentOrder,
  PaymentProofPacket,
  BatchCsvUploadResult,
  BatchCsvPreviewResult,
  InvoiceUploadResult,
  PaymentOrderAgentAdvanceResult,
  PaymentOrderClearReviewResult,
  PublicInvite,
  ConfirmSquadsTreasuryRequest,
  RegisterSquadsTreasuryVaultRequest,
  CreateSquadsTreasuryIntentRequest,
  CreateSquadsTreasuryIntentResponse,
  CreateSquadsAddMemberProposalRequest,
  CreateSquadsChangeThresholdProposalRequest,
  CreateSquadsPaymentProposalRequest,
  CreateSquadsBatchedPaymentProposalRequest,
  DecimalProposal,
  DecimalProposalApproveRequest,
  DecimalProposalExecuteRequest,
  DecimalProposalIntentResponse,
  DecimalProposalListFilter,
  DecimalProposalSignatureRequest,
  SquadsConfigProposal,
  SquadsConfigProposalApproveRequest,
  SquadsConfigProposalWithTreasury,
  SquadsConfigProposalExecuteRequest,
  SquadsConfigProposalIntentResponse,
  SquadsProposalListStatusFilter,
  SquadsTreasuryDetail,
  SquadsTreasuryStatus,
  TreasuryWallet,
  ManagedWalletProvider,
  OrganizationPersonalWallet,
  UserWallet,
  WalletAuthorization,
  WalletAuthorizationRole,
  WalletAuthorizationScope,
  WalletAuthorizationStatus,
} from './types';
import { getPublicApiBaseUrl } from './public-config';

const API_BASE_URL = getPublicApiBaseUrl();
const AUTH_STORAGE_KEY = 'usdc_ops_v2.session_token';
const LEGACY_AUTH_STORAGE_KEY = 'usdc_ops.session_token';

let sessionToken = loadStoredToken();

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit & { includeAuth?: boolean }): Promise<T> {
  const includeAuth = init?.includeAuth ?? true;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(includeAuth && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code: string | null = null;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
      if (typeof body?.code === 'string') {
        code = body.code;
      }
    } catch {
      // keep default
    }

    if (response.status === 401) {
      clearSessionToken();
    }

    throw new ApiError(message, response.status, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function download(path: string, fallbackFileName = 'export.csv') {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition');
  const fileNameMatch = disposition?.match(/filename="([^"]+)"/);
  const fileName = fileNameMatch?.[1] ?? fallbackFileName;
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

export const api = {
  getCapabilities() {
    return request<CapabilitiesResponse>('/capabilities', { includeAuth: false });
  },
  hasSessionToken() {
    return Boolean(sessionToken);
  },
  getSessionToken() {
    return sessionToken;
  },
  setSessionToken(nextToken: string) {
    sessionToken = nextToken;
    window.localStorage.setItem(AUTH_STORAGE_KEY, nextToken);
  },
  clearSessionToken() {
    clearSessionToken();
  },
  getGoogleOAuthStartUrl(returnTo = '/setup') {
    const params = new URLSearchParams({
      returnTo,
      frontendOrigin: window.location.origin,
    });
    return `${API_BASE_URL}/auth/google/start?${params.toString()}`;
  },
  register(input: { email: string; password: string; displayName?: string }) {
    return request<LoginResponse>('/auth/register', {
      method: 'POST',
      includeAuth: false,
      body: JSON.stringify(input),
    });
  },
  login(input: { email: string; password: string }) {
    return request<LoginResponse>('/auth/login', {
      method: 'POST',
      includeAuth: false,
      body: JSON.stringify(input),
    });
  },
  getSession() {
    return request<AuthenticatedSession>('/auth/session');
  },
  verifyEmail(input: { code: string }) {
    return request<{ user: AuthenticatedSession['user'] }>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  resendVerification() {
    return request<{
      user: AuthenticatedSession['user'];
      emailDelivered: boolean;
      devEmailVerificationCode: string | null;
    }>('/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  logout() {
    return request<void>('/auth/logout', {
      method: 'POST',
    });
  },
  createOrganization(input: { organizationName: string }) {
    return request<OrganizationCreatedResponse>('/organizations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getOrganizationSummary(organizationId: string) {
    return request<OrganizationSummary>(`/organizations/${organizationId}/summary`);
  },
  listOrganizationMembers(organizationId: string) {
    return request<{ items: OrganizationMember[] }>(
      `/organizations/${organizationId}/members`,
    );
  },
  listOrganizationInvites(organizationId: string, status?: OrganizationInviteStatus) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return request<{ items: OrganizationInvite[] }>(
      `/organizations/${organizationId}/invites${query}`,
    );
  },
  createOrganizationInvite(
    organizationId: string,
    input: { email: string; role: OrganizationInviteRole },
  ) {
    return request<CreateOrganizationInviteResponse>(
      `/organizations/${organizationId}/invites`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  revokeOrganizationInvite(organizationId: string, organizationInviteId: string) {
    return request<OrganizationInvite>(
      `/organizations/${organizationId}/invites/${organizationInviteId}/revoke`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  previewInvite(inviteToken: string) {
    return request<PublicInvite>(`/invites/${encodeURIComponent(inviteToken)}`, {
      includeAuth: false,
    });
  },
  acceptInvite(inviteToken: string) {
    return request<AcceptInviteResponse>(
      `/invites/${encodeURIComponent(inviteToken)}/accept`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  // Personal wallets — user-owned signing wallets.
  listPersonalWallets() {
    return request<{ items: UserWallet[] }>('/personal-wallets');
  },
  // Active personal wallets owned by all members of the organization. Admin
  // only — used by the Squads treasury creation dialog to pick co-signers.
  listOrganizationPersonalWallets(organizationId: string) {
    return request<{ items: OrganizationPersonalWallet[] }>(
      `/organizations/${organizationId}/personal-wallets`,
    );
  },
  createPersonalWalletManaged(input: {
    provider: ManagedWalletProvider;
    label?: string;
  }) {
    return request<UserWallet>('/personal-wallets/managed', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  // Archives a Privy-embedded personal wallet from Decimal. Backend
  // attempts Privy's DELETE /v1/wallets/:id (best-effort — Privy now
  // requires an authorization signature for destructive ops, which we
  // don't yet generate, so this currently fails with a non-null
  // remoteDeleteError but the local archive still succeeds), archives
  // the local row (status=archived), clears providerWalletId, and
  // revokes any active org wallet authorizations referencing the
  // wallet. Funds in the wallet at delete time are unrecoverable —
  // caller is responsible for transferring out first.
  deletePersonalWallet(userWalletId: string) {
    return request<{
      deleted: true;
      remoteDeleted: boolean;
      remoteAlreadyMissing: boolean;
      remoteDeleteError: string | null;
      revokedAuthorizationCount: number;
      wallet: UserWallet;
    }>(`/personal-wallets/${userWalletId}`, {
      method: 'DELETE',
    });
  },

  // Live balances for the caller's personal wallets via the configured
  // network. SOL in lamports, USDC raw (6 decimals). rpcError per row
  // surfaces transient RPC failures without breaking the whole list.
  listPersonalWalletBalances() {
    return request<{
      fetchedAt: string;
      items: Array<{
        userWalletId: string;
        walletAddress: string;
        label: string | null;
        walletType: string;
        provider: string | null;
        usdcAtaAddress: string | null;
        solLamports: string;
        usdcRaw: string | null;
        rpcError: string | null;
      }>;
    }>('/personal-wallets/balances');
  },
  // Devnet SOL airdrop. Backend always uses SOLANA_DEVNET_RPC_URL
  // regardless of the app's configured network, so this works for
  // testing even when the app is running mainnet mode. Default 1 SOL,
  // max 2 SOL per call (network's hard cap).
  airdropSolToPersonalWallet(userWalletId: string, input: { amountSol?: number } = {}) {
    return request<{
      signature: string;
      amountSol: number;
      walletAddress: string;
      userWalletId: string;
    }>(`/personal-wallets/${userWalletId}/airdrop-sol`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  // Drain / partial-transfer from a personal Privy wallet. Backend
  // builds the instruction, signs via Privy, submits, best-effort
  // confirms. asset='sol' -> amountRaw is lamports; asset='usdc' ->
  // amountRaw is raw base units (1 USDC = 1_000_000). Recipient ATAs
  // are created idempotently for USDC.
  transferOutPersonalWallet(
    userWalletId: string,
    input: { recipient: string; amountRaw: string; asset: 'sol' | 'usdc' },
  ) {
    return request<{
      signature: string;
      asset: 'sol' | 'usdc';
      amountRaw: string;
      recipient: string;
      userWalletId: string;
    }>(`/personal-wallets/${userWalletId}/transfer-out`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  // Backend signs the serialized VersionedTransaction with the user's
  // Privy-embedded wallet (private key never leaves the backend or
  // Privy). Backend validates: wallet belongs to caller, is active +
  // Solana + privy_embedded, the wallet is a required signer on the
  // transaction, and the transaction includes the Squads v4 program.
  signPersonalWalletVersionedTransaction(
    userWalletId: string,
    input: { serializedTransactionBase64: string },
  ) {
    return request<{
      userWalletId: string;
      walletAddress: string;
      signedTransactionBase64: string;
      encoding: 'base64';
    }>(`/personal-wallets/${userWalletId}/sign-versioned-transaction`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  // Wallet authorizations — explicit bridge between a personal wallet and an
  // organization (or specific treasury wallet within it).
  listWalletAuthorizations(
    organizationId: string,
    params: {
      treasuryWalletId?: string;
      userWalletId?: string;
      status?: WalletAuthorizationStatus;
    } = {},
  ) {
    const qs = new URLSearchParams();
    if (params.treasuryWalletId) qs.set('treasuryWalletId', params.treasuryWalletId);
    if (params.userWalletId) qs.set('userWalletId', params.userWalletId);
    if (params.status) qs.set('status', params.status);
    const query = qs.toString();
    return request<{ items: WalletAuthorization[] }>(
      `/organizations/${organizationId}/wallet-authorizations${query ? `?${query}` : ''}`,
    );
  },
  createWalletAuthorization(
    organizationId: string,
    input: {
      userWalletId: string;
      treasuryWalletId?: string | null;
      membershipId?: string;
      role?: WalletAuthorizationRole;
      scope?: WalletAuthorizationScope;
      metadataJson?: Record<string, unknown>;
    },
  ) {
    return request<WalletAuthorization>(
      `/organizations/${organizationId}/wallet-authorizations`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  revokeWalletAuthorization(organizationId: string, walletAuthorizationId: string) {
    return request<WalletAuthorization>(
      `/organizations/${organizationId}/wallet-authorizations/${walletAuthorizationId}/revoke`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  listTreasuryWallets(organizationId: string) {
    return request<{ items: TreasuryWallet[] }>(`/organizations/${organizationId}/treasury-wallets`);
  },
  listTreasuryWalletBalances(organizationId: string) {
    return request<{
      fetchedAt: string;
      items: Array<{
        treasuryWalletId: string;
        address: string;
        usdcAtaAddress: string | null;
        displayName: string | null;
        isActive: boolean;
        solLamports: string;
        usdcRaw: string | null;
        rpcError: string | null;
      }>;
    }>(`/organizations/${organizationId}/treasury-wallets/balances`);
  },
  listCounterparties(organizationId: string) {
    return request<{ items: Counterparty[] }>(`/organizations/${organizationId}/counterparties`);
  },
  createCounterparty(
    organizationId: string,
    input: {
      displayName: string;
      category?: string;
      externalReference?: string;
      status?: string;
    },
  ) {
    return request<Counterparty>(`/organizations/${organizationId}/counterparties`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  // The org's address book — flat list of labeled Solana wallets. Trust
  // state gates whether transfers can execute; same wallet can serve
  // both outbound payments and inbound collections.
  listCounterpartyWallets(organizationId: string) {
    return request<{ items: CounterpartyWallet[] }>(
      `/organizations/${organizationId}/counterparty-wallets`,
    );
  },
  createCounterpartyWallet(
    organizationId: string,
    input: {
      counterpartyId?: string;
      walletAddress: string;
      tokenAccountAddress?: string;
      walletType?: string;
      trustState?: CounterpartyWalletTrustState;
      label: string;
      notes?: string;
      isInternal?: boolean;
      isActive?: boolean;
    },
  ) {
    return request<CounterpartyWallet>(`/organizations/${organizationId}/counterparty-wallets`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateCounterpartyWallet(
    organizationId: string,
    counterpartyWalletId: string,
    input: {
      counterpartyId?: string | null;
      walletAddress?: string;
      tokenAccountAddress?: string | null;
      walletType?: string;
      trustState?: CounterpartyWalletTrustState;
      label?: string;
      notes?: string | null;
      isInternal?: boolean;
      isActive?: boolean;
    },
  ) {
    return request<CounterpartyWallet>(
      `/organizations/${organizationId}/counterparty-wallets/${counterpartyWalletId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    );
  },
  createTreasuryWallet(
    organizationId: string,
    input: {
      address: string;
      displayName?: string;
      assetScope?: string;
      notes?: string;
    },
  ) {
    return request(`/organizations/${organizationId}/treasury-wallets`, {
      method: 'POST',
      body: JSON.stringify({
        chain: 'solana',
        source: 'manual',
        assetScope: input.assetScope ?? 'usdc',
        ...input,
      }),
    });
  },

  // Squads v4 treasury creation. Three-step flow:
  //   1. createSquadsTreasuryIntent — backend prepares + partially signs
  //      a VersionedTransaction; returns intent metadata + serialized tx
  //   2. (frontend) sign with the user's personal wallet, submit to chain
  //   3. confirmSquadsTreasury — backend confirms onchain state and
  //      persists a TreasuryWallet row with source='squads_v4',
  //      address=vault PDA, sourceRef=multisig PDA
  // getSquadsTreasuryStatus reads live Squads state for an existing
  // squads_v4 treasury — useful for badges and a details panel.
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
  },
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
  },
  // Register a second (third, ...) vault under an existing Squads treasury.
  // Vault PDAs are deterministic — no on-chain tx needed, the backend just
  // derives the address and writes a new TreasuryWallet row sharing the same
  // sourceRef (multisig PDA) but a different sourceVaultIndex.
  registerSquadsTreasuryVault(
    organizationId: string,
    treasuryWalletId: string,
    input: RegisterSquadsTreasuryVaultRequest,
  ) {
    return request<TreasuryWallet>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/vaults`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getSquadsTreasuryStatus(organizationId: string, treasuryWalletId: string) {
    return request<SquadsTreasuryStatus>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/status`,
    );
  },
  getSquadsTreasuryDetail(organizationId: string, treasuryWalletId: string) {
    return request<SquadsTreasuryDetail>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/detail`,
    );
  },
  createSquadsAddMemberProposalIntent(
    organizationId: string,
    treasuryWalletId: string,
    input: CreateSquadsAddMemberProposalRequest,
  ) {
    return request<SquadsConfigProposalIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/config-proposals/add-member-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  createSquadsChangeThresholdProposalIntent(
    organizationId: string,
    treasuryWalletId: string,
    input: CreateSquadsChangeThresholdProposalRequest,
  ) {
    return request<SquadsConfigProposalIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/config-proposals/change-threshold-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  createSquadsConfigProposalApprovalIntent(
    organizationId: string,
    treasuryWalletId: string,
    transactionIndex: string,
    input: SquadsConfigProposalApproveRequest,
  ) {
    return request<SquadsConfigProposalIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/config-proposals/${transactionIndex}/approve-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  createSquadsConfigProposalExecuteIntent(
    organizationId: string,
    treasuryWalletId: string,
    transactionIndex: string,
    input: SquadsConfigProposalExecuteRequest,
  ) {
    return request<SquadsConfigProposalIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/config-proposals/${transactionIndex}/execute-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  syncSquadsTreasuryMembers(organizationId: string, treasuryWalletId: string) {
    return request<SquadsTreasuryDetail>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/sync-members`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  },
  // Aggregated across all org Squads treasuries the actor is a member of.
  listOrganizationSquadsProposals(
    organizationId: string,
    options: { status?: SquadsProposalListStatusFilter; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<{ items: SquadsConfigProposalWithTreasury[] }>(
      `/organizations/${organizationId}/squads/proposals${query ? `?${query}` : ''}`,
    );
  },
  listSquadsConfigProposals(
    organizationId: string,
    treasuryWalletId: string,
    options: { status?: SquadsProposalListStatusFilter; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<{ items: SquadsConfigProposal[] }>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/config-proposals${query ? `?${query}` : ''}`,
    );
  },
  getSquadsConfigProposal(
    organizationId: string,
    treasuryWalletId: string,
    transactionIndex: string,
  ) {
    return request<SquadsConfigProposal>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/config-proposals/${transactionIndex}`,
    );
  },

  // Generic Decimal proposal surface (replaces the Squads-specific listing
  // and detail in new UI). Covers config_transaction + vault_transaction.
  listOrganizationProposals(
    organizationId: string,
    filter: DecimalProposalListFilter = {},
  ) {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.proposalType) params.set('proposalType', filter.proposalType);
    if (filter.treasuryWalletId) params.set('treasuryWalletId', filter.treasuryWalletId);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    return request<{ items: DecimalProposal[] }>(
      `/organizations/${organizationId}/proposals${query ? `?${query}` : ''}`,
    );
  },
  getOrganizationProposal(organizationId: string, decimalProposalId: string) {
    return request<DecimalProposal>(
      `/organizations/${organizationId}/proposals/${decimalProposalId}`,
    );
  },
  confirmProposalSubmission(
    organizationId: string,
    decimalProposalId: string,
    input: DecimalProposalSignatureRequest,
  ) {
    return request<DecimalProposal>(
      `/organizations/${organizationId}/proposals/${decimalProposalId}/confirm-submission`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  confirmProposalExecution(
    organizationId: string,
    decimalProposalId: string,
    input: DecimalProposalSignatureRequest,
  ) {
    return request<DecimalProposal>(
      `/organizations/${organizationId}/proposals/${decimalProposalId}/confirm-execution`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  reconcileProposalFromChain(organizationId: string, decimalProposalId: string) {
    return request<DecimalProposal>(
      `/organizations/${organizationId}/proposals/${decimalProposalId}/reconcile`,
      { method: 'POST' },
    );
  },
  createProposalApprovalIntent(
    organizationId: string,
    decimalProposalId: string,
    input: DecimalProposalApproveRequest,
  ) {
    return request<DecimalProposalIntentResponse>(
      `/organizations/${organizationId}/proposals/${decimalProposalId}/approve-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  createProposalRejectIntent(
    organizationId: string,
    decimalProposalId: string,
    input: DecimalProposalApproveRequest,
  ) {
    return request<DecimalProposalIntentResponse>(
      `/organizations/${organizationId}/proposals/${decimalProposalId}/reject-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  createProposalExecuteIntent(
    organizationId: string,
    decimalProposalId: string,
    input: DecimalProposalExecuteRequest,
  ) {
    return request<DecimalProposalIntentResponse>(
      `/organizations/${organizationId}/proposals/${decimalProposalId}/execute-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  createSquadsPaymentProposalIntent(
    organizationId: string,
    treasuryWalletId: string,
    input: CreateSquadsPaymentProposalRequest,
  ) {
    return request<DecimalProposalIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/vault-proposals/payment-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  // Batch variant: one Squads vault proposal that bundles up to 8 USDC
  // transfers (passed as paymentOrderIds). Optional inputBatchId tags the
  // proposal with the originating CSV batch. Backend rejects if any order
  // still needs Decimal-side approval (400) or if any of them already has
  // an active proposal (409 with the existing decimalProposalId in the
  // error payload).
  createSquadsBatchedPaymentProposalIntent(
    organizationId: string,
    treasuryWalletId: string,
    input: CreateSquadsBatchedPaymentProposalRequest,
  ) {
    return request<DecimalProposalIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/vault-proposals/payment-batch-intent`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  listPaymentOrders(
    organizationId: string,
    options?: { state?: PaymentOrder['state']; inputBatchId?: string },
  ) {
    const params = new URLSearchParams({ limit: '100' });
    if (options?.state) params.set('state', options.state);
    if (options?.inputBatchId) params.set('inputBatchId', options.inputBatchId);
    return request<{ servedAt: string; items: PaymentOrder[] }>(
      `/organizations/${organizationId}/payment-orders?${params.toString()}`,
    );
  },
  // Manual single-payment intake. Creates a PaymentOrder directly and,
  // with autoAdvance, runs the unified agent router in the same call.
  createPaymentOrder(
    organizationId: string,
    input: {
      counterpartyWalletId: string;
      amountRaw: string;
      asset?: string;
      memo?: string;
      externalReference?: string;
      invoiceNumber?: string;
      attachmentUrl?: string;
      dueAt?: string;
      sourceTreasuryWalletId?: string;
      metadataJson?: Record<string, unknown>;
      autoAdvance?: boolean;
    },
  ) {
    return request<PaymentOrder & { automation?: PaymentOrderAgentAdvanceResult }>(
      `/organizations/${organizationId}/payment-orders`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  // Bulk-create N PaymentOrders from a CSV string. Each row becomes a
  // PaymentOrder tagged with the same inputBatchId. With autoAdvance the
  // agent immediately routes each clean row through a spending limit or
  // Squads proposal.
  uploadBatchCsv(
    organizationId: string,
    input: {
      csv: string;
      sourceTreasuryWalletId?: string;
      batchLabel?: string;
      autoAdvance?: boolean;
    },
  ) {
    return request<BatchCsvUploadResult>(
      `/organizations/${organizationId}/payment-orders/batch-csv`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  previewBatchCsv(organizationId: string, csv: string) {
    return request<BatchCsvPreviewResult>(
      `/organizations/${organizationId}/payment-orders/batch-csv/preview`,
      { method: 'POST', body: JSON.stringify({ csv }) },
    );
  },
  getPaymentOrderDetail(organizationId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/organizations/${organizationId}/payment-orders/${paymentOrderId}`);
  },
  cancelPaymentOrder(organizationId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/organizations/${organizationId}/payment-orders/${paymentOrderId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  // Agent-aware invoice upload. Creates payment orders from the document and,
  // when autoAdvance is true (default), asks the Decimal org agent to route
  // any proposal-ready rows. Risky
  // rows come back as needs_review and the user clears them via
  // clearPaymentOrderReview.
  uploadInvoice(
    organizationId: string,
    input: {
      filename: string;
      mimeType: string;
      dataBase64: string;
      sourceTreasuryWalletId?: string | null;
      autoAdvance?: boolean;
    },
  ) {
    return request<InvoiceUploadResult>(
      `/organizations/${organizationId}/invoices/upload`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  // Clear a needs_review payment order. With autoAdvance the backend will
  // also kicks the agent router in the same call, returning the result in
  // `automation`.
  clearPaymentOrderReview(
    organizationId: string,
    paymentOrderId: string,
    input?: {
      reviewNote?: string | null;
      trustCounterpartyWallet?: boolean;
      autoAdvance?: boolean;
    },
  ) {
    return request<PaymentOrderClearReviewResult>(
      `/organizations/${organizationId}/payment-orders/${paymentOrderId}/clear-review`,
      { method: 'POST', body: JSON.stringify(input ?? {}) },
    );
  },
  // Idempotent retry. Safe to call repeatedly — if a proposal already exists
  // the backend returns already_has_proposal without creating a duplicate.
  advancePaymentOrder(
    organizationId: string,
    paymentOrderId: string,
    input?: {
      sourceTreasuryWalletId?: string | null;
    },
  ) {
    return request<PaymentOrderAgentAdvanceResult>(
      `/organizations/${organizationId}/payment-orders/${paymentOrderId}/agent/advance`,
      { method: 'POST', body: JSON.stringify(input ?? {}) },
    );
  },
  getPaymentOrderProof(organizationId: string, paymentOrderId: string) {
    return request<PaymentProofPacket>(`/organizations/${organizationId}/payment-orders/${paymentOrderId}/proof`);
  },
  listCollections(
    organizationId: string,
    params?: { state?: string; collectionRunId?: string; limit?: number },
  ) {
    const qs = new URLSearchParams();
    qs.set('limit', String(params?.limit ?? 100));
    if (params?.state) qs.set('state', params.state);
    if (params?.collectionRunId) qs.set('collectionRunId', params.collectionRunId);
    return request<{
      items: CollectionRequest[];
      limit: number;
      state: string | null;
      collectionRunId: string | null;
    }>(`/organizations/${organizationId}/collections?${qs.toString()}`);
  },
  createCollection(
    organizationId: string,
    input: {
      collectionRunId?: string;
      receivingTreasuryWalletId: string;
      counterpartyWalletId?: string;
      counterpartyId?: string;
      payerWalletAddress?: string;
      payerTokenAccountAddress?: string;
      amountRaw: string;
      asset?: string;
      reason: string;
      externalReference?: string;
      dueAt?: string;
      metadataJson?: Record<string, unknown>;
    },
  ) {
    return request<CollectionRequest>(`/organizations/${organizationId}/collections`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  previewCollectionCsv(
    organizationId: string,
    input: { csv: string; receivingTreasuryWalletId?: string },
  ) {
    return request<CollectionCsvPreview>(
      `/organizations/${organizationId}/collections/import-csv/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getCollection(organizationId: string, collectionRequestId: string) {
    return request<CollectionRequest>(
      `/organizations/${organizationId}/collections/${collectionRequestId}`,
    );
  },
  getCollectionProof(organizationId: string, collectionRequestId: string) {
    return request<CollectionProofPacket>(
      `/organizations/${organizationId}/collections/${collectionRequestId}/proof`,
    );
  },
  downloadCollectionProofJson(organizationId: string, collectionRequestId: string) {
    return download(
      `/organizations/${organizationId}/collections/${collectionRequestId}/proof`,
      `collection-${collectionRequestId}-proof.json`,
    );
  },
  cancelCollection(organizationId: string, collectionRequestId: string) {
    return request<CollectionRequest>(
      `/organizations/${organizationId}/collections/${collectionRequestId}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  listCollectionRuns(organizationId: string) {
    return request<{ items: CollectionRunSummary[]; limit: number }>(
      `/organizations/${organizationId}/collection-runs`,
    );
  },
  importCollectionRunCsv(
    organizationId: string,
    input: {
      csv: string;
      runName?: string;
      receivingTreasuryWalletId?: string;
      importKey?: string;
    },
  ) {
    return request<CollectionRunImportResult>(
      `/organizations/${organizationId}/collection-runs/import-csv`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  previewCollectionRunCsv(
    organizationId: string,
    input: { csv: string; receivingTreasuryWalletId?: string },
  ) {
    return request<CollectionRunCsvPreview>(
      `/organizations/${organizationId}/collection-runs/import-csv/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getCollectionRun(organizationId: string, collectionRunId: string) {
    return request<CollectionRunSummary>(
      `/organizations/${organizationId}/collection-runs/${collectionRunId}`,
    );
  },
  getCollectionRunProof(organizationId: string, collectionRunId: string) {
    return request<CollectionRunProofPacket>(
      `/organizations/${organizationId}/collection-runs/${collectionRunId}/proof`,
    );
  },
  downloadCollectionRunProofJson(organizationId: string, collectionRunId: string) {
    return download(
      `/organizations/${organizationId}/collection-runs/${collectionRunId}/proof`,
      `collection-run-${collectionRunId}-proof.json`,
    );
  },

  // ─── Automation agents ───────────────────────────────────────────────────
  // Needed to find the agent wallet ID when creating a spending limit policy.
  // Every org has a default Decimal operations agent (auto-provisioned).

  listAutomationAgents(organizationId: string, filter: { status?: string } = {}) {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    const query = params.toString();
    return request<{ items: AutomationAgent[] }>(
      `/organizations/${organizationId}/automation-agents${query ? `?${query}` : ''}`,
    );
  },

  // ─── Spending limit policies ─────────────────────────────────────────────
  // Backend calls them "spending-limit-policies"; UI calls them
  // "Spending limits". Same thing.

  listSpendingLimitPolicies(
    organizationId: string,
    filter: {
      treasuryWalletId?: string;
      automationAgentId?: string;
      status?: string;
      limit?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (filter.treasuryWalletId) params.set('treasuryWalletId', filter.treasuryWalletId);
    if (filter.automationAgentId) params.set('automationAgentId', filter.automationAgentId);
    if (filter.status) params.set('status', filter.status);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    return request<{ items: SpendingLimitPolicy[] }>(
      `/organizations/${organizationId}/spending-limit-policies${query ? `?${query}` : ''}`,
    );
  },

  getSpendingLimitPolicy(organizationId: string, spendingLimitPolicyId: string) {
    return request<SpendingLimitPolicy>(
      `/organizations/${organizationId}/spending-limit-policies/${spendingLimitPolicyId}`,
    );
  },

  syncSpendingLimitPolicy(organizationId: string, spendingLimitPolicyId: string) {
    return request<SpendingLimitPolicy>(
      `/organizations/${organizationId}/spending-limit-policies/${spendingLimitPolicyId}/sync`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  },

  createSpendingLimitPolicyIntent(
    organizationId: string,
    treasuryWalletId: string,
    body: CreateSpendingLimitPolicyIntentRequest,
  ) {
    return request<SpendingLimitPolicyIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/config-proposals/add-spending-limit-intent`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  replaceSpendingLimitPolicyIntent(
    organizationId: string,
    spendingLimitPolicyId: string,
    body: ReplaceSpendingLimitPolicyIntentRequest,
  ) {
    return request<ReplaceSpendingLimitPolicyIntentResponse>(
      `/organizations/${organizationId}/spending-limit-policies/${spendingLimitPolicyId}/replace-intent`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  removeSpendingLimitPolicyIntent(
    organizationId: string,
    spendingLimitPolicyId: string,
    body: RemoveSpendingLimitPolicyIntentRequest,
  ) {
    return request<SpendingLimitPolicyIntentResponse>(
      `/organizations/${organizationId}/spending-limit-policies/${spendingLimitPolicyId}/remove-intent`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  listSpendingLimitExecutions(
    organizationId: string,
    filter: {
      spendingLimitPolicyId?: string;
      treasuryWalletId?: string;
      automationAgentId?: string;
      agentWalletId?: string;
      paymentOrderId?: string;
      status?: string;
      limit?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (filter.spendingLimitPolicyId) params.set('spendingLimitPolicyId', filter.spendingLimitPolicyId);
    if (filter.treasuryWalletId) params.set('treasuryWalletId', filter.treasuryWalletId);
    if (filter.automationAgentId) params.set('automationAgentId', filter.automationAgentId);
    if (filter.agentWalletId) params.set('agentWalletId', filter.agentWalletId);
    if (filter.paymentOrderId) params.set('paymentOrderId', filter.paymentOrderId);
    if (filter.status) params.set('status', filter.status);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    return request<{ items: SpendingLimitExecution[] }>(
      `/organizations/${organizationId}/spending-limit-executions${query ? `?${query}` : ''}`,
    );
  },

  listSpendingLimitPolicyExecutions(
    organizationId: string,
    spendingLimitPolicyId: string,
    filter: { status?: string; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    return request<{ items: SpendingLimitExecution[] }>(
      `/organizations/${organizationId}/spending-limit-policies/${spendingLimitPolicyId}/executions${query ? `?${query}` : ''}`,
    );
  },
};

function clearSessionToken() {
  sessionToken = null;
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
}

function loadStoredToken() {
  return window.localStorage.getItem(AUTH_STORAGE_KEY);
}


export type * from './types';
