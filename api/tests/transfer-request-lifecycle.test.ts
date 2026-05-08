import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveExecutionState,
  deriveRequestDisplayState,
  getAvailableUserTransitions,
  isRequestStatusTransitionAllowed,
  isUserRequestStatusTransitionAllowed,
} from '../src/transfer-requests/lifecycle.js';

test('request lifecycle exposes the allowed transition graph', () => {
  assert.equal(isRequestStatusTransitionAllowed('draft', 'submitted'), true);
  assert.equal(isRequestStatusTransitionAllowed('submitted', 'approved'), true);
  assert.equal(isRequestStatusTransitionAllowed('approved', 'ready_for_execution'), true);
  assert.equal(isRequestStatusTransitionAllowed('ready_for_execution', 'submitted_onchain'), true);
  assert.equal(isRequestStatusTransitionAllowed('submitted_onchain', 'matched'), true);
  assert.equal(isRequestStatusTransitionAllowed('submitted_onchain', 'exception'), true);
  assert.equal(isRequestStatusTransitionAllowed('matched', 'closed'), true);
  assert.equal(isRequestStatusTransitionAllowed('exception', 'matched'), true);
  assert.equal(isRequestStatusTransitionAllowed('closed', 'submitted'), false);
});

test('user transition graph is stricter than the full lifecycle graph', () => {
  assert.equal(isUserRequestStatusTransitionAllowed('draft', 'submitted'), true);
  assert.equal(isUserRequestStatusTransitionAllowed('submitted_onchain', 'matched'), false);
  assert.equal(isUserRequestStatusTransitionAllowed('exception', 'closed'), true);
  assert.deepEqual(getAvailableUserTransitions('approved'), []);
});

test('request display state derives from request status, match status, and open exceptions', () => {
  assert.equal(
    deriveRequestDisplayState({
      requestStatus: 'submitted',
      matchStatus: null,
      exceptionStatuses: [],
    }),
    'pending',
  );

  // RPC settlement verification produces matchStatus: 'rpc_verified' when
  // expected USDC deltas match — surfaces as the 'matched' display state.
  assert.equal(
    deriveRequestDisplayState({
      requestStatus: 'submitted_onchain',
      matchStatus: 'rpc_verified',
      exceptionStatuses: [],
    }),
    'matched',
  );

  // Once the marker has flipped the request to 'matched', display state
  // stays 'matched' regardless of the (now-null) matchStatus passed in.
  assert.equal(
    deriveRequestDisplayState({
      requestStatus: 'matched',
      matchStatus: null,
      exceptionStatuses: [],
    }),
    'matched',
  );

  assert.equal(
    deriveRequestDisplayState({
      requestStatus: 'submitted_onchain',
      matchStatus: 'rpc_verified',
      exceptionStatuses: ['open'],
    }),
    'exception',
  );
});

test('execution state derives separately from approval and match facts', () => {
  assert.equal(
    deriveExecutionState({
      requestStatus: 'approved',
      executionState: null,
      submittedSignature: null,
      hasObservedTransaction: false,
      matchStatus: null,
      exceptionStatuses: [],
    }),
    'ready_for_execution',
  );

  assert.equal(
    deriveExecutionState({
      requestStatus: 'submitted_onchain',
      executionState: 'submitted_onchain',
      submittedSignature: 'sig',
      hasObservedTransaction: false,
      matchStatus: null,
      exceptionStatuses: [],
    }),
    'submitted_onchain',
  );

  // When the markers have advanced the request to 'matched' (RPC settlement
  // verified) the derivation surfaces 'settled'.
  assert.equal(
    deriveExecutionState({
      requestStatus: 'matched',
      executionState: 'settled',
      submittedSignature: 'sig',
      hasObservedTransaction: false,
      matchStatus: 'rpc_verified',
      exceptionStatuses: [],
    }),
    'settled',
  );

  assert.equal(
    deriveExecutionState({
      requestStatus: 'submitted_onchain',
      executionState: 'submitted_onchain',
      submittedSignature: 'sig',
      hasObservedTransaction: true,
      matchStatus: null,
      exceptionStatuses: ['open'],
    }),
    'execution_exception',
  );
});
