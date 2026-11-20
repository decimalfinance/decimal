// The API's side of the contract: what each endpoint's service function returns,
// once sent as JSON, must fit the type the pages read. `npm run typecheck` (in
// `make test`) compiles this file, so a field a page relies on can't go missing
// or change type here without failing the build.
//
// One entry per endpoint: the route as a comment, then the check. The
// frontend's calls are matched to these by that comment
// (tests/contract-coverage.test.ts), so keep the format. The route sends the
// function's result as it is; if a route ever reshapes it, check the reshaped
// value instead.
import type { getInbox } from '../companion/inbox.js';
import type { getBillDetail, getBillsWorkbench } from '../payments/bills.js';
import type { BillDetail, BillsWorkbench } from './bills.js';
import type { Inbox } from './inbox.js';
import type { Fits, Sends } from './wire.js';

export type Checks = [
  // GET /organizations/:organizationId/bills/:paymentOrderId/detail
  Fits<Sends<typeof getBillDetail>, BillDetail>,
  // GET /organizations/:organizationId/bills/workbench
  Fits<Sends<typeof getBillsWorkbench>, BillsWorkbench>,
  // GET /organizations/:organizationId/inbox
  Fits<Sends<typeof getInbox>, Inbox>,
];
