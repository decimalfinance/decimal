# Stablecoin Infra Dashboard, Auth, and UX Research

Date: March 29, 2026

## Executive takeaway

The current frontend is misframed because it behaves like an internal demo shell, not like a money-movement product.

Real stablecoin and treasury platforms do not open on a giant workspace title plus a pile of controls. They consistently do four things:

1. Put the user behind an authenticated organization or entity boundary.
2. Separate organizational setup from daily operations.
3. Use role-based access and approvals for sensitive actions.
4. Make the main post-login surface an operational home, not an onboarding form dump.

That means the right product direction is:

- `yes` to login now
- `yes` to organization/workspace separation
- `yes` to a staged onboarding flow
- `yes` to a proper operator home screen
- `no` to putting all setup forms on the first product screen

## What real stablecoin / treasury platforms do

### 1. They are organization-first, not anonymous dashboard-first

Institutional money products consistently organize access around an org or entity:

- Coinbase Prime uses a hierarchy of `organization -> entity -> portfolio`, with permissions scoped at the portfolio or entity level. Source: [Coinbase Prime account structure](https://docs.cdp.coinbase.com/prime/concepts/account-structure)
- Paxos distinguishes `Organization Administrator` and `Entity Manager`, and roles are scoped at the entity level. Source: [Paxos roles and responsibilities](https://docs.paxos.com/guides/dashboard/roles)
- Fireblocks uses a `workspace` as the central operating and policy boundary. Source: [Fireblocks key features and capabilities](https://developers.fireblocks.com/docs/capabilities)
- Modern Treasury’s dashboard is centered on the organization and uses roles, groups, approvals, and environment management. Sources: [Dashboard overview](https://docs.moderntreasury.com/platform/docs/dashboard-overview), [Roles and permissions](https://docs.moderntreasury.com/platform/docs/roles-and-permissions)

Implication for us:

- The product should open into an authenticated org/workspace context.
- A workspace is not just a UI filter. It is the security and data boundary.

### 2. They separate setup from operations

The common pattern is:

- onboarding / KYB / org setup first
- then user and role setup
- then API / webhook / credentials
- then daily operations

Examples:

- Paxos business accounts start with organization creation, business details, and entity onboarding, then let the org admin invite more users after the entity is active. Sources: [Create Business Account](https://docs.paxos.com/guides/dashboard/account), [Complete Onboarding](https://docs.sandbox.paxos.com/dashboard/onboard)
- Bridge says developers can use the dashboard to create customers, on-ramp/off-ramp flows, and generate API keys, but access comes after contract + KYB. Source: [Bridge Developer Dashboard](https://bridge-docs.readme.io/docs/developer-dashboard)
- Modern Treasury’s dashboard explicitly includes org admin, approvals, audit, integrations, request logs, and developer tools, which indicates setup/admin is a distinct concern from daily transaction review. Source: [Dashboard overview](https://docs.moderntreasury.com/platform/docs/dashboard-overview)

Implication for us:

- We should have a dedicated onboarding flow, not inline setup everywhere.
- The first-use experience should be a wizard.
- The day-to-day experience should be an operator home.

### 3. They always have roles, approvals, and auditability

This is one of the clearest patterns across the market.

Examples:

- Paxos ships explicit roles including `Entity Manager`, `Treasurer`, `Approver`, `Developer`, `Viewer`, and `Operations`. Source: [Paxos roles and responsibilities](https://docs.paxos.com/guides/dashboard/roles)
- Paxos approvals cover sensitive actions such as adding destination addresses, withdrawals, API credentials, webhooks, conversion instructions, and role changes. Source: [Paxos approvals](https://docs.paxos.com/dashboard/admin/approvals)
- Fireblocks exposes role-based access control, admin quorum, and approval groups for changes like whitelisting addresses, adding users, new exchange accounts, and policy changes. Sources: [Fireblocks capabilities](https://developers.fireblocks.com/docs/capabilities), [Define approval quorums](https://developers.fireblocks.com/docs/define-approval-quorums)
- Coinbase Prime uses entity-level and portfolio-level roles and requires combinations such as initiator/approver/team manager for safe operation. Source: [Coinbase Prime roles and permissions](https://help.coinbase.com/en/prime/roles-and-permissions/roles-and-permissions)
- Modern Treasury uses RBAC, approvals, SSO, MFA, IP allowlists, audit trail, and SIEM integration. Sources: [Roles and permissions](https://docs.moderntreasury.com/platform/docs/roles-and-permissions), [Dashboard overview](https://docs.moderntreasury.com/platform/docs/dashboard-overview), [SSO](https://docs.moderntreasury.com/platform/docs/single-sign-on-sso), [SIEM Integration](https://docs.moderntreasury.com/platform/docs/siem)

Implication for us:

- A stablecoin infra company without login becomes structurally wrong very quickly.
- Even if we start simple, we should establish:
  - authenticated users
  - organization/workspace membership
  - roles
  - audit trail

### 4. They include developer tools, but not as the first screen

Stablecoin infra products almost always blend ops and developer tooling:

- Circle exposes API key management and API logs in the developer dashboard. Sources: [Circle API keys](https://developers.circle.com/circle-mint/api-keys), [Circle API logs](https://developers.circle.com/circle-mint/api-logs)
- Bridge exposes dashboard access, customer creation, payment execution, and API key generation. Source: [Bridge Developer Dashboard](https://bridge-docs.readme.io/docs/developer-dashboard)
- Modern Treasury’s dashboard includes API key management, webhook configuration, and request logs. Source: [Dashboard overview](https://docs.moderntreasury.com/platform/docs/dashboard-overview)

Implication for us:

- “Developer” functionality belongs in the product, but not in the primary operational workspace.
- It should live under a dedicated `Developers` or `Integrations` section later.

## What this means for our product

## Decision 1: we should add login now

I think your instinct is correct.

Not because login is exciting, but because our product model is already multi-tenant:

- different customers have different watched addresses
- different labels
- different internal objects
- different event relevance

Without login, the product has no clean boundary between customers.

### Recommended auth shape for now

Do not overbuild enterprise auth in v1.

Use:

- email + passwordless magic link or email OTP for MVP
- organization membership in app
- one user creates an organization
- that user creates or joins workspaces

Then later add:

- SSO / SAML
- SCIM
- hardware/passkey support
- fine-grained org admin controls

Why this sequence:

- Paxos and Modern Treasury show that serious platforms end up with SSO / passkeys / identity-provider integration. Sources: [Paxos sign-in](https://docs.paxos.com/guides/dashboard/signin), [Paxos SSO setup](https://support.paxos.com/hc/en-us/articles/35127251691668-How-do-I-set-up-SSO-for-my-account), [Modern Treasury SSO](https://docs.moderntreasury.com/platform/docs/single-sign-on-sso), [Modern Treasury SCIM](https://docs.moderntreasury.com/platform/docs/user-lifecycle-management-with-scim)
- But for us right now, org + membership + role is enough.

### Recommended MVP roles

For our first version, keep roles simple:

- `owner`
  - full workspace and org control
- `operator`
  - can manage addresses, labels, objects, mappings, and view events
- `viewer`
  - read-only access to monitor, reconciliation, and graph

Do not build approvals yet.
Design the data model so approvals can be added later.

## Decision 2: the app needs two clearly different modes

The current UI is confusing because onboarding and operations are fighting for the same page.

Real products separate them.

### Correct product structure

#### Before workspace is usable

Show:

- org / workspace selection
- onboarding checklist
- one active setup step at a time
- progress toward readiness

Do not show:

- giant event feed area with nothing in it
- giant workspace hero
- multiple empty forms at once

#### After workspace is ready

Show:

- operations home / monitor
- event feed
- exceptions / failures / pending investigations
- reconciliation queue
- selected event detail

Secondary sections:

- graph management
- team & access
- developer tools
- settings

## Decision 3: the main page should be an operator home, not a workspace title

Your criticism of the current screen is correct.

The huge `Beta Ops` header is a bad allocation of space because it does not help someone operate the system.

The first usable screen after login should be something like:

### Option A: if workspace incomplete

`Workspace Setup`

Top section:

- workspace name
- readiness status
- progress checklist

Body:

- active setup task
- short explanation of why it matters
- completion CTA

Side rail or compact top summary:

- addresses count
- labels count
- objects count
- mappings count

### Option B: if workspace complete

`Operations Home`

Top section:

- active incidents or pending items
- last sync
- workspace health

Main area:

- recent events
- failed/ambiguous events
- reconciliation-needed rows
- selected event details

Secondary navigation:

- Graph
- Reconciliation
- Team
- Developers
- Settings

This is much closer to how ops dashboards in money movement systems behave.

## Decision 4: the sidebar should be reduced, not expanded

Your current sidebar is too heavy for the amount of information it carries.

The problem is not that it is a sidebar. The problem is the information architecture.

### Better nav model

Use a compact left rail:

- `Home`
- `Graph`
- `Reconciliation`
- `Team`
- `Developers`
- `Settings`

Above it:

- org / workspace switcher

Do not put explanatory paragraphs in the sidebar.
Those belong in the active view, near the thing they explain.

If you want the retro mono feel, the sidebar can still look sharp:

- black surface
- single-pixel borders
- high-contrast active state
- mono labels
- no bulky cards inside the nav

## Decision 5: the first UI should optimize for operator comprehension

The user told us the screen is confusing. That means the page is failing the most basic product test:

`Can a new operator understand what to do next in 5 seconds?`

Right now the answer is no.

The design principles should be:

- one dominant purpose per screen
- one dominant CTA per incomplete state
- operational copy, not atmospheric copy
- counts only when they help a decision
- no oversized dead space
- no empty panels unless they are the main purpose of the screen

## Recommended frontend information architecture

## Logged-out

Minimal login screen:

- product name
- one sentence
- email field
- continue button

No dashboard preview.
No giant marketing page.

## Logged-in / no org

Create organization:

- org name
- default workspace name
- continue

## Logged-in / org exists / workspace incomplete

Workspace setup view:

1. Add first watched address
2. Add first label
3. Add first business object
4. Attach label to address
5. Map address to object

Each step:

- why it matters
- one focused form
- previous data visible but secondary

## Logged-in / workspace complete

Operations home:

- event feed
- reconciliation queue
- selected event inspector
- filters

## Secondary screens

- `Graph`
  - full address / label / object / mapping management
- `Reconciliation`
  - exportable accounting-style rows
- `Team`
  - users, roles, invites
- `Developers`
  - API keys, webhooks, logs later
- `Settings`
  - workspace config

## Concrete recommendation for our next implementation pass

If we want this to feel like a real stablecoin infra product, I would do the next frontend pass in this order:

1. Add auth and org membership
2. Replace the first screen with a clean login
3. Add a workspace setup route
4. Add an operations-home route
5. Move graph editing into its own route
6. Simplify navigation

## Suggested route structure

- `/login`
- `/org/new`
- `/workspaces/:id/setup`
- `/workspaces/:id/home`
- `/workspaces/:id/graph`
- `/workspaces/:id/reconciliation`
- `/workspaces/:id/team`
- `/workspaces/:id/developers`
- `/workspaces/:id/settings`

## Recommended design language

Your preferred direction is actually a good fit for this product:

- dark background
- sharp edges
- mono typography
- restrained green/amber accents
- minimal chrome
- terminal / control-surface feel

But the theme only works if the layout is calm and obvious.

So the visual rules should be:

- no giant hero in the app shell
- no oversized workspace title blocks unless it is a setup page
- use dense but readable rows
- use borders and grid rhythm instead of large decorative blocks
- reserve bright accent color for state and actions only

## Final product recommendation

### Should we add login?

Yes.

For a stablecoin infra product, login is not optional for long.
Even early, it is the right structural move because:

- customers are distinct
- data is sensitive
- actions will become sensitive
- roles will matter
- auditability will matter

### Should the first product page be the dashboard?

No.

The first product page should be:

- login if unauthenticated
- setup if workspace incomplete
- ops home if workspace complete

### What is the biggest UX mistake right now?

Trying to make one screen serve:

- onboarding
- navigation
- workspace identity
- operations
- graph management

That needs to be split.

## My recommendation in one sentence

Turn this into an authenticated, organization-scoped product with a gated setup flow and a separate operations home, then redesign the chrome around that structure instead of trying to style the current composition into working.
