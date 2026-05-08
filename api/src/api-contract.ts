export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type ApiEndpoint = {
  id: string;
  method: HttpMethod;
  path: string;
  tags: string[];
  summary: string;
  auth: 'public' | 'session' | 'service_token';
  scope?: string;
  requestBody?: Record<string, unknown>;
  query?: Record<string, unknown>;
  response?: Record<string, unknown>;
};

export const API_ENDPOINTS = [
  endpoint('health', 'GET', '/health', ['system'], 'Health check', 'public'),
  endpoint('capabilities', 'GET', '/capabilities', ['system'], 'Machine-readable API capability map', 'public'),
  endpoint('openapi', 'GET', '/openapi.json', ['system'], 'OpenAPI 3.1 specification', 'public'),
  endpoint('register', 'POST', '/auth/register', ['auth'], 'Create a user account and return a session', 'public', {
    requestBody: { email: 'string email', password: 'string min 8 chars', displayName: 'string optional' },
  }),
  endpoint('login', 'POST', '/auth/login', ['auth'], 'Create a user session with email and password', 'public', {
    requestBody: { email: 'string email', password: 'string min 8 chars' },
  }),
  endpoint('google_oauth_start', 'GET', '/auth/google/start', ['auth'], 'Start Google OAuth sign-in', 'public', {
    query: { returnTo: 'relative path optional', frontendOrigin: 'allowed frontend origin optional' },
  }),
  endpoint('google_oauth_callback', 'GET', '/auth/google/callback', ['auth'], 'Complete Google OAuth sign-in', 'public'),
  endpoint('preview_organization_invite', 'GET', '/invites/{inviteToken}', ['organization invites'], 'Preview an organization invite before accepting', 'public'),
  endpoint('session', 'GET', '/auth/session', ['auth'], 'Inspect current user session', 'session'),
  endpoint('verify_email', 'POST', '/auth/verify-email', ['auth'], 'Verify current user email with a code', 'session', {
    requestBody: { code: 'string' },
  }),
  endpoint('resend_verification', 'POST', '/auth/resend-verification', ['auth'], 'Issue a new email verification code', 'session'),
  endpoint('logout', 'POST', '/auth/logout', ['auth'], 'Invalidate current user session', 'session'),

  endpoint('list_personal_wallets', 'GET', '/personal-wallets', ['personal wallets'], 'List personal signing wallets for the current user', 'session'),
  endpoint('create_personal_wallet_challenge', 'POST', '/personal-wallets/challenge', ['personal wallets'], 'Create personal wallet ownership challenge', 'session', {
    requestBody: { walletAddress: 'string' },
  }),
  endpoint('connect_external_personal_wallet', 'POST', '/personal-wallets/external', ['personal wallets'], 'Connect external personal wallet with signed challenge', 'session'),
  endpoint('register_embedded_personal_wallet', 'POST', '/personal-wallets/embedded', ['personal wallets'], 'Register embedded personal wallet metadata', 'session'),
  endpoint('create_managed_personal_wallet', 'POST', '/personal-wallets/managed', ['personal wallets'], 'Create a managed personal signing wallet with a configured custody provider', 'session'),
  endpoint('delete_personal_wallet', 'DELETE', '/personal-wallets/{userWalletId}', ['personal wallets'], 'Delete a Privy embedded personal wallet and archive its local record', 'session'),
  endpoint('sign_personal_wallet_versioned_transaction', 'POST', '/personal-wallets/{userWalletId}/sign-versioned-transaction', ['personal wallets', 'squads'], 'Sign a Squads v4 versioned transaction with a Privy-backed personal wallet', 'session', {
    requestBody: { serializedTransactionBase64: 'string base64' },
  }),
  endpoint('list_legacy_user_wallets', 'GET', '/user-wallets', ['personal wallets'], 'Legacy alias for personal wallets', 'session'),

  endpoint('list_organizations', 'GET', '/organizations', ['organizations'], 'List organizations for the current user', 'session'),
  endpoint('organization_summary', 'GET', '/organizations/{organizationId}/summary', ['organizations'], 'Lightweight organization counts for shell navigation', 'session', { scope: 'organization:read' }),
  endpoint('create_organization', 'POST', '/organizations', ['organizations'], 'Create organization', 'session', {
    scope: 'organization:write',
    requestBody: { organizationName: 'string' },
  }),
  endpoint('join_organization', 'POST', '/organizations/{organizationId}/join', ['organizations'], 'Deprecated: joining requires an invite link', 'session'),
  endpoint('list_organization_members', 'GET', '/organizations/{organizationId}/members', ['organization invites'], 'List active organization members', 'session', { scope: 'organization:read' }),
  endpoint('list_organization_invites', 'GET', '/organizations/{organizationId}/invites', ['organization invites'], 'List organization invites', 'session', { scope: 'organization:write' }),
  endpoint('create_organization_invite', 'POST', '/organizations/{organizationId}/invites', ['organization invites'], 'Create an email-bound organization invite link', 'session', {
    scope: 'organization:write',
    requestBody: { email: 'string email', role: 'admin | member' },
  }),
  endpoint('revoke_organization_invite', 'POST', '/organizations/{organizationId}/invites/{organizationInviteId}/revoke', ['organization invites'], 'Revoke a pending organization invite', 'session', { scope: 'organization:write' }),
  endpoint('accept_organization_invite', 'POST', '/invites/{inviteToken}/accept', ['organization invites'], 'Accept an organization invite for the signed-in user', 'session'),

  endpoint('list_treasury_wallets', 'GET', '/organizations/{organizationId}/treasury-wallets', ['address book'], 'List owned treasury wallets', 'session', { scope: 'organization:read' }),
  endpoint('list_treasury_wallet_balances', 'GET', '/organizations/{organizationId}/treasury-wallets/balances', ['address book'], 'List treasury wallets with live SOL/USDC balances', 'session', { scope: 'organization:read' }),
  endpoint('create_treasury_wallet', 'POST', '/organizations/{organizationId}/treasury-wallets', ['address book'], 'Create owned treasury wallet', 'session', {
    scope: 'organization:write',
    requestBody: { chain: 'solana', address: 'string', displayName: 'string optional' },
  }),
  endpoint('create_squads_treasury_intent', 'POST', '/organizations/{organizationId}/treasury-wallets/squads/create-intent', ['treasury wallets', 'squads'], 'Prepare a signable Squads v4 treasury creation transaction', 'session', {
    scope: 'organization:write',
    requestBody: { creatorPersonalWalletId: 'uuid', threshold: 'number', members: 'array of personal wallets + permissions' },
  }),
  endpoint('confirm_squads_treasury', 'POST', '/organizations/{organizationId}/treasury-wallets/squads/confirm', ['treasury wallets', 'squads'], 'Verify onchain Squads multisig creation and persist the vault PDA as an organization treasury wallet', 'session', {
    scope: 'organization:write',
    requestBody: { signature: 'string', createKey: 'string', multisigPda: 'string', vaultIndex: 'number optional' },
  }),
  endpoint('get_squads_treasury_detail', 'GET', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/detail', ['treasury wallets', 'squads'], 'Read a Squads v4 treasury viewer payload with onchain config and local member linkage', 'session', { scope: 'organization:read' }),
  endpoint('get_squads_treasury_status', 'GET', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/status', ['treasury wallets', 'squads'], 'Read live Squads v4 multisig status for a treasury wallet', 'session', { scope: 'organization:read' }),
  endpoint('list_organization_squads_proposals', 'GET', '/organizations/{organizationId}/squads/proposals', ['treasury wallets', 'squads'], 'Aggregate Squads config proposals across every treasury in the organization the actor is a member of', 'session', { scope: 'organization:read' }),
  endpoint('list_squads_config_proposals', 'GET', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/config-proposals', ['treasury wallets', 'squads'], 'List Squads config proposals visible to the current onchain Squads member', 'session', { scope: 'organization:read' }),
  endpoint('get_squads_config_proposal', 'GET', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/config-proposals/{transactionIndex}', ['treasury wallets', 'squads'], 'Read one Squads config proposal visible to the current onchain Squads member', 'session', { scope: 'organization:read' }),
  endpoint('create_squads_add_member_proposal_intent', 'POST', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/config-proposals/add-member-intent', ['treasury wallets', 'squads'], 'Prepare a signable Squads config proposal that adds a member', 'session', {
    scope: 'organization:write',
    requestBody: { creatorPersonalWalletId: 'uuid', newMemberPersonalWalletId: 'uuid', permissions: ['initiate', 'vote', 'execute'], newThreshold: 'number optional' },
  }),
  endpoint('create_squads_change_threshold_proposal_intent', 'POST', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/config-proposals/change-threshold-intent', ['treasury wallets', 'squads'], 'Prepare a signable Squads config proposal that changes threshold', 'session', {
    scope: 'organization:write',
    requestBody: { creatorPersonalWalletId: 'uuid', newThreshold: 'number' },
  }),
  endpoint('create_squads_payment_proposal_intent', 'POST', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/vault-proposals/payment-intent', ['treasury wallets', 'squads', 'proposals'], 'Prepare a signable Squads vault proposal that pays a Decimal payment order', 'session', {
    scope: 'execution:write',
    requestBody: { paymentOrderId: 'uuid', creatorPersonalWalletId: 'uuid', memo: 'string optional' },
  }),
  endpoint('create_squads_payment_run_proposal_intent', 'POST', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/vault-proposals/payment-run-intent', ['treasury wallets', 'squads', 'payment runs', 'proposals'], 'Prepare one signable Squads vault proposal that pays every payable row in a Decimal payment run', 'session', {
    scope: 'execution:write',
    requestBody: { paymentRunId: 'uuid', creatorPersonalWalletId: 'uuid', memo: 'string optional' },
  }),
  endpoint('approve_squads_config_proposal_intent', 'POST', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/config-proposals/{transactionIndex}/approve-intent', ['treasury wallets', 'squads'], 'Prepare a signable Squads proposal approval transaction', 'session', {
    scope: 'organization:write',
    requestBody: { memberPersonalWalletId: 'uuid', memo: 'string optional' },
  }),
  endpoint('execute_squads_config_proposal_intent', 'POST', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/config-proposals/{transactionIndex}/execute-intent', ['treasury wallets', 'squads'], 'Prepare a signable Squads config proposal execution transaction', 'session', {
    scope: 'organization:write',
    requestBody: { memberPersonalWalletId: 'uuid' },
  }),
  endpoint('sync_squads_members', 'POST', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}/squads/sync-members', ['treasury wallets', 'squads'], 'Sync local Squads member authorizations from onchain multisig state', 'session', { scope: 'organization:write' }),
  endpoint('list_decimal_proposals', 'GET', '/organizations/{organizationId}/proposals', ['proposals'], 'List Decimal proposal records including Squads-backed config and vault proposals', 'session', { scope: 'organization:read' }),
  endpoint('get_decimal_proposal', 'GET', '/organizations/{organizationId}/proposals/{decimalProposalId}', ['proposals'], 'Read one Decimal proposal record with live Squads voting state when available', 'session', { scope: 'organization:read' }),
  endpoint('confirm_decimal_proposal_submission', 'POST', '/organizations/{organizationId}/proposals/{decimalProposalId}/confirm-submission', ['proposals'], 'Attach the proposal creation transaction signature after client submission', 'session', {
    scope: 'execution:write',
    requestBody: { signature: 'string' },
  }),
  endpoint('confirm_decimal_proposal_execution', 'POST', '/organizations/{organizationId}/proposals/{decimalProposalId}/confirm-execution', ['proposals'], 'Attach the proposal execution transaction signature after client submission', 'session', {
    scope: 'execution:write',
    requestBody: { signature: 'string' },
  }),
  endpoint('approve_decimal_proposal_intent', 'POST', '/organizations/{organizationId}/proposals/{decimalProposalId}/approve-intent', ['proposals', 'squads'], 'Prepare a signable Squads approval transaction for a Decimal proposal', 'session', {
    scope: 'execution:write',
    requestBody: { memberPersonalWalletId: 'uuid', memo: 'string optional' },
  }),
  endpoint('reject_decimal_proposal_intent', 'POST', '/organizations/{organizationId}/proposals/{decimalProposalId}/reject-intent', ['proposals', 'squads'], 'Prepare a signable Squads rejection transaction for a Decimal proposal', 'session', {
    scope: 'execution:write',
    requestBody: { memberPersonalWalletId: 'uuid', memo: 'string optional' },
  }),
  endpoint('execute_decimal_proposal_intent', 'POST', '/organizations/{organizationId}/proposals/{decimalProposalId}/execute-intent', ['proposals', 'squads'], 'Prepare a signable Squads execution transaction for a Decimal proposal', 'session', {
    scope: 'execution:write',
    requestBody: { memberPersonalWalletId: 'uuid' },
  }),
  endpoint('update_treasury_wallet', 'PATCH', '/organizations/{organizationId}/treasury-wallets/{treasuryWalletId}', ['address book'], 'Update owned treasury wallet', 'session', { scope: 'organization:write' }),
  endpoint('list_wallet_authorizations', 'GET', '/organizations/{organizationId}/wallet-authorizations', ['wallet authorizations'], 'List personal wallet authorizations for an organization', 'session', { scope: 'organization:read' }),
  endpoint('create_wallet_authorization', 'POST', '/organizations/{organizationId}/wallet-authorizations', ['wallet authorizations'], 'Authorize a personal wallet to act for an organization or treasury wallet', 'session', {
    scope: 'organization:write',
    requestBody: { userWalletId: 'uuid', treasuryWalletId: 'uuid optional', role: 'owner | admin | signer | approver optional' },
  }),
  endpoint('revoke_wallet_authorization', 'POST', '/organizations/{organizationId}/wallet-authorizations/{walletAuthorizationId}/revoke', ['wallet authorizations'], 'Revoke a personal wallet authorization', 'session', { scope: 'organization:write' }),

  endpoint('list_counterparties', 'GET', '/organizations/{organizationId}/counterparties', ['address book'], 'List counterparties', 'session', { scope: 'organization:read' }),
  endpoint('create_counterparty', 'POST', '/organizations/{organizationId}/counterparties', ['address book'], 'Create counterparty', 'session', { scope: 'organization:write' }),
  endpoint('update_counterparty', 'PATCH', '/organizations/{organizationId}/counterparties/{counterpartyId}', ['address book'], 'Update counterparty', 'session', { scope: 'organization:write' }),
  endpoint('list_destinations', 'GET', '/organizations/{organizationId}/destinations', ['address book'], 'List payment destinations', 'session', { scope: 'organization:read' }),
  endpoint('create_destination', 'POST', '/organizations/{organizationId}/destinations', ['address book'], 'Create counterparty payment destination', 'session', {
    scope: 'organization:write',
    requestBody: { walletAddress: 'string', tokenAccountAddress: 'string optional', label: 'string', trustState: 'trusted | unreviewed | restricted' },
  }),
  endpoint('update_destination', 'PATCH', '/organizations/{organizationId}/destinations/{destinationId}', ['address book'], 'Update payment destination', 'session', { scope: 'organization:write' }),
  endpoint('list_collection_sources', 'GET', '/organizations/{organizationId}/collection-sources', ['address book'], 'List inbound collection sources', 'session', { scope: 'organization:read' }),
  endpoint('create_collection_source', 'POST', '/organizations/{organizationId}/collection-sources', ['address book'], 'Create inbound collection source', 'session', {
    scope: 'organization:write',
    requestBody: { walletAddress: 'string', label: 'string', trustState: 'unreviewed | trusted | restricted | blocked' },
  }),
  endpoint('update_collection_source', 'PATCH', '/organizations/{organizationId}/collection-sources/{collectionSourceId}', ['address book'], 'Update inbound collection source', 'session', { scope: 'organization:write' }),

  endpoint('get_approval_policy', 'GET', '/organizations/{organizationId}/approval-policy', ['approval'], 'Get organization approval policy', 'session', { scope: 'organization:read' }),
  endpoint('update_approval_policy', 'PATCH', '/organizations/{organizationId}/approval-policy', ['approval'], 'Update organization approval policy', 'session', { scope: 'approvals:write' }),
  endpoint('approval_inbox', 'GET', '/organizations/{organizationId}/approval-inbox', ['approval'], 'List pending approvals', 'session', { scope: 'organization:read' }),
  endpoint('approval_decision', 'POST', '/organizations/{organizationId}/transfer-requests/{transferRequestId}/approval-decisions', ['approval'], 'Approve or reject transfer request', 'session', {
    scope: 'approvals:write',
    requestBody: { action: 'approve | reject', comment: 'string optional' },
  }),

  endpoint('list_payment_requests', 'GET', '/organizations/{organizationId}/payment-requests', ['inputs'], 'List payment requests', 'session', { scope: 'organization:read' }),
  endpoint('create_payment_request', 'POST', '/organizations/{organizationId}/payment-requests', ['inputs'], 'Create payment request', 'session', { scope: 'payments:write' }),
  endpoint('import_payment_requests_csv', 'POST', '/organizations/{organizationId}/payment-requests/import-csv', ['inputs'], 'Import payment requests from CSV', 'session', { scope: 'payments:write' }),
  endpoint('preview_payment_requests_csv', 'POST', '/organizations/{organizationId}/payment-requests/import-csv/preview', ['inputs'], 'Preview payment request CSV import without side effects', 'session', { scope: 'organization:read' }),
  endpoint('get_payment_request', 'GET', '/organizations/{organizationId}/payment-requests/{paymentRequestId}', ['inputs'], 'Get payment request detail', 'session', { scope: 'organization:read' }),
  endpoint('promote_payment_request', 'POST', '/organizations/{organizationId}/payment-requests/{paymentRequestId}/promote', ['inputs'], 'Promote payment request to payment order', 'session', { scope: 'payments:write' }),
  endpoint('cancel_payment_request', 'POST', '/organizations/{organizationId}/payment-requests/{paymentRequestId}/cancel', ['inputs'], 'Cancel payment request', 'session', { scope: 'payments:write' }),

  endpoint('list_payment_runs', 'GET', '/organizations/{organizationId}/payment-runs', ['payment runs'], 'List payment runs', 'session', { scope: 'organization:read' }),
  endpoint('import_payment_run_csv', 'POST', '/organizations/{organizationId}/payment-runs/import-csv', ['payment runs'], 'Import CSV as payment run', 'session', {
    scope: 'payments:write',
    requestBody: { csv: 'string', runName: 'string optional', importKey: 'string optional' },
  }),
  endpoint('preview_payment_run_csv', 'POST', '/organizations/{organizationId}/payment-runs/import-csv/preview', ['payment runs'], 'Preview payment run CSV import without side effects', 'session', { scope: 'organization:read' }),
  endpoint('get_payment_run', 'GET', '/organizations/{organizationId}/payment-runs/{paymentRunId}', ['payment runs'], 'Get payment run detail', 'session', { scope: 'organization:read' }),
  endpoint('delete_payment_run', 'DELETE', '/organizations/{organizationId}/payment-runs/{paymentRunId}', ['payment runs'], 'Delete payment run', 'session', { scope: 'payments:write' }),
  endpoint('cancel_payment_run', 'POST', '/organizations/{organizationId}/payment-runs/{paymentRunId}/cancel', ['payment runs'], 'Cancel payment run before execution evidence exists', 'session', { scope: 'payments:write' }),
  endpoint('close_payment_run', 'POST', '/organizations/{organizationId}/payment-runs/{paymentRunId}/close', ['payment runs'], 'Close fully settled payment run', 'session', { scope: 'payments:write' }),
  endpoint('prepare_payment_run_execution', 'POST', '/organizations/{organizationId}/payment-runs/{paymentRunId}/prepare-execution', ['payment runs'], 'Prepare batch execution packet', 'session', { scope: 'execution:write' }),
  endpoint('attach_payment_run_signature', 'POST', '/organizations/{organizationId}/payment-runs/{paymentRunId}/attach-signature', ['payment runs'], 'Attach submitted batch signature', 'session', { scope: 'execution:write' }),
  endpoint('payment_run_proof', 'GET', '/organizations/{organizationId}/payment-runs/{paymentRunId}/proof', ['proof'], 'Export payment run proof', 'session', {
    scope: 'proofs:read',
    query: { detail: 'summary | compact | full', format: 'json | markdown' },
  }),

  endpoint('list_collections', 'GET', '/organizations/{organizationId}/collections', ['collections'], 'List expected inbound collections', 'session', { scope: 'organization:read' }),
  endpoint('create_collection', 'POST', '/organizations/{organizationId}/collections', ['collections'], 'Create expected inbound collection', 'session', {
    scope: 'payments:write',
    requestBody: { receivingTreasuryWalletId: 'string uuid', amountRaw: 'string', reason: 'string', externalReference: 'string optional' },
  }),
  endpoint('preview_collections_csv', 'POST', '/organizations/{organizationId}/collections/import-csv/preview', ['collections'], 'Preview collection CSV import without side effects', 'session', { scope: 'organization:read' }),
  endpoint('get_collection', 'GET', '/organizations/{organizationId}/collections/{collectionRequestId}', ['collections'], 'Get expected collection detail', 'session', { scope: 'organization:read' }),
  endpoint('collection_proof', 'GET', '/organizations/{organizationId}/collections/{collectionRequestId}/proof', ['proof'], 'Export expected collection proof', 'session', {
    scope: 'proofs:read',
  }),
  endpoint('cancel_collection', 'POST', '/organizations/{organizationId}/collections/{collectionRequestId}/cancel', ['collections'], 'Cancel expected collection', 'session', { scope: 'payments:write' }),
  endpoint('list_collection_runs', 'GET', '/organizations/{organizationId}/collection-runs', ['collections'], 'List collection runs', 'session', { scope: 'organization:read' }),
  endpoint('import_collection_run_csv', 'POST', '/organizations/{organizationId}/collection-runs/import-csv', ['collections'], 'Import CSV as collection run', 'session', {
    scope: 'payments:write',
    requestBody: { csv: 'string', runName: 'string optional', receivingTreasuryWalletId: 'string optional' },
  }),
  endpoint('preview_collection_run_csv', 'POST', '/organizations/{organizationId}/collection-runs/import-csv/preview', ['collections'], 'Preview collection run CSV import', 'session', { scope: 'organization:read' }),
  endpoint('get_collection_run', 'GET', '/organizations/{organizationId}/collection-runs/{collectionRunId}', ['collections'], 'Get collection run detail', 'session', { scope: 'organization:read' }),
  endpoint('collection_run_proof', 'GET', '/organizations/{organizationId}/collection-runs/{collectionRunId}/proof', ['proof'], 'Export collection run proof', 'session', {
    scope: 'proofs:read',
    query: { detail: 'summary | compact | full' },
  }),

  endpoint('list_payment_orders', 'GET', '/organizations/{organizationId}/payment-orders', ['payment orders'], 'List payment orders', 'session', { scope: 'organization:read' }),
  endpoint('create_payment_order', 'POST', '/organizations/{organizationId}/payment-orders', ['payment orders'], 'Create payment order', 'session', { scope: 'payments:write' }),
  endpoint('get_payment_order', 'GET', '/organizations/{organizationId}/payment-orders/{paymentOrderId}', ['payment orders'], 'Get payment order detail', 'session', { scope: 'organization:read' }),
  endpoint('update_payment_order', 'PATCH', '/organizations/{organizationId}/payment-orders/{paymentOrderId}', ['payment orders'], 'Update payment order', 'session', { scope: 'payments:write' }),
  endpoint('submit_payment_order', 'POST', '/organizations/{organizationId}/payment-orders/{paymentOrderId}/submit', ['payment orders'], 'Submit payment order into approval/reconciliation workflow', 'session', { scope: 'payments:write' }),
  endpoint('cancel_payment_order', 'POST', '/organizations/{organizationId}/payment-orders/{paymentOrderId}/cancel', ['payment orders'], 'Cancel payment order', 'session', { scope: 'payments:write' }),
  endpoint('prepare_payment_order_execution', 'POST', '/organizations/{organizationId}/payment-orders/{paymentOrderId}/prepare-execution', ['payment orders'], 'Prepare signer-ready Solana transfer packet', 'session', { scope: 'execution:write' }),
  endpoint('create_payment_order_execution', 'POST', '/organizations/{organizationId}/payment-orders/{paymentOrderId}/create-execution', ['payment orders'], 'Record external execution handoff', 'session', { scope: 'execution:write' }),
  endpoint('attach_payment_order_signature', 'POST', '/organizations/{organizationId}/payment-orders/{paymentOrderId}/attach-signature', ['payment orders'], 'Attach submitted execution signature', 'session', { scope: 'execution:write' }),
  endpoint('payment_order_proof', 'GET', '/organizations/{organizationId}/payment-orders/{paymentOrderId}/proof', ['proof'], 'Export payment order proof', 'session', {
    scope: 'proofs:read',
    query: { format: 'json | markdown' },
  }),
  endpoint('list_transfers', 'GET', '/organizations/{organizationId}/transfers', ['reconciliation'], 'List observed transfers for watched wallets', 'session', { scope: 'reconciliation:read' }),
  endpoint('list_reconciliation', 'GET', '/organizations/{organizationId}/reconciliation', ['reconciliation'], 'List reconciliation queue', 'session', { scope: 'reconciliation:read' }),
  endpoint('list_reconciliation_queue', 'GET', '/organizations/{organizationId}/reconciliation-queue', ['reconciliation'], 'List reconciliation queue', 'session', { scope: 'reconciliation:read' }),
  endpoint('get_reconciliation_detail', 'GET', '/organizations/{organizationId}/reconciliation-queue/{transferRequestId}', ['reconciliation'], 'Get reconciliation detail', 'session', { scope: 'reconciliation:read' }),
  endpoint('explain_reconciliation', 'GET', '/organizations/{organizationId}/reconciliation-queue/{transferRequestId}/explain', ['reconciliation'], 'Explain reconciliation decision', 'session', { scope: 'reconciliation:read' }),
  endpoint('refresh_reconciliation', 'POST', '/organizations/{organizationId}/reconciliation-queue/{transferRequestId}/refresh', ['reconciliation'], 'Preview reconciliation refresh', 'session', { scope: 'reconciliation:read' }),
  endpoint('list_exceptions', 'GET', '/organizations/{organizationId}/exceptions', ['exceptions'], 'List reconciliation exceptions', 'session', { scope: 'reconciliation:read' }),
  endpoint('update_exception', 'PATCH', '/organizations/{organizationId}/exceptions/{exceptionId}', ['exceptions'], 'Update exception metadata', 'session', { scope: 'exceptions:write' }),
  endpoint('get_exception', 'GET', '/organizations/{organizationId}/exceptions/{exceptionId}', ['exceptions'], 'Get exception detail', 'session', { scope: 'reconciliation:read' }),
  endpoint('exception_action', 'POST', '/organizations/{organizationId}/exceptions/{exceptionId}/actions', ['exceptions'], 'Apply exception action', 'session', { scope: 'exceptions:write' }),
  endpoint('exception_note', 'POST', '/organizations/{organizationId}/exceptions/{exceptionId}/notes', ['exceptions'], 'Add exception note', 'session', { scope: 'exceptions:write' }),

  endpoint('members', 'GET', '/organizations/{organizationId}/members', ['ops'], 'List organization organization members', 'session', { scope: 'organization:read' }),
  endpoint('audit_log', 'GET', '/organizations/{organizationId}/audit-log', ['ops'], 'Organization audit log', 'session', { scope: 'proofs:read' }),
  endpoint('ops_health', 'GET', '/organizations/{organizationId}/ops-health', ['ops'], 'Organization ops health metrics', 'session', { scope: 'reconciliation:read' }),

  endpoint('internal_organizations', 'GET', '/internal/organizations', ['internal'], 'Worker organization snapshot', 'service_token'),
  endpoint('internal_matching_context', 'GET', '/internal/organizations/{organizationId}/matching-context', ['internal'], 'Worker matching context', 'service_token'),
  endpoint('internal_matching_index', 'GET', '/internal/matching-index', ['internal'], 'Worker matching index snapshot', 'service_token'),
  endpoint('internal_matching_index_events', 'GET', '/internal/matching-index/events', ['internal'], 'Worker matching index SSE', 'service_token'),
] as const satisfies readonly ApiEndpoint[];

export type ApiEndpointId = (typeof API_ENDPOINTS)[number]['id'];

function endpoint(
  id: string,
  method: HttpMethod,
  path: string,
  tags: string[],
  summary: string,
  auth: ApiEndpoint['auth'],
  options: Omit<ApiEndpoint, 'id' | 'method' | 'path' | 'tags' | 'summary' | 'auth'> = {},
): ApiEndpoint {
  return {
    id,
    method,
    path,
    tags,
    summary,
    auth,
    ...options,
  };
}
