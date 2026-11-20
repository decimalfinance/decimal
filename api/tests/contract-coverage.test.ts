import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

// Every response a page reads should be on the contract (src/contract/): typed
// once, and proven in checks.ts to be what the API sends. This holds the
// frontend's calls to it.
//
// A call to the API in frontend/src/api.ts is covered when checks.ts has an
// entry for its route (the comment) whose contract type is the one the call
// reads (`request<BillDetail>`). Every other call is listed below. The list
// only shrinks: a new call must be covered, and a call that becomes covered, or
// goes, must come off the list. To cover one: move its response type into
// src/contract/, have api.ts import it from there, and add its route and a
// Fits line to checks.ts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Calls not yet on the contract, as METHOD and path, every parameter as :p.
const NOT_YET = [
  'DELETE /organizations/:p/accounting/quickbooks',
  'DELETE /organizations/:p/approvals/flow/draft',
  'DELETE /organizations/:p/approvals/out-of-office',
  'DELETE /organizations/:p/approvals/payment-flow/draft',
  'DELETE /organizations/:p/counterparty-wallets/:p',
  'DELETE /organizations/:p/integrations/xero',
  'DELETE /personal-wallets/:p',
  'GET /auth/session',
  'GET /capabilities',
  'GET /invites/:p',
  'GET /organizations/:p/accounting/quickbooks/accounts',
  'GET /organizations/:p/accounting/quickbooks/connect',
  'GET /organizations/:p/accounting/quickbooks/failed-syncs',
  'GET /organizations/:p/accounting/quickbooks/status',
  'GET /organizations/:p/accounting/quickbooks/synced',
  'GET /organizations/:p/approvals/flow',
  'GET /organizations/:p/approvals/out-of-office',
  'GET /organizations/:p/approvals/payment-flow',
  'GET /organizations/:p/approvals/separation',
  'GET /organizations/:p/automation-agents:p',
  'GET /organizations/:p/bills/:p/ask-candidates',
  'GET /organizations/:p/bills/:p/companion',
  'GET /organizations/:p/bills/approvals-inbox',
  'GET /organizations/:p/companion/chats/:p',
  'GET /organizations/:p/companion/console',
  'GET /organizations/:p/companion/jobs/:p',
  'GET /organizations/:p/counterparties',
  'GET /organizations/:p/counterparty-wallets',
  'GET /organizations/:p/inbound-email/address',
  'GET /organizations/:p/integrations/:p/books-closing-date',
  'GET /organizations/:p/integrations/:p/posting',
  'GET /organizations/:p/integrations/:p/setups/latest',
  'GET /organizations/:p/invites:p',
  'GET /organizations/:p/invoice-documents/:p/status',
  'GET /organizations/:p/knowledge',
  'GET /organizations/:p/members',
  'GET /organizations/:p/my-access',
  'GET /organizations/:p/payment-orders',
  'GET /organizations/:p/payment-orders/:p',
  'GET /organizations/:p/payment-orders/:p/proof',
  'GET /organizations/:p/personal-wallets',
  'GET /organizations/:p/policies',
  'GET /organizations/:p/policies/exceptions',
  'GET /organizations/:p/proposals/:p',
  'GET /organizations/:p/proposals:p',
  'GET /organizations/:p/protections',
  'GET /organizations/:p/roles',
  'GET /organizations/:p/spending-limit-executions:p',
  'GET /organizations/:p/spending-limit-policies/:p',
  'GET /organizations/:p/spending-limit-policies/:p/executions:p',
  'GET /organizations/:p/spending-limit-policies:p',
  'GET /organizations/:p/summary',
  'GET /organizations/:p/trading-names',
  'GET /organizations/:p/treasury-wallets',
  'GET /organizations/:p/treasury-wallets/:p/squads/detail',
  'GET /organizations/:p/treasury-wallets/:p/squads/status',
  'GET /organizations/:p/treasury-wallets/balances',
  'GET /organizations/:p:p',
  'GET /personal-wallets',
  'GET /personal-wallets/balances',
  'GET :p',
  'PATCH /auth/me',
  'PATCH /organizations/:p',
  'PATCH /organizations/:p/accounting/quickbooks/account-map',
  'PATCH /organizations/:p/counterparties/:p/payable-status',
  'PATCH /organizations/:p/counterparty-wallets/:p',
  'PATCH /organizations/:p/members/:p/access',
  'POST /auth/change-password',
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/register',
  'POST /auth/resend-verification',
  'POST /auth/verify-email',
  'POST /invites/:p/accept',
  'POST /organizations',
  'POST /organizations/:p/approvals/flow/assist',
  'POST /organizations/:p/approvals/flow/publish',
  'POST /organizations/:p/approvals/flow/test',
  'POST /organizations/:p/approvals/payment-flow/publish',
  'POST /organizations/:p/approvals/tasks/:p/command',
  'POST /organizations/:p/bills/:p/ask',
  'POST /organizations/:p/bills/:p/ceiling-exception',
  'POST /organizations/:p/bills/:p/confirm',
  'POST /organizations/:p/bills/:p/correct-figures',
  'POST /organizations/:p/bills/:p/duplicate-override',
  'POST /organizations/:p/bills/:p/in-books',
  'POST /organizations/:p/bills/:p/messages',
  'POST /organizations/:p/bills/:p/not-a-bill',
  'POST /organizations/:p/bills/:p/pay-itemised',
  'POST /organizations/:p/bills/:p/posting-date',
  'POST /organizations/:p/bills/:p/recall-request',
  'POST /organizations/:p/bills/:p/save',
  'POST /organizations/:p/bills/:p/send-back',
  'POST /organizations/:p/bills/:p/similar-vendor',
  'POST /organizations/:p/bills/:p/this-is-us',
  'POST /organizations/:p/companion/chats',
  'POST /organizations/:p/companion/chats/:p/actions/:p/outcome',
  'POST /organizations/:p/companion/chats/:p/messages',
  'POST /organizations/:p/counterparty-wallets',
  'POST /organizations/:p/inbox/replies/:p/done',
  'POST /organizations/:p/inbox/seen',
  'POST /organizations/:p/integrations/:p/setups',
  'POST /organizations/:p/integrations/setups/:p/messages',
  'POST /organizations/:p/invites',
  'POST /organizations/:p/invites/:p/revoke',
  'POST /organizations/:p/invoice-documents/:p/remove',
  'POST /organizations/:p/invoice-documents/:p/retry',
  'POST /organizations/:p/invoices/upload-async',
  'POST /organizations/:p/knowledge/lines/forget',
  'POST /organizations/:p/payment-orders/:p/accounting/sync',
  'POST /organizations/:p/payment-orders/:p/agent/advance',
  'POST /organizations/:p/payment-orders/:p/cancel',
  'POST /organizations/:p/payment-orders/:p/submit',
  'POST /organizations/:p/primary-admin/transfer',
  'POST /organizations/:p/proposals/:p/approve-intent',
  'POST /organizations/:p/proposals/:p/confirm-execution',
  'POST /organizations/:p/proposals/:p/confirm-submission',
  'POST /organizations/:p/proposals/:p/execute-intent',
  'POST /organizations/:p/proposals/:p/reconcile',
  'POST /organizations/:p/proposals/:p/reject-intent',
  'POST /organizations/:p/protections/:p/relax',
  'POST /organizations/:p/protections/:p/retighten',
  'POST /organizations/:p/recall-requests/:p/decision',
  'POST /organizations/:p/recall-requests/:p/withdraw',
  'POST /organizations/:p/roles/:p/holders',
  'POST /organizations/:p/spending-limit-policies/:p/remove-intent',
  'POST /organizations/:p/spending-limit-policies/:p/sync',
  'POST /organizations/:p/trading-names/remove',
  'POST /organizations/:p/trading-names/restore',
  'POST /organizations/:p/treasury-wallets',
  'POST /organizations/:p/treasury-wallets/:p/squads/config-proposals/add-member-intent',
  'POST /organizations/:p/treasury-wallets/:p/squads/config-proposals/add-spending-limit-intent',
  'POST /organizations/:p/treasury-wallets/:p/squads/config-proposals/change-threshold-intent',
  'POST /organizations/:p/treasury-wallets/:p/squads/sync-members',
  'POST /organizations/:p/treasury-wallets/:p/squads/vault-proposals/payment-intent',
  'POST /organizations/:p/treasury-wallets/:p/squads/vaults',
  'POST /organizations/:p/treasury-wallets/squads/confirm',
  'POST /organizations/:p/treasury-wallets/squads/create-intent',
  'POST /personal-wallets/:p/airdrop-sol',
  'POST /personal-wallets/:p/sign-versioned-transaction',
  'POST /personal-wallets/:p/transfer-out',
  'POST /personal-wallets/managed',
  'POST :p',
  'PUT /organizations/:p/approvals/flow/draft',
  'PUT /organizations/:p/approvals/out-of-office',
  'PUT /organizations/:p/approvals/payment-flow/draft',
  'PUT /organizations/:p/integrations/setups/:p/closing-date',
  'PUT /organizations/:p/policies/ceiling',
];

/** METHOD and path of one request() call, every parameter and the query string left out. */
function keyOf(call: ts.CallExpression, sf: ts.SourceFile): string {
  let arg = call.arguments[0]!;
  while (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) arg = arg.left;
  let route: string;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) route = arg.text;
  else if (ts.isTemplateExpression(arg)) route = arg.head.text + arg.templateSpans.map((s) => `:p${s.literal.text}`).join('');
  else route = ':p';
  route = route.replace(/\?.*$/, '').replace(/:\w+/g, ':p');
  let method = 'GET';
  const init = call.arguments[1];
  if (init && ts.isObjectLiteralExpression(init)) {
    for (const prop of init.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'method' && ts.isStringLiteral(prop.initializer)) method = prop.initializer.text;
    }
  }
  return `${method} ${route}`;
}

function frontendCalls() {
  const file = path.join(ROOT, 'frontend/src/api.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const calls: Array<{ key: string; reads: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'request') {
      const t = node.typeArguments?.[0];
      calls.push({
        key: keyOf(node, sf),
        reads: t && ts.isTypeReferenceNode(t) ? t.typeName.getText(sf) : t ? t.getText(sf) : '(nothing)',
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

/** checks.ts entries: route (as a key) to the contract type it proves. */
function proven() {
  const text = readFileSync(path.join(ROOT, 'api/src/contract/checks.ts'), 'utf8');
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\/\/ (GET|POST|PUT|PATCH|DELETE) (\S+)\n\s*Fits<Sends<typeof \w+>, (\w+)>/g)) {
    out.set(`${m[1]} ${m[2]!.replace(/:\w+/g, ':p')}`, m[3]!);
  }
  const fits = text.match(/^\s*Fits</gm)?.length ?? 0;
  return { out, fits };
}

/** Every route the API mounts, as METHOD and path with every parameter as :p. */
function mounted(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        for (const m of readFileSync(full, 'utf8').matchAll(/\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
          out.add(`${m[1]!.toUpperCase()} ${m[2]!.replace(/:\w+/g, ':p')}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'api/src'));
  return out;
}

test('every check in checks.ts names a route the API mounts', () => {
  const { out, fits } = proven();
  assert.equal(out.size, fits, 'each Fits<...> line in src/contract/checks.ts needs a "// METHOD /path" comment right above it');
  const routes = mounted();
  assert.deepEqual([...out.keys()].filter((k) => !routes.has(k)), [], 'checks.ts names a route no router in api/src mounts');
});

test("the frontend's calls are on the contract, or on the list that only shrinks", () => {
  const { out } = proven();
  const calls = frontendCalls();
  const listed = new Set(NOT_YET);
  const covered = (c: { key: string; reads: string }) => out.get(c.key) === c.reads;

  const uncovered = calls.filter((c) => !covered(c) && !listed.has(c.key));
  assert.deepEqual(
    uncovered.map((c) => `frontend/src/api.ts:${c.line} ${c.key} reads ${c.reads}`),
    [],
    'a new call to the API must read a type from src/contract/ that checks.ts proves (see the top of this file)',
  );

  const nowCovered = NOT_YET.filter((k) => calls.some((c) => c.key === k) && calls.filter((c) => c.key === k).every(covered));
  assert.deepEqual(nowCovered, [], 'these are on the contract now: take them off NOT_YET');

  const gone = NOT_YET.filter((k) => !calls.some((c) => c.key === k));
  assert.deepEqual(gone, [], 'frontend/src/api.ts no longer makes these calls: take them off NOT_YET');

  assert.equal(new Set(NOT_YET).size, NOT_YET.length, 'NOT_YET lists a call twice');
});
