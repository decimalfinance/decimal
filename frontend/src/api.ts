import type {
  AcceptInviteResponse,
  AuthenticatedSession,
  CapabilitiesResponse,
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
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: {
        'content-type': 'application/json',
        ...(includeAuth && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...(init?.headers ?? {}),
      },
      ...init,
    });
  } catch {
    // Network-level failure (server unreachable, DNS, CORS, offline). The raw
    // browser message is "Failed to fetch" — never show that to a user.
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0, 'network');
  }

  if (!response.ok) {
    // Prefer the server's own message (it's written to be read). Only fall back
    // to a friendly generic — never the raw "500 Internal Server Error" line.
    let message: string | null = null;
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
      // no JSON body — keep the generic fallback below
    }

    if (response.status === 401) {
      clearSessionToken();
      if (!message) {
        message = 'Your session has expired. Please sign in again.';
      }
    }

    if (!message) {
      message =
        response.status >= 500
          ? 'Something went wrong on our end. Please try again in a moment.'
          : 'That request could not be completed. Please try again.';
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

export interface AccountingStatus {
  connected: boolean;
  needsReauth: boolean;
  status: string;
  realmId: string | null;
  environment: string;
  accountMap: {
    apAccountId: string | null;
    apAccountName: string | null;
    clearingAccountId: string | null;
    clearingAccountName: string | null;
    defaultExpenseAccountId: string | null;
    defaultExpenseAccountName: string | null;
  } | null;
  mappingComplete: boolean;
  syncCounts: { synced: number; pending: number; error: number };
}

export interface QuickBooksAccount {
  id: string;
  name: string;
  acctNum: string | null;
  fullyQualifiedName: string;
  accountType: string;
  accountSubType: string | null;
  classification: string;
}

export interface GlCodingPrediction {
  codedExpenseAccountId: string | null;
  codedExpenseAccountName: string | null;
  predictionSource: 'vendor_history' | 'default' | 'none';
  confidenceScore: number | null;
  supportCount: number;
}

export interface VendorCodingRule {
  vendorCodingRuleId: string;
  counterpartyId: string;
  accountId: string;
  accountName: string | null;
  source: 'learned' | 'manual';
  learnedFromCount: number;
  updatedAt: string;
}

export interface GlCandidate {
  accountId: string;
  accountName: string | null;
  reason: 'rule' | 'vendor_history' | 'ocr' | 'frequent' | 'default';
  count?: number;
  weight?: number;
  rationale?: string | null;
}

export interface CodedLine {
  accountId: string;
  accountName?: string | null;
  amount: number;
  description?: string | null;
}

export interface CodingInboxItem {
  hasUncategorizedLines?: boolean;
  paymentOrderId: string;
  vendorLabel: string | null;
  amountUsdc: number;
  invoiceNumber: string | null;
  createdAt: string;
  coding: {
    accountId: string;
    accountName: string | null;
    lines: CodedLine[];
    billHeader?: { vendorName?: string | null; invoiceNumber?: string | null; billDate?: string | null };
  } | null;
  candidates: GlCandidate[];
  syncStatus: string | null;
}

export interface FailedSync {
  paymentOrderId: string;
  vendor: string;
  amountRaw: string;
  invoiceNumber: string | null;
  error: string | null;
  attempts: number;
}

export interface SyncedPayment {
  paymentOrderId: string;
  vendor: string;
  amountRaw: string;
  invoiceNumber: string | null;
  account: string | null;
  billId: string | null;
  syncedAt: string | null;
}

export interface AccountMapInput {
  apAccountId?: string | null;
  apAccountName?: string | null;
  clearingAccountId: string;
  clearingAccountName?: string | null;
  defaultExpenseAccountId: string;
  defaultExpenseAccountName?: string | null;
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
  // Developer sign-in for automated testing: secret-gated on the API and
  // confined to @dev.decimal.test personas. organizationName picks which of
  // the persona's orgs to land in. See LoginPage's dev panel.
  devLogin(input: { secret: string; email: string; displayName?: string; organizationName?: string }) {
    return request<LoginResponse & { landingOrganizationId?: string | null }>('/auth/dev/login', {
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
  getAccountingStatus(organizationId: string) {
    return request<AccountingStatus>(`/organizations/${organizationId}/accounting/quickbooks/status`);
  },
  listFailedSyncs(organizationId: string) {
    return request<{ items: FailedSync[] }>(
      `/organizations/${organizationId}/accounting/quickbooks/failed-syncs`,
    );
  },
  listSyncedPayments(organizationId: string) {
    return request<{ items: SyncedPayment[] }>(
      `/organizations/${organizationId}/accounting/quickbooks/synced`,
    );
  },
  getQuickBooksConnectUrl(organizationId: string) {
    const q = new URLSearchParams({ frontendOrigin: window.location.origin }).toString();
    return request<{ authorizeUrl: string }>(
      `/organizations/${organizationId}/accounting/quickbooks/connect?${q}`,
    );
  },
  listQuickBooksAccounts(organizationId: string) {
    return request<{ items: QuickBooksAccount[] }>(
      `/organizations/${organizationId}/accounting/quickbooks/accounts`,
    );
  },
  saveQuickBooksAccountMap(organizationId: string, body: AccountMapInput) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/accounting/quickbooks/account-map`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },
  disconnectQuickBooks(organizationId: string) {
    return request<void>(`/organizations/${organizationId}/accounting/quickbooks`, { method: 'DELETE' });
  },
  syncPaymentOrderAccounting(organizationId: string, paymentOrderId: string) {
    return request<{ outcome: string }>(
      `/organizations/${organizationId}/payment-orders/${paymentOrderId}/accounting/sync`,
      { method: 'POST' },
    );
  },
  listCodingInbox(organizationId: string) {
    return request<{ items: CodingInboxItem[] }>(
      `/organizations/${organizationId}/accounting/quickbooks/coding-inbox`,
    );
  },
  // Vendor coding rules: the vendor's default expense account (learned or manual).
  listVendorCodingRules(organizationId: string) {
    return request<{ items: VendorCodingRule[] }>(`/organizations/${organizationId}/vendor-coding-rules`);
  },
  setVendorCodingRule(organizationId: string, counterpartyId: string, body: { accountId: string; accountName?: string | null }) {
    return request<VendorCodingRule>(`/organizations/${organizationId}/counterparties/${counterpartyId}/coding-rule`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },
  clearVendorCodingRule(organizationId: string, counterpartyId: string) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/counterparties/${counterpartyId}/coding-rule`, {
      method: 'DELETE',
    });
  },
  getGlCandidates(organizationId: string, paymentOrderId: string) {
    return request<{ candidates: GlCandidate[]; vendorLabel: string | null }>(
      `/organizations/${organizationId}/payment-orders/${paymentOrderId}/gl-coding/candidates`,
    );
  },
  syncCodedPayments(organizationId: string) {
    return request<{ synced: number; skipped: number; error: number }>(
      `/organizations/${organizationId}/accounting/quickbooks/sync-coded`,
      { method: 'POST' },
    );
  },
  setPaymentOrderGlCoding(
    organizationId: string,
    paymentOrderId: string,
    body: {
      lines?: CodedLine[];
      codedExpenseAccountId?: string;
      codedExpenseAccountName?: string | null;
      predictedAccountId?: string | null;
      predictedAccountName?: string | null;
      predictionSource?: string | null;
      confidenceScore?: number | null;
      billHeader?: { vendorName?: string | null; invoiceNumber?: string | null; billDate?: string | null };
      correctionNote?: string | null;
    },
  ) {
    return request<{ codedExpenseAccountId: string; codedExpenseAccountName: string | null; predictionSource: string | null; confidenceScore: number | null; wasOverridden: boolean }>(
      `/organizations/${organizationId}/payment-orders/${paymentOrderId}/gl-coding`,
      { method: 'POST', body: JSON.stringify(body) },
    );
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
  // Vendor payable gate: held = admin sets/releases; blocked = primary admin only.
  setVendorPayableStatus(
    organizationId: string,
    counterpartyId: string,
    input: { status: 'payable' | 'held' | 'blocked'; reason?: string | null },
  ) {
    return request<Counterparty>(`/organizations/${organizationId}/counterparties/${counterpartyId}/payable-status`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
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
      isPrimary?: boolean;
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
  removeCounterpartyWallet(organizationId: string, counterpartyWalletId: string) {
    return request<{ removed: 'deleted' | 'archived' }>(
      `/organizations/${organizationId}/counterparty-wallets/${counterpartyWalletId}`,
      { method: 'DELETE' },
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

// --- Approvals engine ---------------------------------------------------------

export interface ApprovalTask {
  task_id: string;
  state: string;
  step_index: number;
  sla_deadline: string | null;
  approvable_id: string;
  type: string;
  total_minor_base: string;
  macro_state: string;
}

export interface ApprovalFlowPerson { name: string; email: string }
export type ApprovalFlowItem =
  | { kind: 'step'; depth: number; purpose: string; mode: string; m: number | null; people: ApprovalFlowPerson[] }
  | { kind: 'auto' | 'reject' | 'condition' | 'otherwise'; depth: number; text: string };

export interface ApprovalFlowSummary {
  approvableType: string;
  name: string;
  items: ApprovalFlowItem[];
}

export const approvalsApi = {
  listMyTasks(organizationId: string) {
    return request<{ items: ApprovalTask[] }>(`/organizations/${organizationId}/approvals/tasks`);
  },
  getPolicy(organizationId: string) {
    return request<{ flows: ApprovalFlowSummary[] }>(`/organizations/${organizationId}/approvals/policy`);
  },
  actOnTask(organizationId: string, taskId: string, command: Record<string, unknown>) {
    return request<{ replay: boolean; taskState: string; macroState: string }>(
      `/organizations/${organizationId}/approvals/tasks/${taskId}/command`,
      {
        method: 'POST',
        body: JSON.stringify({ command, idempotencyKey: crypto.randomUUID() }),
      },
    );
  },
};

export interface ProtectionCard {
  code: string;
  displayName: string;
  oneLiner: string;
  relaxable: boolean;
  relaxed: boolean;
  relaxedBy: string | null;
  relaxedAt: string | null;
  reviewAtHeadcount: number | null;
  scopedPeople: { id: string; name: string }[] | null;
}

export interface ProtectionPerson { id: string; name: string; email: string }

// Policies page aggregate: always-on gate stats + the org bill ceiling.
// (The R-pack itself stays on protectionsApi — same rows, same ceremony.)
export interface PoliciesOverview {
  ceilingUsd: number | null;
  gates: {
    duplicate: { overridesLast30Days: number };
    payable: { held: number; blocked: number };
    pinnedDestination: Record<string, never>;
  };
}
export const policiesApi = {
  get(organizationId: string) {
    return request<PoliciesOverview>(`/organizations/${organizationId}/policies`);
  },
  setCeiling(organizationId: string, amountUsd: number | null) {
    return request<{ ok: boolean; ceilingUsd: number | null }>(`/organizations/${organizationId}/policies/ceiling`, {
      method: 'PUT',
      body: JSON.stringify({ amountUsd }),
    });
  },
};

export const protectionsApi = {
  list(organizationId: string) {
    return request<{ protections: ProtectionCard[]; people: ProtectionPerson[]; requiresPassword: boolean }>(`/organizations/${organizationId}/protections`);
  },
  relax(organizationId: string, code: string, body: { password?: string; sheetContent: unknown; scopedPersonIds?: string[] | null }) {
    return request<{ relaxed: boolean }>(`/organizations/${organizationId}/protections/${code}/relax`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  retighten(organizationId: string, code: string) {
    return request<{ sweptTasks: number }>(`/organizations/${organizationId}/protections/${code}/retighten`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};

export interface InvoiceDocumentMeta {
  invoiceDocumentId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  pageCount: number | null;
  uploadedByUserId: string | null;
  createdAt: string;
}

export const invoiceDocumentsApi = {
  meta(organizationId: string, invoiceDocumentId: string) {
    return request<InvoiceDocumentMeta>(`/organizations/${organizationId}/invoice-documents/${invoiceDocumentId}/meta`);
  },
  // The document endpoint needs the auth header, so a plain URL in <iframe src>
  // won't work — fetch the bytes and hand back an object URL. Callers must
  // URL.revokeObjectURL it when the viewer unmounts.
  async fetchObjectUrl(organizationId: string, invoiceDocumentId: string) {
    const response = await fetch(`${API_BASE_URL}/organizations/${organizationId}/invoice-documents/${invoiceDocumentId}`, {
      headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
    });
    if (!response.ok) {
      throw new ApiError('Could not load the invoice document.', response.status, null);
    }
    const blob = await response.blob();
    return { url: URL.createObjectURL(blob), mimeType: blob.type };
  },
};

export type BillBucket = 'needs_review' | 'in_approval' | 'to_pay' | 'done' | 'needs_attention';

export interface WorkbenchBill {
  paymentOrderId: string;
  bucket: BillBucket;
  state: string;
  vendorName: string;
  description: string | null;
  amountUsd: number;
  amountOriginal: { amount: number; currency: string } | null;
  invoiceNumber: string | null;
  invoiceDocumentId: string | null;
  dueAt: string | null;
  createdAt: string;
  discountLabel: string | null;
  readiness: 'ready' | 'missing_info' | null;
  missing: string[];
  subStatus: {
    kind: 'plain' | 'person' | 'loud';
    text: string;
    tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    blockedBy?: { name: string } | null;
  };
  // Present when this bill was flagged as a duplicate and an admin cleared it.
  duplicateCleared: { byName: string; reason: string } | null;
}

export type DocSource = { page: number; box: [number, number, number, number] } | null;

export interface BillReviewField {
  key: string;
  label: string;
  value: string | number | null;
  state: 'read' | 'needs_look' | 'not_on_document' | 'confirmed';
  reason: string | null;
  source?: DocSource;
}

export interface CategoryOption { value: string; label: string; num?: string | null; group: string }

export interface BillReviewLine {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  category: string | null;
  source?: DocSource;
}

export interface BillReview {
  paymentOrderId: string;
  state: string;
  readOnly: boolean;
  // An approver sent this bill back for changes — shown as the reviewer's homework.
  sentBack: { reason: string | null; byName: string | null; at: string | null } | null;
  vendor: { name: string; email: string | null; nameSource?: DocSource; emailSource?: DocSource; isNew: boolean; trustState: string };
  document: { invoiceDocumentId: string; filename: string; mimeType: string; byteSize: number; pageCount: number | null } | null;
  fields: BillReviewField[];
  remitFields: BillReviewField[];
  lines: BillReviewLine[];
  categoryOptions: CategoryOption[];
  // Why the pre-filled category was suggested (vendor rule vs the document).
  codingSuggestionSource: { kind: 'rule' | 'ocr'; detail: string } | null;
  totalsSources: { lineItems: DocSource; tax: DocSource; total: DocSource };
  taxAmount: number | null;
  totalUsd: number;
  paymentBlock: { method: string | null; bankName: string | null; accountLast4: string | null; sendToLabel: string; sourceTreasuryWalletId: string | null; matchesVerified: boolean };
  flags: Array<{ kind: string; severity: 'danger' | 'warning' | 'info'; message: string; blocking: boolean }>;
  verification: { confirmedAt: string | null; confirmedByUserId: string | null; noteForApprovers: string | null } | null;
}

export interface ConfirmBillBody {
  fields: {
    vendorName?: string | null;
    vendorEmail?: string | null;
    invoiceNumber?: string | null;
    invoiceDate?: string | null;
    dueDate?: string | null;
    terms?: string | null;
    poNumber?: string | null;
    discount?: string | null;
    currency?: string | null;
    total?: number;
    taxAmount?: number | null;
    remitTo?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null };
  };
  lines: Array<{ description: string; quantity: number | null; unitPrice: number | null; amount: number | null; category?: string | null }>;
  confirmedFieldKeys: string[];
  noteForApprovers?: string | null;
  sourceTreasuryWalletId?: string | null;
}

export const billsApi = {
  workbench(organizationId: string) {
    return request<{ counts: Record<BillBucket, number>; reviewCounts: { ready: number; missingInfo: number }; bills: WorkbenchBill[] }>(`/organizations/${organizationId}/bills/workbench`);
  },
  review(organizationId: string, paymentOrderId: string) {
    return request<BillReview>(`/organizations/${organizationId}/bills/${paymentOrderId}/review`);
  },
  detail(organizationId: string, paymentOrderId: string) {
    return request<BillDetail>(`/organizations/${organizationId}/bills/${paymentOrderId}/detail`);
  },
  updateFacts(organizationId: string, paymentOrderId: string, facts: Record<string, unknown>) {
    return request<{ changed: number }>(`/organizations/${organizationId}/bills/${paymentOrderId}/facts`, {
      method: 'PATCH',
      body: JSON.stringify(facts),
    });
  },
  confirm(organizationId: string, paymentOrderId: string, body: ConfirmBillBody) {
    return request<{ approvableId: string | null }>(`/organizations/${organizationId}/bills/${paymentOrderId}/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  notABill(organizationId: string, paymentOrderId: string, body: { reason: 'duplicate' | 'statement' | 'not_ours' | 'unreadable' | 'other'; note?: string | null }) {
    return request<unknown>(`/organizations/${organizationId}/bills/${paymentOrderId}/not-a-bill`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  // Admin-only: clear the duplicate-bill flag with a logged reason.
  overrideDuplicate(organizationId: string, paymentOrderId: string, reason: string) {
    return request<BillReview>(`/organizations/${organizationId}/bills/${paymentOrderId}/duplicate-override`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  // Admin-only: unwind an approved-but-unpaid bill back to review (the
  // recovery path when a release gate refuses).
  sendBack(organizationId: string, paymentOrderId: string, reason: string) {
    return request<BillReview>(`/organizations/${organizationId}/bills/${paymentOrderId}/send-back`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
};

export interface InvoiceDocumentStatus {
  invoiceDocumentId: string;
  filename: string;
  mimeType: string;
  status: 'processing' | 'processed' | 'failed';
  processingError: string | null;
  pageCount: number | null;
  pagesStored: number;
  paymentOrders: Array<{ paymentOrderId: string; state: string }>;
}

export const invoiceIntakeApi = {
  uploadAsync(organizationId: string, body: { filename: string; mimeType: string; dataBase64: string; sourceTreasuryWalletId?: string | null }) {
    return request<{ invoiceDocumentId: string; reused: boolean }>(`/organizations/${organizationId}/invoices/upload-async`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  status(organizationId: string, invoiceDocumentId: string) {
    return request<InvoiceDocumentStatus>(`/organizations/${organizationId}/invoice-documents/${invoiceDocumentId}/status`);
  },
  // Rendered page image as an object URL (endpoint needs the auth header).
  async fetchPageObjectUrl(organizationId: string, invoiceDocumentId: string, pageIndex: number) {
    const response = await fetch(`${API_BASE_URL}/organizations/${organizationId}/invoice-documents/${invoiceDocumentId}/pages/${pageIndex}`, {
      headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
    });
    if (!response.ok) throw new ApiError('Could not load the page image.', response.status, null);
    return URL.createObjectURL(await response.blob());
  },
};

export interface BillDetailStepNode {
  stepIndex: number;
  person: { personId: string; name: string; avatarUrl: string | null } | null;
  purpose: string | null;
  mode: string;
  state: 'done' | 'current' | 'upcoming' | 'declined' | 'stopped' | 'delegated';
  actedAt: string | null;
  declineReason: string | null;
  thread: {
    open: boolean;
    waitingOn: string | null;
    messages: Array<{ person: { personId: string; name: string; avatarUrl: string | null } | null; body: string; at: string }>;
  } | null;
}

export interface BillDetail {
  review: BillReview;
  corrections: Array<{ field: string; from: string; to: string; by: string | null }>;
  // Advisory: routine vs worth-a-look, same classifier as the approvals inbox.
  signal?: InboxSignal;
  status: { macroState: string | null; subStatus: WorkbenchBill['subStatus'] };
  approval: {
    approvableId: string;
    macroState: string;
    steps: BillDetailStepNode[];
    flowVersion: number | null;
    protectionNote: string | null;
    release: { macroState: string } | null;
  } | null;
  viewer: {
    personId: string | null;
    name: string | null;
    isRequester: boolean;
    openTaskId: string | null;
    viewerHasOpenAsk?: boolean;
    openAskTaskId?: string | null;
    anyTaskId: string | null;
  };
  requester: { personId: string; name: string; avatarUrl: string | null } | null;
}

export type FlowSplit =
  | { kind: 'vendor'; vendorIds: string[]; vendorNames: string[] }
  | { kind: 'category'; categories: string[] }
  | { kind: 'firstBill' };
export type FlowNode =
  | { id: string; type: 'step'; title: string; approvers: string[]; quorum: 'all' | 'any' | number; purpose?: string | null }
  | { id: string; type: 'if'; amountGteUsd: number; split?: FlowSplit | null; then: FlowNode[]; otherwise: FlowNode[] }
  | { id: string; type: 'auto' }
  | { id: string; type: 'notify'; people: string[] };

export interface FlowPerson { id: string; name: string; email: string; user_id: string | null; roles: string[] }

export interface FlowSimResult {
  stuck: string | null;
  chain: Array<{ personId: string; name: string; step: string; why: string; kind: 'always' | 'added' | 'standin' }>;
  notes: string[];
  summary: string | null;
}

export const flowApi = {
  get(organizationId: string) {
    return request<{ flow: FlowNode[] | null; draft?: FlowNode[] | null; people: FlowPerson[]; vendors?: Array<{ id: string; name: string }>; categoryOptions?: string[]; version: number | null }>(`/organizations/${organizationId}/approvals/flow`);
  },
  simulate(organizationId: string, flow: FlowNode[], sample: { amountUsd: number; requesterPersonId: string | null; vendorId?: string | null; category?: string | null }) {
    return request<FlowSimResult>(`/organizations/${organizationId}/approvals/flow/simulate`, {
      method: 'POST', body: JSON.stringify({ flow, sample }),
    });
  },
  saveDraft(organizationId: string, flow: FlowNode[]) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/flow/draft`, {
      method: 'PUT', body: JSON.stringify({ flow }),
    });
  },
  clearDraft(organizationId: string) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/flow/draft`, { method: 'DELETE' });
  },
  publish(organizationId: string, flow: FlowNode[]) {
    return request<{ policyId: string; version: number }>(`/organizations/${organizationId}/approvals/flow/publish`, {
      method: 'POST', body: JSON.stringify({ flow }),
    });
  },
  assist(organizationId: string, message: string, flow: FlowNode[]) {
    return request<FlowAssistResult>(`/organizations/${organizationId}/approvals/flow/assist`, {
      method: 'POST', body: JSON.stringify({ message, flow }),
    });
  },
  // Streaming assist over SSE: narrates real steps and drops the flow onto the
  // canvas mid-generation, then resolves with the final result. Pass a signal to
  // support Stop. Consumed with fetch + ReadableStream (POST body + auth header).
  async assistStream(
    organizationId: string,
    message: string,
    flow: FlowNode[],
    handlers: {
      onStatus?: (s: { step: string; label: string }) => void;
      onFlow?: (flow: FlowNode[]) => void;
      signal?: AbortSignal;
    },
  ): Promise<FlowAssistResult> {
    const res = await fetch(`${API_BASE_URL}/organizations/${organizationId}/approvals/flow/assist/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
      body: JSON.stringify({ message, flow }),
      signal: handlers.signal,
    });
    if (!res.ok || !res.body) throw new ApiError('Could not reach the assistant.', res.status, 'assist');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: FlowAssistResult | null = null;
    let errored: string | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? ''; // keep the trailing partial frame
      for (const frame of frames) {
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (event === 'status') handlers.onStatus?.(parsed as { step: string; label: string });
        else if (event === 'flow') handlers.onFlow?.((parsed as { flow: FlowNode[] }).flow);
        else if (event === 'done') result = parsed as FlowAssistResult;
        else if (event === 'error') errored = (parsed as { message: string }).message;
      }
    }
    if (errored) throw new ApiError(errored, 500, 'assist');
    if (!result) throw new ApiError('The assistant stopped early.', 500, 'assist');
    return result;
  },
};

export interface InboxSignal { clean: boolean; label: string; detail: string | null }
export interface InboxWaitingRow {
  taskId: string;
  paymentOrderId: string;
  vendor: string;
  what: string;
  invoice: string | null;
  amountUsd: number;
  overdueDays: number | null;
  dueSoonDays: number | null;
  progText: string;
  hint: string | null;
  signal: InboxSignal;
  blocked: boolean;
}
export interface InboxInFlightRow {
  taskId: string;
  paymentOrderId: string;
  vendor: string;
  what: string;
  invoice: string | null;
  amountUsd: number;
  nowWith: string | null;
  stalledDays: number | null;
}
export interface ApprovalsInbox {
  waitingOnYou: InboxWaitingRow[];
  inFlight: InboxInFlightRow[];
  summary: { flagCount: number; cleanCount: number; totalWaitingUsd: number };
}

export const approvalsInboxApi = {
  get(organizationId: string) {
    return request<ApprovalsInbox>(`/organizations/${organizationId}/bills/approvals-inbox`);
  },
};

export interface ReleaseConfig { approvers: string[]; quorum: 'all' | 'any' | number; configured: boolean; people: FlowPerson[] }
export const releaseApi = {
  get(organizationId: string) {
    return request<ReleaseConfig>(`/organizations/${organizationId}/approvals/release`);
  },
  publish(organizationId: string, approvers: string[], quorum: 'all' | 'any' | number) {
    return request<{ policyId: string; version: number }>(`/organizations/${organizationId}/approvals/release/publish`, {
      method: 'POST', body: JSON.stringify({ approvers, quorum }),
    });
  },
};

// Review stage (control point #1) — same shape as the approval flow, on its own
// endpoint. A bill must clear this before it enters approval.
export const reviewApi = {
  get(organizationId: string) {
    return request<{ flow: FlowNode[] | null; draft?: FlowNode[] | null; people: FlowPerson[]; vendors?: Array<{ id: string; name: string }>; categoryOptions?: string[]; version: number | null }>(`/organizations/${organizationId}/approvals/review`);
  },
  saveDraft(organizationId: string, flow: FlowNode[]) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/review/draft`, { method: 'PUT', body: JSON.stringify({ flow }) });
  },
  clearDraft(organizationId: string) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/review/draft`, { method: 'DELETE' });
  },
  publish(organizationId: string, flow: FlowNode[]) {
    return request<{ policyId: string; version: number }>(`/organizations/${organizationId}/approvals/review/publish`, { method: 'POST', body: JSON.stringify({ flow }) });
  },
};

// Separation-of-duties switches — the org's own choice, not ours.
export interface SeparationSettings { reviewerCanApprove: boolean; submitterCanApprove: boolean; approverCanRelease: boolean }
export const separationApi = {
  get(organizationId: string) {
    return request<SeparationSettings>(`/organizations/${organizationId}/approvals/separation`);
  },
  set(organizationId: string, settings: SeparationSettings) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/separation`, { method: 'POST', body: JSON.stringify(settings) });
  },
};

// Out-of-office fill-in: while you're away, your open approvals also go to your
// substitute (self-service, like every mature AP product).
export interface OutOfOffice { substitutePersonId: string; substituteName: string; endsAt: string }
export const oooApi = {
  get(organizationId: string) {
    return request<{ outOfOffice: OutOfOffice | null }>(`/organizations/${organizationId}/approvals/out-of-office`);
  },
  set(organizationId: string, substitutePersonId: string, endsAt: string) {
    return request<{ ok: boolean; mirrored: number }>(`/organizations/${organizationId}/approvals/out-of-office`, {
      method: 'PUT', body: JSON.stringify({ substitutePersonId, endsAt }),
    });
  },
  clear(organizationId: string) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/out-of-office`, { method: 'DELETE' });
  },
};

// Payment stage as a full flow (payment_run policy) — same shape as review.
export const paymentFlowApi = {
  get(organizationId: string) {
    return request<{ flow: FlowNode[] | null; draft?: FlowNode[] | null; people: FlowPerson[]; vendors?: Array<{ id: string; name: string }>; categoryOptions?: string[]; version: number | null }>(`/organizations/${organizationId}/approvals/payment-flow`);
  },
  saveDraft(organizationId: string, flow: FlowNode[]) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/payment-flow/draft`, { method: 'PUT', body: JSON.stringify({ flow }) });
  },
  clearDraft(organizationId: string) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/approvals/payment-flow/draft`, { method: 'DELETE' });
  },
  publish(organizationId: string, flow: FlowNode[]) {
    return request<{ policyId: string; version: number }>(`/organizations/${organizationId}/approvals/payment-flow/publish`, { method: 'POST', body: JSON.stringify({ flow }) });
  },
};

// Whole-pipeline dry run for the Test rail.
export interface PipelineStage { chain: FlowSimResult['chain']; notes: string[]; stuck: string | null; resolvedIds: string[] }
export interface PipelineSimResult { review: PipelineStage; approve: PipelineStage; release: PipelineStage; stuck: string | null; flags: SeparationSettings }
export const pipelineApi = {
  simulate(organizationId: string, input: { reviewFlow: FlowNode[]; approveFlow: FlowNode[]; releaseFlow: FlowNode[]; amountUsd: number; submitterPersonId: string | null; vendorId?: string | null; category?: string | null; firstBill?: boolean | null; separation?: SeparationSettings | null }) {
    return request<PipelineSimResult>(`/organizations/${organizationId}/approvals/pipeline/simulate`, { method: 'POST', body: JSON.stringify(input) });
  },
};

export interface FlowAssistResult {
  flow: FlowNode[];
  explanation: string;
  outcome: string | null;
  deadlock?: boolean;
  // Set when the request was too ambiguous to build — the assistant asks a
  // question instead of guessing, and the flow is left unchanged.
  clarify?: string | null;
}


// Prebuilt roles: a fixed set of permission bundles (reviewer/approver/payer/
// viewer). Assignment only — the set itself is not editable.
export type RoleKey = 'reviewer' | 'approver' | 'payer' | 'viewer';
export interface OrgRole { key: RoleKey; name: string; summary: string; holders: { personId: string; name: string; userId: string | null }[] }
export interface MemberWithRoles { userId: string; personId: string | null; name: string; email: string; access: string; roles: RoleKey[] }
export interface MembersAndRoles { members: MemberWithRoles[]; roles: OrgRole[] }

export const rolesApi = {
  get(organizationId: string) {
    return request<MembersAndRoles>(`/organizations/${organizationId}/roles`);
  },
  assign(organizationId: string, roleKey: RoleKey, userId: string) {
    return request<{ ok: boolean; personId: string }>(`/organizations/${organizationId}/roles/${roleKey}/holders`, { method: 'POST', body: JSON.stringify({ userId }) });
  },
  unassign(organizationId: string, roleKey: RoleKey, personId: string) {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/roles/${roleKey}/holders/${personId}`, { method: 'DELETE' });
  },
};

// The caller's own resolved access — what nav and pages gate on.
export type Capability =
  | 'bills.view' | 'bills.edit' | 'approvals.act'
  | 'payments.view' | 'payments.sign' | 'treasury.view' | 'treasury.manage'
  | 'vendors.view' | 'vendors.manage' | 'accounting.view' | 'accounting.manage'
  | 'members.view' | 'members.manage' | 'governance.view' | 'governance.edit';
export interface MyAccess { membershipRole: string; roles: RoleKey[]; capabilities: Capability[]; isOwnerOrAdmin: boolean }
export const accessApi = {
  get(organizationId: string) {
    return request<MyAccess>(`/organizations/${organizationId}/my-access`);
  },
  // Access tiers: exactly one primary admin per org; only they touch the admin tier.
  setMemberAccess(organizationId: string, userId: string, access: 'admin' | 'member') {
    return request<{ ok: boolean }>(`/organizations/${organizationId}/members/${userId}/access`, { method: 'PATCH', body: JSON.stringify({ access }) });
  },
  transferPrimaryAdmin(organizationId: string, userId: string) {
    return request<{ ok: boolean; primaryAdminUserId: string }>(`/organizations/${organizationId}/primary-admin/transfer`, { method: 'POST', body: JSON.stringify({ userId }) });
  },
};
