// What the harness needs from each system, and nothing else: is it signed in, a
// reader, and the one write a person's yes can make. Adding a system means an
// entry here, a reader, and a playbook. The loop, the record and the gates stay.

import { enablePosting, getConnection } from '../accounting/connections.js';
import type { BooksReader } from './books.js';
import { readerForOrganization } from './quickbooks-reader.js';
import { xeroConnector } from './xero-connector.js';

export type BooksConnection = {
  companyId: string;
  /** connected, needs_reauth or disconnected. */
  status: string;
  /** When a person's yes turned posting on, kept while signed out; null while it is off. */
  postingSince?: Date | null;
};

export type Connector = {
  system: string;
  /**
   * Whether the person's yes turns posting on. Xero's doesn't: Decimal can't post
   * there yet, so its Go records the yes, and the setup is a rehearsal.
   */
  posts: boolean;
  /** Whether this deployment has the system at all. Xero is on the bench only. */
  available?: () => boolean;
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
    posts: true,
    connection: async (organizationId) => {
      const row = await getConnection(organizationId);
      return row ? { companyId: row.realmId, status: row.status, postingSince: row.postingEnabledAt } : null;
    },
    reader: readerForOrganization,
    signInPath: (organizationId) => `/organizations/${organizationId}/accounting/quickbooks/connect`,
    enablePosting,
  },
  xero: xeroConnector,
};

/** The systems a finished setup posts to. Coding and posting read only setups of these. */
export const postingSystems = () => Object.keys(CONNECTORS).filter((system) => connectorFor(system).posts);

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
