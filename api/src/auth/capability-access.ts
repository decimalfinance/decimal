// Role-based access enforcement (roles-research/SYNTHESIS-decimal-roles.md).
// One middleware, one ordered table: org-scoped requests are matched to the
// capability their area requires (first match wins; GET/HEAD need the view
// capability, everything else the act capability). Primary admin/admin bypass. A member
// with no roles holds the viewer bundle — sees everything, changes nothing.
// This is feature-surface enforcement, same mechanism as QBO: a role without
// payments.view simply has no payment surface.
import type { NextFunction, Request, Response } from 'express';
import { forbidden } from '../infra/api-errors.js';
import { getOrgAccess, type Capability } from '../approvals/permissions.js';

// Ordered: first regex to match the org-scoped subpath wins. `view` gates
// GET/HEAD; `act` gates mutations (an array = any one suffices). null = any
// active member.
type Need = Capability | Capability[] | null;
const RULES: Array<{ pattern: RegExp; view: Need; act: Need }> = [
  // Pipeline configuration (simulates are POST but read-only dry runs).
  { pattern: /^\/approvals\/(flow\/simulate|pipeline\/simulate)$/, view: 'governance.view', act: 'governance.view' },
  { pattern: /^\/approvals\/(flow|review|release|payment-flow|separation|policy)(\/|$)/, view: 'governance.view', act: 'governance.edit' },
  // Release signing sits under approvals but moves money.
  { pattern: /^\/approvals\/[0-9a-f-]{36}\/release$/, view: 'payments.sign', act: 'payments.sign' },
  // Out-of-office is self-service for anyone with approval duties.
  { pattern: /^\/approvals\/out-of-office$/, view: null, act: null },
  // Approval inbox is viewable with bill access; acting on a task is enforced
  // by the ENGINE (only the task's targeted approvers may act — stronger and
  // more precise than any route-level role check, and a person the owner put
  // in the flow must be able to act even before roles catch up).
  { pattern: /^\/approvals\/tasks(\/|$)/, view: 'bills.view', act: null },
  { pattern: /^\/approvals(\/|$)/, view: 'bills.view', act: 'bills.edit' },
  // GL coding is bill clerk work even though it lives under payment-orders.
  { pattern: /^\/payment-orders\/[^/]+\/(gl-coding|accounting)(\/|$)/, view: 'bills.view', act: 'bills.edit' },
  // Asking a colleague about a bill needs bill VISIBILITY and nothing more.
  // Asking is never the dangerous act — it changes no figure and commits no
  // money, it only parks the bill and routes a question. Requiring bills.edit
  // would mean the people most likely to spot something wrong, and least likely
  // to hold edit rights, are the ones who cannot raise it. The reply itself is
  // still governed by the engine.
  { pattern: /^\/bills\/[0-9a-f-]{36}\/(ask|ask-candidates|ask\/suggest-fields)$/, view: 'bills.view', act: null },
  // Answering is the other half of asking. If someone can be asked, they can
  // reply — the function itself refuses anyone who was not the person asked.
  { pattern: /^\/bills\/[0-9a-f-]{36}\/questions\/[0-9a-f-]{36}\/answer$/, view: 'bills.view', act: null },
  // Bringing a bill IN is wider than working on one. Anybody who is not a
  // Viewer may upload — it creates a draft, which does nothing until a clerk
  // works it. Must sit above the general bills rule; first match wins.
  { pattern: /^\/invoices\/upload(-async)?$/, view: 'bills.view', act: 'bills.create' },
  // Bills work surface.
  { pattern: /^\/(bills|invoices|invoice-documents)(\/|$)/, view: 'bills.view', act: 'bills.edit' },
  // The org's inbound invoice address is part of the bills surface: anyone who
  // can see bills can see where to forward them. The ignored-mail log inside
  // this prefix re-checks admin in its own route.
  { pattern: /^\/inbound-email(\/|$)/, view: 'bills.view', act: 'bills.edit' },
  // Creating/editing payment orders is entering payables (bill clerk work);
  // cancel/execute/advance actually move or stop money.
  { pattern: /^\/payment-orders\/[^/]+\/(cancel|execute-with-spending-limit|agent\/advance)$/, view: 'payments.sign', act: 'payments.sign' },
  { pattern: /^\/payment-orders(\/|$)/, view: 'payments.view', act: 'bills.edit' },
  // Multisig signing intents/confirmations are gated by KEY CUSTODY (wallet
  // authorizations + the chain itself) — a signer may sign regardless of role.
  { pattern: /^\/(proposals|treasury-wallets)\/.*(approve-intent|confirm-submission|confirm-execution)$/, view: 'payments.view', act: null },
  // Multisig proposals = payment authorization surface.
  { pattern: /^\/proposals(\/|$)/, view: 'payments.view', act: 'payments.sign' },
  // Treasury surface.
  { pattern: /^\/(treasury-wallets|spending-limit-policies|spending-limit-executions|agent-wallets|automation-agents)(\/|$)/, view: 'treasury.view', act: 'treasury.manage' },
  // Vendors (incl. payment rails).
  { pattern: /^\/(counterparties|counterparty-wallets|destinations|vendors)(\/|$)/, view: 'vendors.view', act: 'vendors.manage' },
  { pattern: /^\/accounting(\/|$)/, view: 'accounting.view', act: 'accounting.manage' },
  // Team administration (role assignment endpoints also re-check admin inside).
  { pattern: /^\/(members|invites|roles)(\/|$)/, view: 'members.view', act: 'members.manage' },
  // my-access, summary, audit-log, protections, join, personal-wallets, ops-health…
  // stay member-open (their routes carry their own owner/admin gates where needed).
];

const ORG_PATH = /^\/organizations\/([0-9a-f-]{36})(\/.*)?$/i;

export function capabilityAccessMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const match = ORG_PATH.exec(req.path);
      if (!match || !req.auth) return next();
      const organizationId = match[1]!;
      const subpath = match[2] ?? '/';
      const rule = RULES.find((r) => r.pattern.test(subpath));
      if (!rule) return next();
      const isRead = req.method === 'GET' || req.method === 'HEAD';
      const needed = isRead ? rule.view : rule.act;
      if (!needed) return next();
      const options = Array.isArray(needed) ? needed : [needed];
      const access = await getOrgAccess(organizationId, req.auth.userId);
      // Not a member at all → let the route's own assertOrganizationAccess 404/403
      // with its established message.
      if (!access) return next();
      if (access.isPrimaryOrAdmin || options.some((c) => access.capabilities.includes(c))) return next();
      throw forbidden("Your role doesn't include this. Ask an admin on the Members page if you need it.", { needed: options });
    } catch (error) {
      next(error);
    }
  };
}
