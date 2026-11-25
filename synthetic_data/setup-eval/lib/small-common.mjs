// Pieces the small companies share: vendors from a table, and an answer key whose
// lists are all empty (these companies have nothing planted in them).

import { makeContact, createdOn } from './contacts.mjs';
import { computeCantPost, computeFacts } from './facts.mjs';

/** rows: [key, name, city, options]. Options as in contacts.mjs, plus created (months ago), terms, active, company, acct. */
export function addVendors(b, today, rows) {
  const used = new Set();
  for (const [key, name, city, o = {}] of rows) {
    const c = makeContact(b.rng, used, city, o);
    b.vendor(key, {
      name,
      company: o.company,
      email: c.email,
      phone: c.phone,
      address: c.address,
      accountNumber: o.acct ?? null,
      currency: o.currency,
      terms: o.terms,
      active: o.active,
      created: createdOn(b.rng, today, o.created ?? 24),
    });
  }
}

/** An answer key with nothing planted: the right answer to every question is "nothing wrong". */
export function plainAnswers({ id, fixture, since, canWork, blockingReason = null, person }) {
  return {
    companyId: id,
    canWork,
    blockingReason,
    person,
    sameVendors: [],
    differentVendors: [],
    codedTwoWays: [],
    codingChanged: [],
    slips: [],
    cantPost: computeCantPost(fixture, since),
    injections: [],
    duplicateBills: [],
    facts: computeFacts(fixture, since),
  };
}
