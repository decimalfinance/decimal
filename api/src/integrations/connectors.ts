// What the harness needs from each system, and nothing else: is it signed in, a
// reader, and the one write a person's yes can make. Adding a system means an
// entry here, a reader, and a playbook. The loop, the record and the gates stay.

import { enablePosting, getConnection } from '../accounting/connections.js';
import type { BooksReader } from './books.js';
import { readerForOrganization } from './quickbooks-reader.js';

export type BooksConnection = {
  companyId: string;
  /** connected, needs_reauth or disconnected. */
  status: string;
};

export type Connector = {
  system: string;
  connection(organizationId: string): Promise<BooksConnection | null>;
  reader(organizationId: string): Promise<BooksReader | null>;
  /** The request a sign-in button makes. Built here, so the model never holds a link. */
  signInPath(organizationId: string): string;
  /** The person's yes. Null when there is no live connection to say yes to. */
  enablePosting(organizationId: string, userId: string): Promise<Date | null>;
};

const CONNECTORS: Record<string, Connector> = {
  quickbooks: {
    system: 'quickbooks',
    connection: async (organizationId) => {
      const row = await getConnection(organizationId);
      return row ? { companyId: row.realmId, status: row.status } : null;
    },
    reader: readerForOrganization,
    signInPath: (organizationId) => `/organizations/${organizationId}/accounting/quickbooks/connect`,
    enablePosting,
  },
};

let overrides: Record<string, Partial<Connector>> = {};

/** A pretend system for tests and evals: records from a fixture, no network. `null` restores the real ones. */
export function setConnectorForTests(system: string, connector: Partial<Connector> | null) {
  if (connector) overrides = { ...overrides, [system]: connector };
  else {
    const { [system]: _gone, ...rest } = overrides;
    overrides = rest;
  }
}

export function connectorFor(system: string): Connector {
  const connector = CONNECTORS[system];
  if (!connector) throw new Error(`No connector for ${system}`);
  return { ...connector, ...overrides[system] };
}
