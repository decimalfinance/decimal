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
  endpoint('login', 'POST', '/auth/login', ['auth'], 'Create or resume a user session', 'public', {
    requestBody: { email: 'string email', displayName: 'string optional' },
  }),
  endpoint('session', 'GET', '/auth/session', ['auth'], 'Inspect current user session', 'session'),
  endpoint('logout', 'POST', '/auth/logout', ['auth'], 'Invalidate current user session', 'session'),

  endpoint('list_organizations', 'GET', '/organizations', ['organizations'], 'List organizations for the current user', 'session'),
  endpoint('create_organization', 'POST', '/organizations', ['organizations'], 'Create organization', 'session', {
    scope: 'workspace:write',
    requestBody: { organizationName: 'string' },
  }),
  endpoint('join_organization', 'POST', '/organizations/{organizationId}/join', ['organizations'], 'Join organization', 'session'),
  endpoint('list_workspaces', 'GET', '/organizations/{organizationId}/workspaces', ['organizations'], 'List organization workspaces', 'session'),
  endpoint('create_workspace', 'POST', '/organizations/{organizationId}/workspaces', ['organizations'], 'Create workspace', 'session', {
    requestBody: { workspaceName: 'string' },
  }),

  endpoint('list_treasury_wallets', 'GET', '/workspaces/{workspaceId}/treasury-wallets', ['address book'], 'List owned treasury wallets', 'session', { scope: 'workspace:read' }),
  endpoint('list_treasury_wallet_balances', 'GET', '/workspaces/{workspaceId}/treasury-wallets/balances', ['address book'], 'List treasury wallets with live SOL/USDC balances', 'session', { scope: 'workspace:read' }),
  endpoint('create_treasury_wallet', 'POST', '/workspaces/{workspaceId}/treasury-wallets', ['address book'], 'Create owned treasury wallet', 'session', {
    scope: 'workspace:write',
    requestBody: { chain: 'solana', address: 'string', displayName: 'string optional' },
  }),
  endpoint('update_treasury_wallet', 'PATCH', '/workspaces/{workspaceId}/treasury-wallets/{treasuryWalletId}', ['address book'], 'Update owned treasury wallet', 'session', { scope: 'workspace:write' }),

  endpoint('list_counterparties', 'GET', '/workspaces/{workspaceId}/counterparties', ['address book'], 'List counterparties', 'session', { scope: 'workspace:read' }),
  endpoint('create_counterparty', 'POST', '/workspaces/{workspaceId}/counterparties', ['address book'], 'Create counterparty', 'session', { scope: 'workspace:write' }),
  endpoint('update_counterparty', 'PATCH', '/workspaces/{workspaceId}/counterparties/{counterpartyId}', ['address book'], 'Update counterparty', 'session', { scope: 'workspace:write' }),
  endpoint('list_destinations', 'GET', '/workspaces/{workspaceId}/destinations', ['address book'], 'List payment destinations', 'session', { scope: 'workspace:read' }),
  endpoint('create_destination', 'POST', '/workspaces/{workspaceId}/destinations', ['address book'], 'Create counterparty payment destination', 'session', {
    scope: 'workspace:write',
    requestBody: { walletAddress: 'string', tokenAccountAddress: 'string optional', label: 'string', trustState: 'trusted | unreviewed | restricted' },
  }),
  endpoint('update_destination', 'PATCH', '/workspaces/{workspaceId}/destinations/{destinationId}', ['address book'], 'Update payment destination', 'session', { scope: 'workspace:write' }),
  endpoint('list_collection_sources', 'GET', '/workspaces/{workspaceId}/collection-sources', ['address book'], 'List inbound collection sources', 'session', { scope: 'workspace:read' }),
  endpoint('create_collection_source', 'POST', '/workspaces/{workspaceId}/collection-sources', ['address book'], 'Create inbound collection source', 'session', {
    scope: 'workspace:write',
    requestBody: { walletAddress: 'string', label: 'string', trustState: 'unreviewed | trusted | restricted | blocked' },
  }),
  endpoint('update_collection_source', 'PATCH', '/workspaces/{workspaceId}/collection-sources/{collectionSourceId}', ['address book'], 'Update inbound collection source', 'session', { scope: 'workspace:write' }),

  endpoint('get_approval_policy', 'GET', '/workspaces/{workspaceId}/approval-policy', ['approval'], 'Get workspace approval policy', 'session', { scope: 'workspace:read' }),
  endpoint('update_approval_policy', 'PATCH', '/workspaces/{workspaceId}/approval-policy', ['approval'], 'Update workspace approval policy', 'session', { scope: 'approvals:write' }),
  endpoint('approval_inbox', 'GET', '/workspaces/{workspaceId}/approval-inbox', ['approval'], 'List pending approvals', 'session', { scope: 'workspace:read' }),
  endpoint('approval_decision', 'POST', '/workspaces/{workspaceId}/transfer-requests/{transferRequestId}/approval-decisions', ['approval'], 'Approve or reject transfer request', 'session', {
    scope: 'approvals:write',
    requestBody: { action: 'approve | reject', comment: 'string optional' },
  }),

  endpoint('list_payment_requests', 'GET', '/workspaces/{workspaceId}/payment-requests', ['inputs'], 'List payment requests', 'session', { scope: 'workspace:read' }),
  endpoint('create_payment_request', 'POST', '/workspaces/{workspaceId}/payment-requests', ['inputs'], 'Create payment request', 'session', { scope: 'payments:write' }),
  endpoint('import_payment_requests_csv', 'POST', '/workspaces/{workspaceId}/payment-requests/import-csv', ['inputs'], 'Import payment requests from CSV', 'session', { scope: 'payments:write' }),
  endpoint('preview_payment_requests_csv', 'POST', '/workspaces/{workspaceId}/payment-requests/import-csv/preview', ['inputs'], 'Preview payment request CSV import without side effects', 'session', { scope: 'workspace:read' }),
  endpoint('get_payment_request', 'GET', '/workspaces/{workspaceId}/payment-requests/{paymentRequestId}', ['inputs'], 'Get payment request detail', 'session', { scope: 'workspace:read' }),
  endpoint('promote_payment_request', 'POST', '/workspaces/{workspaceId}/payment-requests/{paymentRequestId}/promote', ['inputs'], 'Promote payment request to payment order', 'session', { scope: 'payments:write' }),
  endpoint('cancel_payment_request', 'POST', '/workspaces/{workspaceId}/payment-requests/{paymentRequestId}/cancel', ['inputs'], 'Cancel payment request', 'session', { scope: 'payments:write' }),

  endpoint('list_payment_runs', 'GET', '/workspaces/{workspaceId}/payment-runs', ['payment runs'], 'List payment runs', 'session', { scope: 'workspace:read' }),
  endpoint('import_payment_run_csv', 'POST', '/workspaces/{workspaceId}/payment-runs/import-csv', ['payment runs'], 'Import CSV as payment run', 'session', {
    scope: 'payments:write',
    requestBody: { csv: 'string', runName: 'string optional', importKey: 'string optional' },
  }),
  endpoint('preview_payment_run_csv', 'POST', '/workspaces/{workspaceId}/payment-runs/import-csv/preview', ['payment runs'], 'Preview payment run CSV import without side effects', 'session', { scope: 'workspace:read' }),
  endpoint('get_payment_run', 'GET', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}', ['payment runs'], 'Get payment run detail', 'session', { scope: 'workspace:read' }),
  endpoint('delete_payment_run', 'DELETE', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}', ['payment runs'], 'Delete payment run', 'session', { scope: 'payments:write' }),
  endpoint('cancel_payment_run', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/cancel', ['payment runs'], 'Cancel payment run before execution evidence exists', 'session', { scope: 'payments:write' }),
  endpoint('close_payment_run', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/close', ['payment runs'], 'Close fully settled payment run', 'session', { scope: 'payments:write' }),
  endpoint('prepare_payment_run_execution', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/prepare-execution', ['payment runs'], 'Prepare batch execution packet', 'session', { scope: 'execution:write' }),
  endpoint('attach_payment_run_signature', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/attach-signature', ['payment runs'], 'Attach submitted batch signature', 'session', { scope: 'execution:write' }),
  endpoint('payment_run_proof', 'GET', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/proof', ['proof'], 'Export payment run proof', 'session', {
    scope: 'proofs:read',
    query: { detail: 'summary | compact | full', format: 'json | markdown' },
  }),

  endpoint('list_collections', 'GET', '/workspaces/{workspaceId}/collections', ['collections'], 'List expected inbound collections', 'session', { scope: 'workspace:read' }),
  endpoint('create_collection', 'POST', '/workspaces/{workspaceId}/collections', ['collections'], 'Create expected inbound collection', 'session', {
    scope: 'payments:write',
    requestBody: { receivingTreasuryWalletId: 'string uuid', amountRaw: 'string', reason: 'string', externalReference: 'string optional' },
  }),
  endpoint('preview_collections_csv', 'POST', '/workspaces/{workspaceId}/collections/import-csv/preview', ['collections'], 'Preview collection CSV import without side effects', 'session', { scope: 'workspace:read' }),
  endpoint('get_collection', 'GET', '/workspaces/{workspaceId}/collections/{collectionRequestId}', ['collections'], 'Get expected collection detail', 'session', { scope: 'workspace:read' }),
  endpoint('collection_proof', 'GET', '/workspaces/{workspaceId}/collections/{collectionRequestId}/proof', ['proof'], 'Export expected collection proof', 'session', {
    scope: 'proofs:read',
  }),
  endpoint('cancel_collection', 'POST', '/workspaces/{workspaceId}/collections/{collectionRequestId}/cancel', ['collections'], 'Cancel expected collection', 'session', { scope: 'payments:write' }),
  endpoint('list_collection_runs', 'GET', '/workspaces/{workspaceId}/collection-runs', ['collections'], 'List collection runs', 'session', { scope: 'workspace:read' }),
  endpoint('import_collection_run_csv', 'POST', '/workspaces/{workspaceId}/collection-runs/import-csv', ['collections'], 'Import CSV as collection run', 'session', {
    scope: 'payments:write',
    requestBody: { csv: 'string', runName: 'string optional', receivingTreasuryWalletId: 'string optional' },
  }),
  endpoint('preview_collection_run_csv', 'POST', '/workspaces/{workspaceId}/collection-runs/import-csv/preview', ['collections'], 'Preview collection run CSV import', 'session', { scope: 'workspace:read' }),
  endpoint('get_collection_run', 'GET', '/workspaces/{workspaceId}/collection-runs/{collectionRunId}', ['collections'], 'Get collection run detail', 'session', { scope: 'workspace:read' }),
  endpoint('collection_run_proof', 'GET', '/workspaces/{workspaceId}/collection-runs/{collectionRunId}/proof', ['proof'], 'Export collection run proof', 'session', {
    scope: 'proofs:read',
    query: { detail: 'summary | compact | full' },
  }),

  endpoint('list_payment_orders', 'GET', '/workspaces/{workspaceId}/payment-orders', ['payment orders'], 'List payment orders', 'session', { scope: 'workspace:read' }),
  endpoint('create_payment_order', 'POST', '/workspaces/{workspaceId}/payment-orders', ['payment orders'], 'Create payment order', 'session', { scope: 'payments:write' }),
  endpoint('get_payment_order', 'GET', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}', ['payment orders'], 'Get payment order detail', 'session', { scope: 'workspace:read' }),
  endpoint('update_payment_order', 'PATCH', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}', ['payment orders'], 'Update payment order', 'session', { scope: 'payments:write' }),
  endpoint('submit_payment_order', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/submit', ['payment orders'], 'Submit payment order into approval/reconciliation workflow', 'session', { scope: 'payments:write' }),
  endpoint('cancel_payment_order', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/cancel', ['payment orders'], 'Cancel payment order', 'session', { scope: 'payments:write' }),
  endpoint('prepare_payment_order_execution', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/prepare-execution', ['payment orders'], 'Prepare signer-ready Solana transfer packet', 'session', { scope: 'execution:write' }),
  endpoint('create_payment_order_execution', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/create-execution', ['payment orders'], 'Record external execution handoff', 'session', { scope: 'execution:write' }),
  endpoint('attach_payment_order_signature', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/attach-signature', ['payment orders'], 'Attach submitted execution signature', 'session', { scope: 'execution:write' }),
  endpoint('payment_order_proof', 'GET', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/proof', ['proof'], 'Export payment order proof', 'session', {
    scope: 'proofs:read',
    query: { format: 'json | markdown' },
  }),
  endpoint('list_transfers', 'GET', '/workspaces/{workspaceId}/transfers', ['reconciliation'], 'List observed transfers for watched wallets', 'session', { scope: 'reconciliation:read' }),
  endpoint('list_reconciliation', 'GET', '/workspaces/{workspaceId}/reconciliation', ['reconciliation'], 'List reconciliation queue', 'session', { scope: 'reconciliation:read' }),
  endpoint('list_reconciliation_queue', 'GET', '/workspaces/{workspaceId}/reconciliation-queue', ['reconciliation'], 'List reconciliation queue', 'session', { scope: 'reconciliation:read' }),
  endpoint('get_reconciliation_detail', 'GET', '/workspaces/{workspaceId}/reconciliation-queue/{transferRequestId}', ['reconciliation'], 'Get reconciliation detail', 'session', { scope: 'reconciliation:read' }),
  endpoint('explain_reconciliation', 'GET', '/workspaces/{workspaceId}/reconciliation-queue/{transferRequestId}/explain', ['reconciliation'], 'Explain reconciliation decision', 'session', { scope: 'reconciliation:read' }),
  endpoint('refresh_reconciliation', 'POST', '/workspaces/{workspaceId}/reconciliation-queue/{transferRequestId}/refresh', ['reconciliation'], 'Preview reconciliation refresh', 'session', { scope: 'reconciliation:read' }),
  endpoint('list_exceptions', 'GET', '/workspaces/{workspaceId}/exceptions', ['exceptions'], 'List reconciliation exceptions', 'session', { scope: 'reconciliation:read' }),
  endpoint('update_exception', 'PATCH', '/workspaces/{workspaceId}/exceptions/{exceptionId}', ['exceptions'], 'Update exception metadata', 'session', { scope: 'exceptions:write' }),
  endpoint('get_exception', 'GET', '/workspaces/{workspaceId}/exceptions/{exceptionId}', ['exceptions'], 'Get exception detail', 'session', { scope: 'reconciliation:read' }),
  endpoint('exception_action', 'POST', '/workspaces/{workspaceId}/exceptions/{exceptionId}/actions', ['exceptions'], 'Apply exception action', 'session', { scope: 'exceptions:write' }),
  endpoint('exception_note', 'POST', '/workspaces/{workspaceId}/exceptions/{exceptionId}/notes', ['exceptions'], 'Add exception note', 'session', { scope: 'exceptions:write' }),

  endpoint('members', 'GET', '/workspaces/{workspaceId}/members', ['ops'], 'List workspace organization members', 'session', { scope: 'workspace:read' }),
  endpoint('audit_log', 'GET', '/workspaces/{workspaceId}/audit-log', ['ops'], 'Workspace audit log', 'session', { scope: 'proofs:read' }),
  endpoint('ops_health', 'GET', '/workspaces/{workspaceId}/ops-health', ['ops'], 'Workspace ops health metrics', 'session', { scope: 'reconciliation:read' }),

  endpoint('internal_workspaces', 'GET', '/internal/workspaces', ['internal'], 'Worker workspace snapshot', 'service_token'),
  endpoint('internal_matching_context', 'GET', '/internal/workspaces/{workspaceId}/matching-context', ['internal'], 'Worker matching context', 'service_token'),
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
