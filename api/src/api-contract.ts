export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type ApiEndpoint = {
  id: string;
  method: HttpMethod;
  path: string;
  tags: string[];
  summary: string;
  auth: 'public' | 'session_or_api_key' | 'service_token';
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
  endpoint('session', 'GET', '/auth/session', ['auth'], 'Inspect current user session or API-key actor', 'session_or_api_key'),
  endpoint('logout', 'POST', '/auth/logout', ['auth'], 'Invalidate current user session', 'session_or_api_key'),

  endpoint('list_organizations', 'GET', '/organizations', ['organizations'], 'List organizations for the current user', 'session_or_api_key'),
  endpoint('create_organization', 'POST', '/organizations', ['organizations'], 'Create organization', 'session_or_api_key', {
    scope: 'workspace:write',
    requestBody: { organizationName: 'string' },
  }),
  endpoint('join_organization', 'POST', '/organizations/{organizationId}/join', ['organizations'], 'Join organization', 'session_or_api_key'),
  endpoint('list_workspaces', 'GET', '/organizations/{organizationId}/workspaces', ['organizations'], 'List organization workspaces', 'session_or_api_key'),
  endpoint('create_workspace', 'POST', '/organizations/{organizationId}/workspaces', ['organizations'], 'Create workspace', 'session_or_api_key', {
    requestBody: { workspaceName: 'string' },
  }),
  endpoint('create_demo_workspace', 'POST', '/organizations/{organizationId}/demo-workspace', ['organizations'], 'Create demo workspace', 'session_or_api_key'),

  endpoint('list_api_keys', 'GET', '/workspaces/{workspaceId}/api-keys', ['api keys'], 'List workspace API keys', 'session_or_api_key', { scope: 'api_keys:write' }),
  endpoint('create_api_key', 'POST', '/workspaces/{workspaceId}/api-keys', ['api keys'], 'Create scoped workspace API key', 'session_or_api_key', {
    scope: 'api_keys:write',
    requestBody: { label: 'string', scopes: 'string[]', role: 'string optional', expiresAt: 'ISO datetime optional' },
  }),
  endpoint('revoke_api_key', 'POST', '/workspaces/{workspaceId}/api-keys/{apiKeyId}/revoke', ['api keys'], 'Revoke API key', 'session_or_api_key', { scope: 'api_keys:write' }),
  endpoint('delete_api_key', 'DELETE', '/workspaces/{workspaceId}/api-keys/{apiKeyId}', ['api keys'], 'Delete API key', 'session_or_api_key', { scope: 'api_keys:write' }),

  endpoint('list_addresses', 'GET', '/workspaces/{workspaceId}/addresses', ['address book'], 'List workspace wallets', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('create_address', 'POST', '/workspaces/{workspaceId}/addresses', ['address book'], 'Create workspace wallet', 'session_or_api_key', {
    scope: 'workspace:write',
    requestBody: { chain: 'solana', address: 'string', displayName: 'string optional' },
  }),
  endpoint('update_address', 'PATCH', '/workspaces/{workspaceId}/addresses/{workspaceAddressId}', ['address book'], 'Update workspace wallet', 'session_or_api_key', { scope: 'workspace:write' }),

  endpoint('list_counterparties', 'GET', '/workspaces/{workspaceId}/counterparties', ['address book'], 'List counterparties', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('create_counterparty', 'POST', '/workspaces/{workspaceId}/counterparties', ['address book'], 'Create counterparty', 'session_or_api_key', { scope: 'workspace:write' }),
  endpoint('update_counterparty', 'PATCH', '/workspaces/{workspaceId}/counterparties/{counterpartyId}', ['address book'], 'Update counterparty', 'session_or_api_key', { scope: 'workspace:write' }),
  endpoint('list_destinations', 'GET', '/workspaces/{workspaceId}/destinations', ['address book'], 'List payment destinations', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('create_destination', 'POST', '/workspaces/{workspaceId}/destinations', ['address book'], 'Create payment destination', 'session_or_api_key', { scope: 'workspace:write' }),
  endpoint('update_destination', 'PATCH', '/workspaces/{workspaceId}/destinations/{destinationId}', ['address book'], 'Update payment destination', 'session_or_api_key', { scope: 'workspace:write' }),
  endpoint('list_payees', 'GET', '/workspaces/{workspaceId}/payees', ['payees'], 'List payees', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('create_payee', 'POST', '/workspaces/{workspaceId}/payees', ['payees'], 'Create payee', 'session_or_api_key', { scope: 'workspace:write' }),
  endpoint('get_payee', 'GET', '/workspaces/{workspaceId}/payees/{payeeId}', ['payees'], 'Get payee detail', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('update_payee', 'PATCH', '/workspaces/{workspaceId}/payees/{payeeId}', ['payees'], 'Update payee', 'session_or_api_key', { scope: 'workspace:write' }),

  endpoint('get_approval_policy', 'GET', '/workspaces/{workspaceId}/approval-policy', ['approval'], 'Get workspace approval policy', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('update_approval_policy', 'PATCH', '/workspaces/{workspaceId}/approval-policy', ['approval'], 'Update workspace approval policy', 'session_or_api_key', { scope: 'approvals:write' }),
  endpoint('approval_inbox', 'GET', '/workspaces/{workspaceId}/approval-inbox', ['approval'], 'List pending approvals', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('approval_decision', 'POST', '/workspaces/{workspaceId}/transfer-requests/{transferRequestId}/approval-decisions', ['approval'], 'Approve or reject transfer request', 'session_or_api_key', {
    scope: 'approvals:write',
    requestBody: { action: 'approve | reject', comment: 'string optional' },
  }),

  endpoint('list_payment_requests', 'GET', '/workspaces/{workspaceId}/payment-requests', ['inputs'], 'List payment requests', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('create_payment_request', 'POST', '/workspaces/{workspaceId}/payment-requests', ['inputs'], 'Create payment request', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('import_payment_requests_csv', 'POST', '/workspaces/{workspaceId}/payment-requests/import-csv', ['inputs'], 'Import payment requests from CSV', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('preview_payment_requests_csv', 'POST', '/workspaces/{workspaceId}/payment-requests/import-csv/preview', ['inputs'], 'Preview payment request CSV import without side effects', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('get_payment_request', 'GET', '/workspaces/{workspaceId}/payment-requests/{paymentRequestId}', ['inputs'], 'Get payment request detail', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('promote_payment_request', 'POST', '/workspaces/{workspaceId}/payment-requests/{paymentRequestId}/promote', ['inputs'], 'Promote payment request to payment order', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('cancel_payment_request', 'POST', '/workspaces/{workspaceId}/payment-requests/{paymentRequestId}/cancel', ['inputs'], 'Cancel payment request', 'session_or_api_key', { scope: 'payments:write' }),

  endpoint('list_payment_runs', 'GET', '/workspaces/{workspaceId}/payment-runs', ['payment runs'], 'List payment runs', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('import_payment_run_csv', 'POST', '/workspaces/{workspaceId}/payment-runs/import-csv', ['payment runs'], 'Import CSV as payment run', 'session_or_api_key', {
    scope: 'payments:write',
    requestBody: { csv: 'string', runName: 'string optional', importKey: 'string optional' },
  }),
  endpoint('preview_payment_run_csv', 'POST', '/workspaces/{workspaceId}/payment-runs/import-csv/preview', ['payment runs'], 'Preview payment run CSV import without side effects', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('get_payment_run', 'GET', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}', ['payment runs'], 'Get payment run detail', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('delete_payment_run', 'DELETE', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}', ['payment runs'], 'Delete payment run', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('cancel_payment_run', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/cancel', ['payment runs'], 'Cancel payment run before execution evidence exists', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('close_payment_run', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/close', ['payment runs'], 'Close fully settled payment run', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('prepare_payment_run_execution', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/prepare-execution', ['payment runs'], 'Prepare batch execution packet', 'session_or_api_key', { scope: 'execution:write' }),
  endpoint('attach_payment_run_signature', 'POST', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/attach-signature', ['payment runs'], 'Attach submitted batch signature', 'session_or_api_key', { scope: 'execution:write' }),
  endpoint('payment_run_proof', 'GET', '/workspaces/{workspaceId}/payment-runs/{paymentRunId}/proof', ['proof'], 'Export payment run proof', 'session_or_api_key', {
    scope: 'proofs:read',
    query: { detail: 'summary | compact | full', format: 'json | markdown' },
  }),

  endpoint('list_payment_orders', 'GET', '/workspaces/{workspaceId}/payment-orders', ['payment orders'], 'List payment orders', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('create_payment_order', 'POST', '/workspaces/{workspaceId}/payment-orders', ['payment orders'], 'Create payment order', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('get_payment_order', 'GET', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}', ['payment orders'], 'Get payment order detail', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('update_payment_order', 'PATCH', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}', ['payment orders'], 'Update payment order', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('submit_payment_order', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/submit', ['payment orders'], 'Submit payment order into approval/reconciliation workflow', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('cancel_payment_order', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/cancel', ['payment orders'], 'Cancel payment order', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('prepare_payment_order_execution', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/prepare-execution', ['payment orders'], 'Prepare signer-ready Solana transfer packet', 'session_or_api_key', { scope: 'execution:write' }),
  endpoint('create_payment_order_execution', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/create-execution', ['payment orders'], 'Record external execution handoff', 'session_or_api_key', { scope: 'execution:write' }),
  endpoint('attach_payment_order_signature', 'POST', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/attach-signature', ['payment orders'], 'Attach submitted execution signature', 'session_or_api_key', { scope: 'execution:write' }),
  endpoint('payment_order_proof', 'GET', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/proof', ['proof'], 'Export payment order proof', 'session_or_api_key', {
    scope: 'proofs:read',
    query: { format: 'json | markdown' },
  }),
  endpoint('payment_order_audit_export', 'GET', '/workspaces/{workspaceId}/payment-orders/{paymentOrderId}/audit-export', ['proof'], 'Export payment order audit rows', 'session_or_api_key', { scope: 'proofs:read' }),

  endpoint('list_transfer_requests', 'GET', '/workspaces/{workspaceId}/transfer-requests', ['legacy transfer requests'], 'List transfer requests', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('get_transfer_request', 'GET', '/workspaces/{workspaceId}/transfer-requests/{transferRequestId}', ['legacy transfer requests'], 'Get transfer request detail', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('create_transfer_request', 'POST', '/workspaces/{workspaceId}/transfer-requests', ['legacy transfer requests'], 'Create transfer request', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('add_transfer_request_note', 'POST', '/workspaces/{workspaceId}/transfer-requests/{transferRequestId}/notes', ['legacy transfer requests'], 'Add transfer request note', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('transition_transfer_request', 'POST', '/workspaces/{workspaceId}/transfer-requests/{transferRequestId}/transitions', ['legacy transfer requests'], 'Transition transfer request status', 'session_or_api_key', { scope: 'payments:write' }),
  endpoint('record_transfer_execution', 'POST', '/workspaces/{workspaceId}/transfer-requests/{transferRequestId}/executions', ['legacy transfer requests'], 'Record execution on transfer request', 'session_or_api_key', { scope: 'execution:write' }),
  endpoint('update_transfer_request', 'PATCH', '/workspaces/{workspaceId}/transfer-requests/{transferRequestId}', ['legacy transfer requests'], 'Update transfer request metadata', 'session_or_api_key', { scope: 'payments:write' }),

  endpoint('list_transfers', 'GET', '/workspaces/{workspaceId}/transfers', ['reconciliation'], 'List observed transfers for watched wallets', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('list_reconciliation', 'GET', '/workspaces/{workspaceId}/reconciliation', ['reconciliation'], 'List reconciliation queue', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('list_reconciliation_queue', 'GET', '/workspaces/{workspaceId}/reconciliation-queue', ['reconciliation'], 'List reconciliation queue', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('get_reconciliation_detail', 'GET', '/workspaces/{workspaceId}/reconciliation-queue/{transferRequestId}', ['reconciliation'], 'Get reconciliation detail', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('explain_reconciliation', 'GET', '/workspaces/{workspaceId}/reconciliation-queue/{transferRequestId}/explain', ['reconciliation'], 'Explain reconciliation decision', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('refresh_reconciliation', 'POST', '/workspaces/{workspaceId}/reconciliation-queue/{transferRequestId}/refresh', ['reconciliation'], 'Preview reconciliation refresh', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('list_exceptions', 'GET', '/workspaces/{workspaceId}/exceptions', ['exceptions'], 'List reconciliation exceptions', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('update_exception', 'PATCH', '/workspaces/{workspaceId}/exceptions/{exceptionId}', ['exceptions'], 'Update exception metadata', 'session_or_api_key', { scope: 'exceptions:write' }),
  endpoint('get_exception', 'GET', '/workspaces/{workspaceId}/exceptions/{exceptionId}', ['exceptions'], 'Get exception detail', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('exception_action', 'POST', '/workspaces/{workspaceId}/exceptions/{exceptionId}/actions', ['exceptions'], 'Apply exception action', 'session_or_api_key', { scope: 'exceptions:write' }),
  endpoint('exception_note', 'POST', '/workspaces/{workspaceId}/exceptions/{exceptionId}/notes', ['exceptions'], 'Add exception note', 'session_or_api_key', { scope: 'exceptions:write' }),

  endpoint('agent_tasks', 'GET', '/workspaces/{workspaceId}/agent/tasks', ['agents'], 'List agent-actionable tasks', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('agent_tasks_events', 'GET', '/workspaces/{workspaceId}/agent/tasks/events', ['agents'], 'Stream agent task updates via SSE', 'session_or_api_key', { scope: 'reconciliation:read' }),
  endpoint('members', 'GET', '/workspaces/{workspaceId}/members', ['ops'], 'List workspace organization members', 'session_or_api_key', { scope: 'workspace:read' }),
  endpoint('export_jobs', 'GET', '/workspaces/{workspaceId}/export-jobs', ['ops'], 'List export jobs', 'session_or_api_key', { scope: 'proofs:read' }),
  endpoint('audit_log', 'GET', '/workspaces/{workspaceId}/audit-log', ['ops'], 'Workspace audit log', 'session_or_api_key', { scope: 'proofs:read' }),
  endpoint('export_reconciliation', 'GET', '/workspaces/{workspaceId}/exports/reconciliation', ['ops'], 'Export reconciliation rows', 'session_or_api_key', { scope: 'proofs:read' }),
  endpoint('export_exceptions', 'GET', '/workspaces/{workspaceId}/exports/exceptions', ['ops'], 'Export exception rows', 'session_or_api_key', { scope: 'proofs:read' }),
  endpoint('export_audit', 'GET', '/workspaces/{workspaceId}/exports/audit/{transferRequestId}', ['ops'], 'Export audit packet for transfer request', 'session_or_api_key', { scope: 'proofs:read' }),
  endpoint('ops_health', 'GET', '/workspaces/{workspaceId}/ops-health', ['ops'], 'Workspace ops health metrics', 'session_or_api_key', { scope: 'reconciliation:read' }),

  endpoint('list_address_labels', 'GET', '/address-labels', ['labels'], 'List address labels', 'session_or_api_key'),
  endpoint('create_address_label', 'POST', '/address-labels', ['labels'], 'Create address label', 'session_or_api_key'),
  endpoint('update_address_label', 'PATCH', '/address-labels/{addressLabelId}', ['labels'], 'Update address label', 'session_or_api_key'),

  endpoint('internal_workspaces', 'GET', '/internal/workspaces', ['internal'], 'Worker workspace snapshot', 'service_token'),
  endpoint('internal_matching_context', 'GET', '/internal/workspaces/{workspaceId}/matching-context', ['internal'], 'Worker matching context', 'service_token'),
  endpoint('internal_matching_index', 'GET', '/internal/matching-index', ['internal'], 'Worker matching index snapshot', 'service_token'),
  endpoint('internal_matching_index_events', 'GET', '/internal/matching-index/events', ['internal'], 'Worker matching index SSE', 'service_token'),
  endpoint('internal_ops_metrics', 'GET', '/internal/ops-metrics', ['internal'], 'Route and worker stage metrics', 'service_token'),
  endpoint('internal_worker_stage_events', 'POST', '/internal/worker-stage-events', ['internal'], 'Worker stage metric ingest', 'service_token'),
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
