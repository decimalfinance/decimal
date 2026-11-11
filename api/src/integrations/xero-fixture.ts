// A Xero organisation in memory, answering the Accounting API's GETs as Xero's
// specification describes them: each list under its plural name, pages of up to
// 1000 with a pagination count, filters by where, Statuses, InvoiceNumbers and
// ContactIDs. The bench's pretend Xero and the eval read through it, so the Xero
// reader runs for real with no Xero app. It answers what that reader asks, no more.
//
// It can fail the way Xero does, with Xero's statuses, so the reader's handling
// of a 401, a 429 or an outage is what gets tested, not a shortcut around it.

import { XeroApiError, type XeroClient } from './xero-reader.js';

type Row = Record<string, unknown>;

export type XeroFixture = {
  Organisation: Row;
  Currencies: Row[];
  TrackingCategories: Row[];
  Accounts: Row[];
  Contacts: Row[];
  Invoices: Row[];
  BankTransactions: Row[];
  LinkedTransactions: Row[];
};

export type XeroFixtureFault = {
  /** The endpoint that fails: Organisation, Accounts, Contacts, Invoices, BankTransactions… */
  on: string;
  /** The status Xero answers with. */
  status?: number;
  /** Or: the answer is short this many rows, while its pagination still counts them. */
  short?: number;
};

const PAGE_DEFAULT = 100;
const PAGE_MAX = 1000;
const LINKED_PAGE = 100;

export type FixtureXeroClient = XeroClient & { asked: Array<{ endpoint: string; query: Record<string, string> }> };

export function fixtureXeroClient(fixture: XeroFixture, faults: XeroFixtureFault[] = []): FixtureXeroClient {
  const asked: FixtureXeroClient['asked'] = [];

  const paged = (endpoint: string, rows: Row[], query: Record<string, string>, size = Number(query.pageSize ?? PAGE_DEFAULT)) => {
    const pageSize = Math.min(Math.max(1, size || PAGE_DEFAULT), PAGE_MAX);
    const short = faults.find((f) => f.on === endpoint)?.short ?? 0;
    // Short: the last rows never come back, though Xero still counts them.
    const served = short > 0 ? rows.slice(0, Math.max(0, rows.length - short)) : rows;
    if (!query.page) return { [endpoint]: served };
    const page = Math.max(1, Number(query.page));
    return {
      [endpoint]: served.slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, pageCount: Math.ceil(rows.length / pageSize), itemCount: rows.length },
    };
  };

  const listParam = (value: string | undefined) => (value ? value.split(',').map((v) => v.trim()).filter(Boolean) : null);

  return {
    tenantId: String(fixture.Organisation.OrganisationID ?? 'fixture'),
    asked,
    get: async (endpoint, query = {}) => {
      asked.push({ endpoint, query });
      const fault = faults.find((f) => f.on === endpoint && f.status);
      if (fault?.status) {
        throw new XeroApiError(fault.status, `Xero answered ${fault.status} to ${endpoint}.`, fault.status === 429 ? 60 : null);
      }
      const where = query.where ? whereFilter(query.where) : () => true;
      switch (endpoint) {
        case 'Organisation':
          return { Organisations: [fixture.Organisation] };
        case 'Currencies':
          return { Currencies: fixture.Currencies };
        case 'TrackingCategories':
          return { TrackingCategories: fixture.TrackingCategories.filter((t) => query.includeArchived === 'true' || t.Status === 'ACTIVE') };
        case 'Accounts':
          return paged('Accounts', fixture.Accounts.filter(where), {});
        case 'Contacts': {
          // searchTerm: Xero's own, case-insensitive, anywhere in these fields.
          const term = query.searchTerm?.toLowerCase();
          const found = (c: Row) => !term || ['Name', 'FirstName', 'LastName', 'ContactNumber', 'EmailAddress']
            .some((field) => typeof c[field] === 'string' && (c[field] as string).toLowerCase().includes(term));
          return paged('Contacts', fixture.Contacts.filter((c) => (query.includeArchived === 'true' || c.ContactStatus === 'ACTIVE') && where(c) && found(c)), query);
        }
        case 'Invoices': {
          const statuses = listParam(query.Statuses);
          const numbers = listParam(query.InvoiceNumbers);
          const contacts = listParam(query.ContactIDs);
          return paged('Invoices', fixture.Invoices.filter((i) => where(i)
            && (!statuses || statuses.includes(String(i.Status)))
            && (!numbers || numbers.includes(String(i.InvoiceNumber)))
            && (!contacts || contacts.includes(String((i.Contact as Row | undefined)?.ContactID)))), query);
        }
        case 'BankTransactions':
          return paged('BankTransactions', fixture.BankTransactions.filter(where), query);
        case 'LinkedTransactions':
          return paged('LinkedTransactions', fixture.LinkedTransactions.filter(where), { page: query.page ?? '1' }, LINKED_PAGE);
        default:
          throw new XeroApiError(404, `The fixture has no ${endpoint}.`);
      }
    },
  };
}

// ─── where ────────────────────────────────────────────────────────────────────
// The part of Xero's filter language the reader writes: comparisons of a field with
// a "string" or a DateTime(y,m,d), joined by && / AND and || / OR, in brackets.

type Test = (row: Row) => boolean;

function whereFilter(text: string): Test {
  const tokens = text.match(/\(|\)|&&|\|\||\bAND\b|\bOR\b|[A-Za-z.]+\s*(?:==|!=|>=|<=|>|<)\s*(?:"[^"]*"|DateTime\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|true|false)/g) ?? [];
  let at = 0;
  const either = (): Test => {
    let test = both();
    while (tokens[at] === '||' || tokens[at] === 'OR') {
      at += 1;
      const left = test;
      const right = both();
      test = (row) => left(row) || right(row);
    }
    return test;
  };
  const both = (): Test => {
    let test = one();
    while (tokens[at] === '&&' || tokens[at] === 'AND') {
      at += 1;
      const left = test;
      const right = one();
      test = (row) => left(row) && right(row);
    }
    return test;
  };
  const one = (): Test => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = either();
      if (tokens[at++] !== ')') throw new XeroApiError(400, `Can't read the where filter: ${text}`);
      return inner;
    }
    const parts = token ? /^([A-Za-z.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(token) : null;
    if (!parts) throw new XeroApiError(400, `Can't read the where filter: ${text}`);
    const [, field, op, raw] = parts as unknown as [string, string, string, string];
    const date = /^DateTime\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(raw);
    const wanted = date ? `${date[1]}-${date[2]!.padStart(2, '0')}-${date[3]!.padStart(2, '0')}` : raw.replace(/^"|"$/g, '');
    return (row) => {
      const value = field.split('.').reduce<unknown>((v, key) => (v as Row | undefined)?.[key], row);
      const got = date ? dayOf(value) : String(value);
      if (got === null) return false;
      switch (op) {
        case '==': return got === wanted;
        case '!=': return got !== wanted;
        case '>=': return got >= wanted;
        case '<=': return got <= wanted;
        case '>': return got > wanted;
        default: return got < wanted;
      }
    };
  };
  const test = either();
  if (at !== tokens.length) throw new XeroApiError(400, `Can't read the where filter: ${text}`);
  return test;
}

/** A /Date(ms+0000)/ or ISO date as YYYY-MM-DD. */
function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ticks = /^\/Date\((-?\d+)/.exec(value);
  if (ticks) return new Date(Number(ticks[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** A day as Xero writes it in JSON. */
export const xeroDate = (day: string) => `/Date(${Date.parse(`${day}T00:00:00Z`)}+0000)/`;
