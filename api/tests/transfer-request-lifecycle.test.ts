import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveRequestDisplayState,
  getAvailableUserTransitions,
  isRequestStatusTransitionAllowed,
  isUserRequestStatusTransitionAllowed,
} from '../src/transfer-request-lifecycle.js';

test('request lifecycle exposes the allowed transition graph', () => {
  assert.equal(isRequestStatusTransitionAllowed('draft', 'submitted'), true);
  assert.equal(isRequestStatusTransitionAllowed('submitted', 'approved'), false);
  assert.equal(isRequestStatusTransitionAllowed('observed', 'matched'), true);
  assert.equal(isRequestStatusTransitionAllowed('matched', 'closed'), true);
  assert.equal(isRequestStatusTransitionAllowed('closed', 'submitted'), false);
});

test('user transition graph is stricter than the full lifecycle graph', () => {
  assert.equal(isUserRequestStatusTransitionAllowed('draft', 'submitted'), true);
  assert.equal(isUserRequestStatusTransitionAllowed('submitted_onchain', 'observed'), false);
  assert.equal(isUserRequestStatusTransitionAllowed('exception', 'closed'), true);
  assert.deepEqual(getAvailableUserTransitions('approved'), ['ready_for_execution']);
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

  assert.equal(
    deriveRequestDisplayState({
      requestStatus: 'submitted',
      matchStatus: 'matched_exact',
      exceptionStatuses: [],
    }),
    'matched',
  );

  assert.equal(
    deriveRequestDisplayState({
      requestStatus: 'submitted',
      matchStatus: 'matched_partial',
      exceptionStatuses: [],
    }),
    'partial',
  );

  assert.equal(
    deriveRequestDisplayState({
      requestStatus: 'submitted',
      matchStatus: 'matched_partial',
      exceptionStatuses: ['open'],
    }),
    'exception',
  );
});
